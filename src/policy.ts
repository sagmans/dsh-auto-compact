/**
 * Pure decision logic for the absolute compaction budget: no cordis, no I/O.
 * @module @sagmans/dsh-auto-compact/policy
 */

/** Ratio and retention the shipped engine resolves for one exact route. */
export interface RoutePolicyTerms {
  /** Pressure fraction of the model window. */
  readonly thresholdRatio: number
  /** Retained-tail budget in tokens for this route. */
  readonly retainTokens: number
}

/** Shipped policy fields a route merge reads, with retention unresolved. */
export interface PolicyTermsSource {
  readonly thresholdRatio: number
  readonly retainRatio?: number
  readonly retainTokens?: number
}

/** Route override fields, with retention unresolved. */
export interface PolicyTermsOverride {
  readonly thresholdRatio?: number
  readonly retainRatio?: number
  readonly retainTokens?: number
}

/**
 * Resolve the shipped per-route ratio and retained tail in tokens.
 *
 * This transcribes the shipped merge — an exact override wins field by field,
 * retention resolves to exactly one form, and a ratio retention scales with the
 * routed model's capacity — so pricing stays identical when no absolute budget
 * applies.
 *
 * @param base - the shipped engine's resolved deployment policy.
 * @param override - the exact route override, when one matches.
 * @param contextWindow - adapter-owned capacity for the routed model.
 * @returns the shipped terms for this route.
 */
export function routePolicyTerms(
  base: PolicyTermsSource,
  override: PolicyTermsOverride | undefined,
  contextWindow: number,
): RoutePolicyTerms {
  const thresholdRatio = override?.thresholdRatio ?? base.thresholdRatio
  let retainTokens: number
  if (override?.retainTokens !== undefined) {
    retainTokens = override.retainTokens
  } else if (override?.retainRatio !== undefined) {
    retainTokens = Math.floor(contextWindow * override.retainRatio)
  } else if (base.retainTokens !== undefined) {
    retainTokens = base.retainTokens
  } else if (base.retainRatio !== undefined) {
    retainTokens = Math.floor(contextWindow * base.retainRatio)
  } else {
    throw new Error('auto-compact: resolved policy carries no retention form')
  }
  return { thresholdRatio, retainTokens }
}

/** One routed model's derived absolute-budget policy. */
export interface DerivedPressurePolicy {
  /** Concrete trigger budget in tokens. */
  readonly thresholdTokens: number
  /** The same budget expressed as the fraction the shipped engine scales. */
  readonly thresholdRatio: number
  /** Retained-tail budget in tokens, always below the trigger. */
  readonly retainTokens: number
}

/** Inputs of one pressure decision. */
export interface PressureDecisionInput {
  /** Measured request-and-response pressure for the session. */
  readonly totalTokens: number
  /** Adapter-owned capacity for the routed model, when the adapter reports one. */
  readonly contextWindow: number | undefined
  /** Absolute budget configured for the routed model, when any. */
  readonly thresholdTokens: number | undefined
  /** Shipped ratio trigger for the routed model. */
  readonly thresholdRatio: number
  /** Shipped retained-tail budget in tokens for the routed model. */
  readonly retainTokens: number
  /** Tail share of the derived threshold. */
  readonly retainShare: number
}

/**
 * Decide whether the absolute budget, rather than the shipped ratio, is what
 * should trigger compaction for this request.
 *
 * @param input - measured pressure plus the routed model's resolved budgets.
 * @returns the derived policy, or `undefined` when the shipped path must decide
 * alone (no budget configured, no reported capacity, or a ratio trigger that is
 * already at least as tight).
 */
export function decidePressurePolicy(input: PressureDecisionInput): DerivedPressurePolicy | undefined {
  const cap = input.thresholdTokens
  // The derived trigger can never exceed the absolute budget, so below the
  // budget there is nothing to decide and no capacity is needed.
  if (cap === undefined || input.totalTokens < cap) return undefined
  const window = input.contextWindow
  if (window === undefined) return undefined
  const ratioThreshold = Math.floor(window * input.thresholdRatio)
  if (cap >= ratioThreshold) return undefined
  // A model-free prune can land before summarization; the tail is bounded by
  // the derived trigger so a later step always has history left to condense.
  const boundedTail = Math.min(
    input.retainTokens,
    Math.floor(cap * input.retainShare),
    // The shipped capacity scaling rejects a tail that reaches the trigger.
    cap - 1,
  )
  return {
    thresholdTokens: cap,
    thresholdRatio: cap / window,
    retainTokens: Math.max(0, boundedTail),
  }
}
