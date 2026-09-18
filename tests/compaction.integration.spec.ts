/**
 * End-to-end compaction over a real session, log, and surface: the shipped
 * transaction must land a durable checkpoint, not merely be reached. Every unit
 * test above proves a decision; only this one proves the conversation survives it.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { LlmAdapter, createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'

import { AutoCompactEngine } from '../src/index.ts'

const PROVIDER = 'integration-provider'
const MODEL = 'integration-model'
const WINDOW = 1_000_000
/** Price per surface node, so pressure is a pure function of surface length. */
const NODE_TOKENS = 100
const TURNS = 4
const BUDGET = 500
const SUMMARY = 'condensed checkpoint'
/** The framed checkpoint only has to price below the span it replaces. */
const SUMMARY_TOKENS = 20
/** The shipped ratio trigger for {@link WINDOW}; the control run stays far below it. */
const RATIO_TRIGGER = Math.floor(WINDOW * 0.8)

/** Answers model metadata and yields one text summary for the shipped summarizer. */
class SummaryAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: WINDOW } })
  }

  override async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: SUMMARY }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: SUMMARY } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/**
 * Price the live surface rather than a fixture: the shipped transaction rejects a
 * measurement whose nodes do not match the session surface it is about to replace.
 */
function surfaceMeter() {
  return {
    measure(session: Session) {
      const nodes = session.surface.nodes.map(seq => ({ seq, tokens: NODE_TOKENS, heuristicTokens: NODE_TOKENS }))
      const totalTokens = nodes.length * NODE_TOKENS
      return {
        logRevision: 0,
        baseline: { kind: 'none', tokens: 0 },
        surfaceDeltaTokens: 0,
        totalTokens,
        surfaceTokens: totalTokens,
        nodes,
      }
    },
    estimateMessage: () => SUMMARY_TOKENS,
  }
}

/** Closed turns plus one open turn, mirroring a durable streamed conversation. */
function conversation(turns: number): Session {
  const session = Session.create(SessionId(`integration-${turns}`))
  for (let turn = 1; turn <= turns; turn += 1) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `turn ${turn} prompt` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) {
      session.append('request/header', {
        header: { config: { provider: PROVIDER, model: MODEL } },
        reason: 'initial',
      })
    }
    session.append('assistant/message', {
      stream: [],
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `turn ${turn} reply` }],
        source: { kind: 'model', ...{ provider: PROVIDER, model: MODEL } },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: turns + 1 })
  return session
}

/** One compaction attempt on its own realm; a second engine per context conflicts. */
async function attempt(budget: number | undefined) {
  const ctx = new Context()
  void new LlmRuntime(ctx)
  ctx.llm.registerAdapter([PROVIDER], new SummaryAdapter())
  ctx.provide('tokenMeter', surfaceMeter() as never)
  ctx.provide('sessions', { flush: async () => {} } as never)

  const session = conversation(TURNS)
  const before = session.surface.nodes.length
  const pressure = before * NODE_TOKENS
  const engine = new AutoCompactEngine(ctx, budget === undefined ? {} : { thresholdTokens: budget })
  const result = await engine.compactIfNeeded(
    { session, options: {} } as unknown as Agent,
    'pressure',
    new AbortController().signal,
  )
  return { result, session, before, pressure }
}

describe('absolute budget compaction, end to end', () => {
  it('condenses a conversation the shipped ratio policy leaves alone', async () => {
    const control = await attempt(undefined)
    assert.equal(control.result, null, 'the shipped ratio trigger is far above this pressure')
    assert.ok(control.pressure < RATIO_TRIGGER, 'the control must sit below the ratio trigger')

    const { result, session, before, pressure } = await attempt(BUDGET)
    assert.ok(pressure >= BUDGET, 'the run must start at or above the absolute budget')
    assert.ok(result !== null, 'the absolute budget must compact at this pressure')
    assert.ok(result.shadowedSeqs.length > 0, 'the checkpoint must shadow surface nodes')
    assert.ok(result.shadowedTokenCount > 0, 'the shadowed span must be priced')
    assert.ok(session.surface.nodes.length < before, 'the surface must shrink')
    assert.ok(
      JSON.stringify(result.summary).includes(SUMMARY),
      'the checkpoint must carry the summarized text',
    )
  })
})
