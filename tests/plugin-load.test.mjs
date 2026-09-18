/**
 * Built-artifact test: the packed entry points must expose the engine, its
 * schema, and a mountable plugin without a TypeScript loader.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

const PACKAGE_NAME = '@sagmans/dsh-auto-compact'
const MEGA_WINDOW = 1_000_000
const CAP_200K = 200_000

test('built package exposes the engine, schema, and pure decision surface', async () => {
  const plugin = await import(PACKAGE_NAME)
  assert.equal(typeof plugin.default, 'function')
  assert.equal(plugin.default, plugin.AutoCompactEngine)
  assert.equal(typeof plugin.Config, 'function')
  assert.ok('thresholdTokens' in plugin.Config.dict)
  assert.ok('retainShare' in plugin.Config.dict)
  assert.ok('thresholdTokens' in plugin.Config.dict.modelPolicies.inner.dict)

  const derived = plugin.decidePressurePolicy({
    totalTokens: CAP_200K,
    contextWindow: MEGA_WINDOW,
    thresholdTokens: CAP_200K,
    thresholdRatio: 0.8,
    retainTokens: 160_000,
    retainShare: 0.2,
  })
  assert.equal(derived.thresholdTokens, CAP_200K)
  assert.equal(derived.retainTokens, 40_000)
})

test('built package mounts as the compaction service over stub dependencies', async () => {
  const plugin = await import(PACKAGE_NAME)
  const ctx = new Context()
  ctx.provide('llm', {
    async resolveModelInfo() {
      return { id: 'm', provider: 'p', name: 'm', context: { contextWindow: MEGA_WINDOW } }
    },
  })
  ctx.provide('tokenMeter', {
    measure() {
      return { logRevision: 0, baseline: { kind: 'none', tokens: 0 }, surfaceDeltaTokens: 0, totalTokens: 0, surfaceTokens: 0, nodes: [] }
    },
  })
  ctx.provide('sessions', { flush: async () => {} })

  const engine = new plugin.default(ctx, { thresholdTokens: CAP_200K, auto: false })
  assert.ok(ctx.compaction, 'the built engine must occupy the compaction service slot')
  assert.throws(() => new plugin.default(ctx, {}), /has been registered/)
  assert.equal(engine.config.auto, false)
  assert.equal(engine.config.thresholdRatio, 0.8)
})
