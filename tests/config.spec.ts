/**
 * Schema-conformance and stripping tests: the plugin must accept every shipped
 * field and hand the shipped engine a config it can resolve.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'

import { Config, DEFAULT_RETAIN_SHARE, resolveCapPolicy, routeKey, toEngineConfig } from '../src/config.ts'

const stockConfigDict = BasicCompactionEngine.Config.dict ?? {}
const stockRouteDict = stockConfigDict.modelPolicies?.inner?.dict ?? {}
const pluginConfigDict = Config.dict ?? {}
const pluginRouteDict = pluginConfigDict.modelPolicies?.inner?.dict ?? {}

describe('Config schema', () => {
  it('accepts every shipped top-level field', () => {
    for (const key of Object.keys(stockConfigDict)) {
      assert.ok(key in pluginConfigDict, `missing shipped config field ${key}`)
    }
  })

  it('accepts every shipped route-override field', () => {
    for (const key of Object.keys(stockRouteDict)) {
      assert.ok(key in pluginRouteDict, `missing shipped route field ${key}`)
    }
  })

  it('adds the absolute budget at both levels', () => {
    assert.ok('thresholdTokens' in pluginConfigDict)
    assert.ok('thresholdTokens' in pluginRouteDict)
    assert.ok('retainShare' in pluginConfigDict)
  })

  it('normalizes a valid configuration', () => {
    const normalized = Config({
      thresholdTokens: 200000,
      retainShare: 0.2,
      thresholdRatio: 0.8,
      modelPolicies: [{ provider: 'p', model: 'm', thresholdTokens: 50000 }],
    })
    assert.equal(normalized.thresholdTokens, 200000)
    assert.equal(normalized.modelPolicies?.[0]?.thresholdTokens, 50000)
  })

  it('rejects a non-positive or fractional budget', () => {
    assert.throws(() => Config({ thresholdTokens: 0 }))
    assert.throws(() => Config({ thresholdTokens: 1.5 }))
  })

  it('rejects a tail share outside the accepted range at validation', () => {
    assert.throws(() => Config({ retainShare: -0.1 }))
    assert.throws(() => Config({ retainShare: 1.5 }))
  })
})

describe('toEngineConfig', () => {
  it('removes the plugin-only fields at both levels', () => {
    const engineConfig = toEngineConfig({
      thresholdTokens: 200000,
      retainShare: 0.3,
      maxTokens: 4096,
      modelPolicies: [{ provider: 'p', model: 'm', thresholdTokens: 50000, thresholdRatio: 0.7 }],
    })
    assert.deepEqual(engineConfig, {
      maxTokens: 4096,
      modelPolicies: [{ provider: 'p', model: 'm', thresholdRatio: 0.7 }],
    })
  })

  it('leaves a config without additions untouched', () => {
    const engineConfig = toEngineConfig({ thresholdRatio: 0.8, auto: false })
    assert.deepEqual(engineConfig, { thresholdRatio: 0.8, auto: false })
  })

  it('produces a config the shipped resolver accepts', () => {
    // Constructing the engine runs the shipped resolveConfig, which rejects
    // unknown keys; a leftover plugin-only field would throw here.
    const config = toEngineConfig({
      thresholdTokens: 200000,
      retainShare: 0.2,
      modelPolicies: [{ provider: 'p', model: 'm', thresholdTokens: 1 }],
    })
    assert.deepEqual(Object.keys(config).sort(), ['modelPolicies'])
    assert.equal(config.modelPolicies?.length, 1)
  })
})

describe('resolveCapPolicy', () => {
  it('resolves the default, the exact overrides, and the shipped tail share', () => {
    const policy = resolveCapPolicy({
      thresholdTokens: 200000,
      modelPolicies: [
        { provider: 'p', model: 'm', thresholdTokens: 50000 },
        { provider: 'p', model: 'other' },
      ],
    })
    assert.equal(policy.defaultCap, 200000)
    assert.equal(policy.retainShare, DEFAULT_RETAIN_SHARE)
    assert.equal(policy.routeCaps.get(routeKey('p', 'm')), 50000)
    assert.equal(policy.routeCaps.has(routeKey('p', 'other')), false)
  })

  it('rejects an invalid budget', () => {
    assert.throws(() => resolveCapPolicy({ thresholdTokens: 0 }), /positive integer/)
    assert.throws(() => resolveCapPolicy({ thresholdTokens: 1.5 }), /positive integer/)
    assert.throws(() => resolveCapPolicy({ modelPolicies: [{ provider: 'p', model: 'm', thresholdTokens: -1 }] }), /positive integer/)
  })

  it('rejects an out-of-range tail share', () => {
    assert.throws(() => resolveCapPolicy({ retainShare: 0 }), /retainShare/)
    assert.throws(() => resolveCapPolicy({ retainShare: 1.5 }), /retainShare/)
  })
})
