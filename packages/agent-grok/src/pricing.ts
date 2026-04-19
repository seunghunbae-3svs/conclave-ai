export interface GrokModelPricing {
  /** USD per 1M input tokens. */
  inputPerMTok: number;
  /** USD per 1M output tokens. */
  outputPerMTok: number;
  /** USD per 1M cached-input tokens. xAI supports prompt caching on newer models. */
  cachedInputPerMTok?: number;
}

/**
 * xAI (Grok) pricing as of 2026-04. Numbers sourced from
 * https://docs.x.ai/docs/models — revisit each publish.
 *
 * `grok-code-fast-1` is the code-tuned, lower-cost tier (pairs well
 * with review-style workloads). `grok-4` is the reasoning flagship.
 * `grok-3-mini` is the cheapest option.
 */
export const PRICING: Record<string, GrokModelPricing> = {
  "grok-4": { inputPerMTok: 3.0, outputPerMTok: 15.0, cachedInputPerMTok: 0.75 },
  "grok-3": { inputPerMTok: 3.0, outputPerMTok: 15.0, cachedInputPerMTok: 0.75 },
  "grok-3-mini": { inputPerMTok: 0.3, outputPerMTok: 0.5, cachedInputPerMTok: 0.075 },
  "grok-code-fast-1": { inputPerMTok: 0.2, outputPerMTok: 1.5, cachedInputPerMTok: 0.02 },
};

export interface UsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

export function actualCost(model: string, usage: UsageBreakdown): number {
  const p = PRICING[model];
  if (!p) throw new Error(`pricing: unknown Grok model "${model}"`);
  const baseInput = usage.inputTokens - (usage.cachedInputTokens ?? 0);
  return (
    (Math.max(0, baseInput) * p.inputPerMTok +
      (usage.cachedInputTokens ?? 0) * (p.cachedInputPerMTok ?? p.inputPerMTok) +
      usage.outputTokens * p.outputPerMTok) /
    1_000_000
  );
}

export function estimateCallCost(
  model: string,
  estimatedInputTokens: number,
  maxOutputTokens: number,
): number {
  const p = PRICING[model];
  if (!p) throw new Error(`pricing: unknown Grok model "${model}"`);
  return (estimatedInputTokens * p.inputPerMTok + maxOutputTokens * p.outputPerMTok) / 1_000_000;
}
