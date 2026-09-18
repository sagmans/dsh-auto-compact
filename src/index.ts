/**
 * Absolute-budget compaction engine for the DeepSeek Harness.
 *
 * The shipped engine triggers on a fraction of the routed model's window. This
 * backend keeps that policy and adds an absolute token budget, so a deployment
 * can condense at a fixed price on large-window models while every smaller
 * window keeps its ratio trigger.
 * @module @sagmans/dsh-auto-compact
 */

import type { Context } from '@deepseek-ai/cordis'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction'
import type { Agent } from '@deepseek-ai/dsh-agent'
// Type-only: make the injected services this engine reads visible on Context.
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-token-meter'

import { Config, resolveCapPolicy, routeKey, toEngineConfig } from './config.ts'
import type { AutoCompactConfig, CapPolicy } from './config.ts'
import { decidePressurePolicy, routePolicyTerms } from './policy.ts'
import {
  derivedConfig,
  findOverride,
  resolveContextWindow,
  routedTarget,
  withDerivedPolicy,
} from './view.ts'

export { Config, DEFAULT_RETAIN_SHARE, resolveCapPolicy, routeKey, toEngineConfig } from './config.ts'
export type { AbsoluteRoutePolicy, AutoCompactConfig, CapPolicy } from './config.ts'
export { decidePressurePolicy, routePolicyTerms } from './policy.ts'
export type {
  DerivedPressurePolicy,
  PolicyTermsOverride,
  PolicyTermsSource,
  PressureDecisionInput,
  RoutePolicyTerms,
} from './policy.ts'

/**
 * Shipped compaction backend plus an absolute token budget.
 *
 * Every shipped setting keeps its meaning; `thresholdTokens` adds a cap on the
 * trigger, and `retainShare` bounds the retained tail whenever that cap is what
 * triggers compaction.
 */
export class AutoCompactEngine extends BasicCompactionEngine {
  static Config = Config

  static inject = [...BasicCompactionEngine.inject]

  /** Absolute-budget policy resolved at load. */
  private readonly capPolicy: CapPolicy

  /**
   * @param ctx - context owning the LLM, token meter, and session services.
   * @param config - plugin configuration; the shipped subset is forwarded as-is.
   */
  constructor(ctx: Context, config: AutoCompactConfig = {}) {
    super(ctx, toEngineConfig(config))
    this.capPolicy = resolveCapPolicy(config)
  }

  /**
   * Compact for step-boundary pressure or provider-confirmed overflow.
   *
   * Pressure runs under the derived absolute budget when one applies; every
   * other trigger, and every route the budget does not bind, delegates to the
   * shipped implementation unchanged.
   *
   * @param agent - agent whose latest durable routed request is measured.
   * @param trigger - pressure or context-overflow.
   * @param signal - live turn cancellation signal.
   * @returns the compaction result, or `null` when nothing was needed.
   */
  override async compactIfNeeded(
    agent: Agent,
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    const target = trigger === 'pressure' ? routedTarget(agent.session) : undefined
    const cap = target === undefined
      ? undefined
      : this.capPolicy.routeCaps.get(routeKey(target.provider, target.model))
        ?? this.capPolicy.defaultCap
    const measured = cap === undefined ? 0 : this.ctx.tokenMeter.measure(agent.session).totalTokens
    // The derived trigger never exceeds the budget, so below it there is nothing
    // to decide and no capacity lookup is worth making on every step.
    if (target === undefined || cap === undefined || measured < cap) {
      return super.compactIfNeeded(agent, trigger, signal)
    }

    // The shipped transaction resolves the same capacity again when it prices
    // the span. That second lookup is accepted: it runs only on steps that
    // already exceeded the budget, and the shipped signature exposes no seam to
    // hand a resolved window through.
    const contextWindow = await resolveContextWindow(this.ctx, target, signal)
    if (contextWindow === undefined) return super.compactIfNeeded(agent, trigger, signal)

    const override = findOverride(this.config.modelPolicies, target)
    const terms = routePolicyTerms(this.config, override, contextWindow)
    const derived = decidePressurePolicy({
      totalTokens: measured,
      contextWindow,
      thresholdTokens: cap,
      thresholdRatio: terms.thresholdRatio,
      retainTokens: terms.retainTokens,
      retainShare: this.capPolicy.retainShare,
    })
    if (derived === undefined) return super.compactIfNeeded(agent, trigger, signal)

    this.ctx.logger.debug(
      `auto-compact: ${target.provider}/${target.model} pressure ${measured}, `
      + `ratio trigger ${Math.floor(contextWindow * terms.thresholdRatio)} on window ${contextWindow}, `
      + `absolute budget ${cap} -> threshold ${derived.thresholdTokens}, tail ${derived.retainTokens}`,
    )

    const result = await withDerivedPolicy(
      this,
      derivedConfig(this.config, override, derived),
      view => BasicCompactionEngine.prototype.compactIfNeeded.call(view, agent, trigger, signal),
    )
    if (result !== null) {
      this.ctx.logger.info(
        `auto-compact: condensed at the absolute budget of ${derived.thresholdTokens} tokens `
        + `(window ${contextWindow}, tail ${derived.retainTokens})`,
      )
    }
    return result
  }
}

export default AutoCompactEngine
