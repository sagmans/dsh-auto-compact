/**
 * Route resolution and the derived-policy receiver used to re-enter the shipped
 * compaction transaction.
 * @module @sagmans/dsh-auto-compact/view
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type {
  BasicCompactionEngine,
  ModelCompactPolicyConfig,
  ResolvedConfig,
} from '@deepseek-ai/dsh-compaction-basic'
import type { DerivedPressurePolicy } from './policy.ts'

/** Exact provider/model route of the latest durable request. */
export type RouteTarget = Pick<LlmCallConfig, 'provider' | 'model'>

/**
 * Read the route the shipped engine itself would price this session against.
 * @param session - session whose latest durable request header is inspected.
 * @returns the routed target, or `undefined` when no route is durable yet.
 */
export function routedTarget(session: Session): RouteTarget | undefined {
  const config = session.requestHeader()?.config
  if (config === undefined || config.provider.length === 0 || config.model.length === 0) return undefined
  return { provider: config.provider, model: config.model }
}

/**
 * Find the exact provider/model override the shipped merge would apply.
 * @param policies - the shipped engine's resolved override table.
 * @param target - routed target to match exactly.
 * @returns the matching override, or `undefined`.
 */
export function findOverride(
  policies: readonly Readonly<ModelCompactPolicyConfig>[],
  target: RouteTarget,
): Readonly<ModelCompactPolicyConfig> | undefined {
  return policies.find(policy => policy.provider === target.provider && policy.model === target.model)
}

/**
 * Read the routed model's adapter-owned capacity.
 * @param ctx - context owning the LLM runtime.
 * @param target - routed provider/model pair.
 * @param signal - cancellation signal forwarded to the adapter.
 * @returns the reported window, or `undefined` when the adapter declares none.
 */
export async function resolveContextWindow(
  ctx: Context,
  target: RouteTarget,
  signal: AbortSignal,
): Promise<number | undefined> {
  return (await ctx.llm.resolveModelInfo(target.provider, target.model, signal)).context?.contextWindow
}

/**
 * Build the complete policy the shipped transaction must run under.
 *
 * The route override is merged here and then cleared from the table: the
 * shipped merge would otherwise re-apply the ratio this derivation replaced.
 *
 * @param base - the shipped engine's resolved deployment policy.
 * @param override - the matching exact route override, when any.
 * @param derived - the derived absolute-budget policy.
 * @returns a complete, detached policy for one transaction.
 */
export function derivedConfig(
  base: ResolvedConfig,
  override: Readonly<ModelCompactPolicyConfig> | undefined,
  derived: DerivedPressurePolicy,
): ResolvedConfig {
  const { provider: _provider, model: _model, ...overrideFields } = override ?? {}
  return {
    ...base,
    ...overrideFields,
    thresholdRatio: derived.thresholdRatio,
    retainRatio: undefined,
    retainTokens: derived.retainTokens,
    modelPolicies: [],
  }
}

/**
 * Run one shipped compaction transaction under a derived policy.
 *
 * WHY a receiver instead of a field: the shipped engine resolves its policy
 * from the instance field `config`, which is deep-frozen at load and therefore
 * cannot be replaced. Swapping the field for the duration of the call would let
 * two agents compacting concurrently on different routes observe each other's
 * policy, so the derived value lives on a per-call receiver that shares the
 * engine's context, overrides, and private state through the prototype chain.
 *
 * @param engine - the live engine instance.
 * @param policy - the derived policy for this one transaction.
 * @param run - the shipped method to invoke on the receiver.
 * @returns the shipped method's result.
 */
export function withDerivedPolicy<T>(
  engine: BasicCompactionEngine,
  policy: ResolvedConfig,
  run: (view: BasicCompactionEngine) => Promise<T>,
): Promise<T> {
  const view = Object.create(engine) as BasicCompactionEngine
  Object.defineProperty(view, 'config', {
    value: policy,
    enumerable: false,
    writable: false,
    configurable: false,
  })
  return run(view)
}
