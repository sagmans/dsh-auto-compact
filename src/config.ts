/**
 * Configuration vocabulary and load-time resolution for the absolute compaction
 * budget.
 * @module @sagmans/dsh-auto-compact/config
 */

import Schema from '@deepseek-ai/schemastery'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type {
  BasicCompactionConfig,
  ModelCompactPolicyConfig,
} from '@deepseek-ai/dsh-compaction-basic'

/** Tail share of the derived threshold used when no explicit share is configured. */
export const DEFAULT_RETAIN_SHARE = 0.2

/** Absolute pressure budget override carried by one exact provider/model route. */
export interface AbsoluteRoutePolicy extends ModelCompactPolicyConfig {
  /** Absolute trigger budget for this route, in tokens. */
  thresholdTokens?: number
}

/**
 * Plugin configuration: the shipped policy surface plus the absolute trigger.
 * Every shipped field keeps its shipped meaning; only the two additions below
 * are interpreted here.
 */
export interface AutoCompactConfig extends Omit<BasicCompactionConfig, 'modelPolicies'> {
  /**
   * Absolute pressure budget in tokens. Compaction starts at
   * `min(thresholdTokens, floor(contextWindow x thresholdRatio))`, so a model
   * whose window is already smaller than this budget keeps its ratio trigger.
   * Omitted means the shipped ratio policy alone.
   */
  thresholdTokens?: number
  /**
   * Retained tail as a fraction of the derived threshold, applied only when the
   * absolute budget is what triggers compaction. Omitted uses
   * {@link DEFAULT_RETAIN_SHARE}, which mirrors the shipped 0.16/0.8 tail-to-
   * threshold proportion.
   */
  retainShare?: number
  /** Exact provider/model overrides, extended with the absolute budget. */
  modelPolicies?: AbsoluteRoutePolicy[]
}

const thresholdTokensSchema = Schema.number().step(1).min(1)
// Bounds only; the open lower bound stays with resolvers, which reject a zero
// or negative share with a message naming the field.
const retainShareSchema = Schema.number().min(0).max(1)

/** Shipped schema dicts; composing from them keeps a new shipped field usable here. */
const stockConfigDict = BasicCompactionEngine.Config.dict ?? {}
const stockRouteDict = stockConfigDict.modelPolicies?.inner?.dict ?? {}

/** One exact route override: every shipped field plus the absolute budget. */
const routePolicySchema = Schema.object({
  ...stockRouteDict,
  thresholdTokens: thresholdTokensSchema,
})

/** Loader-validated plugin schema. */
export const Config: Schema<AutoCompactConfig> = Schema.object({
  ...stockConfigDict,
  thresholdTokens: thresholdTokensSchema,
  retainShare: retainShareSchema,
  modelPolicies: Schema.array(routePolicySchema),
}) as unknown as Schema<AutoCompactConfig>

/** Strip the plugin-only fields from one route override. */
function stockRoutePolicy(policy: AbsoluteRoutePolicy): ModelCompactPolicyConfig {
  const { thresholdTokens: _thresholdTokens, ...stock } = policy
  return stock
}

/**
 * Reduce this plugin's configuration to the shipped engine's own vocabulary.
 *
 * The shipped resolver rejects unknown keys at the top level and inside every
 * route override, so an absolute budget left in place would fail the plugin at
 * load instead of being ignored.
 *
 * @param config - validated plugin configuration.
 * @returns the configuration the shipped engine can resolve.
 */
export function toEngineConfig(config: AutoCompactConfig = {}): BasicCompactionConfig {
  const { thresholdTokens: _thresholdTokens, retainShare: _retainShare, modelPolicies, ...stock } = config
  if (modelPolicies === undefined) return stock
  return { ...stock, modelPolicies: modelPolicies.map(stockRoutePolicy) }
}

/** Validated absolute-budget policy for every route this deployment may serve. */
export interface CapPolicy {
  /** Budget applied to every route without an exact override. */
  readonly defaultCap: number | undefined
  /** Exact provider/model budgets, keyed by {@link routeKey}. */
  readonly routeCaps: ReadonlyMap<string, number>
  /** Retained-tail share of the derived threshold. */
  readonly retainShare: number
}

/** Key matching the shipped engine's exact provider/model route identity. */
export function routeKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`
}

function assertCap(name: string, value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} (${String(value)}) must be a positive integer`)
  }
  return value
}

function assertRetainShare(value: unknown): number {
  if (value === undefined) return DEFAULT_RETAIN_SHARE
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`retainShare (${String(value)}) must be a number in (0, 1]`)
  }
  return value
}

/**
 * Validate the deployment's absolute budgets.
 *
 * Duplicate route overrides are rejected by the shipped resolver, which sees
 * every override through {@link toEngineConfig}.
 *
 * @param config - plugin configuration, before or after schema normalization.
 * @returns detached budget lookups.
 */
export function resolveCapPolicy(config: AutoCompactConfig = {}): CapPolicy {
  const routeCaps = new Map<string, number>()
  for (const [index, policy] of (config.modelPolicies ?? []).entries()) {
    const cap = assertCap(`modelPolicies[${index}].thresholdTokens`, policy.thresholdTokens)
    if (cap !== undefined) routeCaps.set(routeKey(policy.provider, policy.model), cap)
  }
  return {
    defaultCap: assertCap('thresholdTokens', config.thresholdTokens),
    routeCaps,
    retainShare: assertRetainShare(config.retainShare),
  }
}
