/**
 * Engine plumbing tests: the derived-policy receiver must not depend on state
 * the shipped engine shares between routes, and the fast paths must never cost
 * an extra capacity lookup.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-token-meter'

import { AutoCompactEngine } from '../src/index.ts'
import { decidePressurePolicy } from '../src/policy.ts'
import { withDerivedPolicy } from '../src/view.ts'

const PROVIDER = 'stub-provider'
const MODEL = 'stub-model'
const MEGA_WINDOW = 1_000_000
const CAP_200K = 200_000
const RATIO_0_8 = 0.8
const SHARE_0_2 = 0.2

interface StubCounts {
  measure: number
  model: number
}

/** Minimal services the shipped engine injects, plus call counting. */
function stubContext(contextWindow: number | undefined, totalTokens: number, surfaceNodes: readonly unknown[] = []) {
  const ctx = new Context()
  const counts: StubCounts = { measure: 0, model: 0 }
  ctx.provide('llm', {
    async resolveModelInfo() {
      counts.model += 1
      return {
        id: MODEL,
        provider: PROVIDER,
        name: MODEL,
        ...contextWindow === undefined ? {} : { context: { contextWindow } },
      }
    },
  } as never)
  ctx.provide('tokenMeter', {
    measure() {
      counts.measure += 1
      return {
        logRevision: 0,
        baseline: { kind: 'none', tokens: 0 },
        surfaceDeltaTokens: 0,
        totalTokens,
        surfaceTokens: 0,
        nodes: surfaceNodes,
      }
    },
  } as never)
  ctx.provide('sessions', { flush: async () => {} } as never)
  return { ctx, counts }
}

/** Agent stub carrying only the durable route the shipped engine reads first. */
function stubAgent(): Agent {
  return {
    session: { requestHeader: () => ({ config: { provider: PROVIDER, model: MODEL } }) },
  } as unknown as Agent
}

/** Observe whether a call returns null, returns a result, or fails after the decision. */
async function outcome(call: Promise<unknown>): Promise<'null' | 'value' | 'error'> {
  return call.then(
    value => (value === null ? 'null' : 'value'),
    () => 'error',
  )
}

describe('AutoCompactEngine', () => {
  it('loads a configuration that carries the plugin-only fields', () => {
    const { ctx } = stubContext(MEGA_WINDOW, 0)
    const engine = new AutoCompactEngine(ctx, {
      thresholdTokens: CAP_200K,
      retainShare: SHARE_0_2,
      modelPolicies: [{ provider: PROVIDER, model: MODEL, thresholdTokens: 50_000 }],
    })
    assert.equal(engine.config.thresholdRatio, RATIO_0_8)
    assert.equal(engine.config.modelPolicies.length, 1)
    assert.ok(ctx.compaction, 'the engine must occupy the compaction service slot')
    assert.throws(
      () => new AutoCompactEngine(ctx, {}),
      /has been registered/,
      'a second engine in the same realm must conflict',
    )
  })

  it('keeps the resolved policy as a writable own field so a derived view can shadow it', () => {
    const { ctx } = stubContext(MEGA_WINDOW, 0)
    const engine = new AutoCompactEngine(ctx, { thresholdTokens: CAP_200K })
    const descriptor = Object.getOwnPropertyDescriptor(engine, 'config')
    assert.equal(descriptor?.writable, true, 'the derived-policy receiver needs a shadowable config field')
    assert.equal(Object.isFrozen(engine.config), true)
  })

  it('runs the shipped transaction under the derived policy without touching the engine', () => {
    const { ctx } = stubContext(MEGA_WINDOW, CAP_200K)
    const engine = new AutoCompactEngine(ctx, { thresholdTokens: CAP_200K })
    const derived = decidePressurePolicy({
      totalTokens: CAP_200K,
      contextWindow: MEGA_WINDOW,
      thresholdTokens: CAP_200K,
      thresholdRatio: RATIO_0_8,
      retainTokens: 160_000,
      retainShare: SHARE_0_2,
    })
    assert.ok(derived !== undefined)
    const policy = { ...engine.config, thresholdRatio: derived.thresholdRatio, retainTokens: derived.retainTokens, retainRatio: undefined, modelPolicies: [] }
    let seen: unknown
    return withDerivedPolicy(engine, policy, async view => {
      seen = view.config
      // The receiver must share the engine's context and private state.
      assert.equal((view as unknown as { ctx: unknown }).ctx, (engine as unknown as { ctx: unknown }).ctx)
      return null
    }).then(() => {
      assert.equal(seen, policy)
      assert.equal(engine.config.thresholdRatio, RATIO_0_8)
      assert.equal(engine.config.modelPolicies.length, 0)
      assert.equal(engine.config.retainTokens, undefined)
    })
  })

  it('delegates to the shipped engine unchanged without an absolute budget', async () => {
    const { ctx, counts } = stubContext(MEGA_WINDOW, CAP_200K)
    const engine = new AutoCompactEngine(ctx, {})
    await outcome(engine.compactIfNeeded(stubAgent(), 'pressure', AbortSignal.timeout(1_000)))
    assert.deepEqual(counts, { measure: 1, model: 1 })
  })

  it('skips the capacity lookup while pressure is below the budget', async () => {
    const { ctx, counts } = stubContext(MEGA_WINDOW, CAP_200K - 1)
    const engine = new AutoCompactEngine(ctx, { thresholdTokens: CAP_200K })
    await outcome(engine.compactIfNeeded(stubAgent(), 'pressure', AbortSignal.timeout(1_000)))
    // Pressure below the budget costs no capacity lookup: only the shipped pass
    // resolves the window, and the shipped ratio check then short-circuits.
    assert.deepEqual(counts, { measure: 2, model: 1 })
  })

  it('prices the request against the derived budget once pressure reaches it', async () => {
    // A surface node the stub session cannot satisfy makes the shipped range
    // selection fail, which is observable only when the decision passes the
    // shipped ratio check. On this window that check alone would stop at 800K.
    const node = { seq: 1, tokens: 500, heuristicTokens: 500 }
    const shipped = stubContext(MEGA_WINDOW, CAP_200K, [node])
    const control = new AutoCompactEngine(shipped.ctx, {})
    assert.equal(await outcome(control.compactIfNeeded(stubAgent(), 'pressure', AbortSignal.timeout(1_000))), 'null')

    const derivedRun = stubContext(MEGA_WINDOW, CAP_200K, [node])
    const engine = new AutoCompactEngine(derivedRun.ctx, { thresholdTokens: CAP_200K })
    assert.equal(await outcome(engine.compactIfNeeded(stubAgent(), 'pressure', AbortSignal.timeout(1_000))), 'error')
    assert.deepEqual(derivedRun.counts, { measure: 2, model: 2 })
  })

  it('never derives a policy for overflow recovery', async () => {
    const { ctx, counts } = stubContext(MEGA_WINDOW, CAP_200K)
    const engine = new AutoCompactEngine(ctx, { thresholdTokens: CAP_200K })
    await outcome(engine.compactIfNeeded(stubAgent(), 'context-overflow', AbortSignal.timeout(1_000)))
    // Overflow bypasses capacity resolution entirely in the shipped engine.
    assert.deepEqual(counts, { measure: 1, model: 0 })
  })
})
