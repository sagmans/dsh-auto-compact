/**
 * Decision-table tests for the absolute budget: the whole trigger surface is a
 * pure function, so every boundary is pinned here.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { decidePressurePolicy, routePolicyTerms } from '../src/policy.ts'

const MEGA_WINDOW = 1_000_000
const MID_WINDOW = 262_144
const SMALL_WINDOW = 131_072
const CAP_200K = 200_000
const RATIO_0_8 = 0.8
const SHARE_0_2 = 0.2
const STOCK_RETAIN_RATIO = 0.16

function decide(overrides: Partial<Parameters<typeof decidePressurePolicy>[0]> = {}) {
  return decidePressurePolicy({
    totalTokens: CAP_200K,
    contextWindow: MEGA_WINDOW,
    thresholdTokens: CAP_200K,
    thresholdRatio: RATIO_0_8,
    retainTokens: Math.floor(MEGA_WINDOW * STOCK_RETAIN_RATIO),
    retainShare: SHARE_0_2,
    ...overrides,
  })
}

describe('decidePressurePolicy', () => {
  it('derives the absolute budget on a window whose ratio trigger is far above it', () => {
    const derived = decide()
    assert.deepEqual(derived, {
      thresholdTokens: CAP_200K,
      thresholdRatio: CAP_200K / MEGA_WINDOW,
      retainTokens: Math.floor(CAP_200K * SHARE_0_2),
    })
  })

  it('keeps the ratio trigger when the window is already smaller than the budget', () => {
    assert.equal(decide({ contextWindow: SMALL_WINDOW }), undefined)
  })

  it('keeps the ratio trigger when the budget equals it', () => {
    const window = 250_000
    assert.equal(Math.floor(window * RATIO_0_8), CAP_200K)
    assert.equal(decide({ contextWindow: window }), undefined)
  })

  it('does not interfere below the budget', () => {
    assert.equal(decide({ totalTokens: CAP_200K - 1 }), undefined)
  })

  it('does not interfere without an absolute budget', () => {
    assert.equal(decide({ thresholdTokens: undefined }), undefined)
  })

  it('does not interfere when the adapter reports no capacity', () => {
    assert.equal(decide({ contextWindow: undefined }), undefined)
  })

  it('applies a route override budget instead of the deployment default', () => {
    const derived = decide({ thresholdTokens: 50_000, totalTokens: 50_000 })
    assert.equal(derived?.thresholdTokens, 50_000)
  })

  it('bounds the tail by the share of the derived trigger', () => {
    assert.equal(decide()?.retainTokens, 40_000)
  })

  it('preserves an explicitly smaller tail', () => {
    assert.equal(decide({ retainTokens: 4_096 })?.retainTokens, 4_096)
  })

  it('never retains up to the trigger', () => {
    const derived = decide({ retainShare: 1, retainTokens: CAP_200K })
    assert.equal(derived?.retainTokens, CAP_200K - 1)
  })

  it('allows an empty tail for a zero share', () => {
    assert.equal(decide({ retainShare: 0.0001, retainTokens: 10_000 })?.retainTokens, 20)
  })

  it('scales on a mid-size window whose ratio trigger is still wider', () => {
    const derived = decide({ contextWindow: MID_WINDOW, retainTokens: 41_943 })
    assert.equal(derived?.thresholdTokens, CAP_200K)
    assert.equal(Math.floor(MID_WINDOW * RATIO_0_8), 209_715)
    assert.equal(derived?.retainTokens, 40_000)
  })
})

describe('routePolicyTerms', () => {
  const base = { thresholdRatio: RATIO_0_8, retainRatio: STOCK_RETAIN_RATIO, retainTokens: undefined }

  it('inherits the deployment ratio and scaled tail', () => {
    assert.deepEqual(routePolicyTerms(base, undefined, MID_WINDOW), {
      thresholdRatio: RATIO_0_8,
      retainTokens: Math.floor(MID_WINDOW * STOCK_RETAIN_RATIO),
    })
  })

  it('lets an exact override replace the ratio', () => {
    assert.equal(routePolicyTerms(base, { thresholdRatio: 0.7 }, MID_WINDOW).thresholdRatio, 0.7)
  })

  it('lets an exact override replace the tail by ratio', () => {
    assert.equal(routePolicyTerms(base, { retainRatio: 0.05 }, MID_WINDOW).retainTokens, Math.floor(MID_WINDOW * 0.05))
  })

  it('lets an exact override replace the tail by absolute budget', () => {
    assert.equal(routePolicyTerms(base, { retainTokens: 2_048 }, MID_WINDOW).retainTokens, 2_048)
  })

  it('prefers an absolute deployment tail over the deployment ratio', () => {
    const absolute = { thresholdRatio: RATIO_0_8, retainRatio: undefined, retainTokens: 1_024 }
    assert.equal(routePolicyTerms(absolute, undefined, MID_WINDOW).retainTokens, 1_024)
  })

  it('prefers an override ratio over an absolute deployment tail', () => {
    const absolute = { thresholdRatio: RATIO_0_8, retainRatio: undefined, retainTokens: 1_024 }
    assert.equal(routePolicyTerms(absolute, { retainRatio: 0.1 }, MID_WINDOW).retainTokens, Math.floor(MID_WINDOW * 0.1))
  })

  it('rejects a policy that resolves no retention form', () => {
    assert.throws(
      () => routePolicyTerms({ thresholdRatio: RATIO_0_8 }, undefined, MID_WINDOW),
      /no retention form/,
    )
  })
})
