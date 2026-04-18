export interface ModelPricing {
  /** USD per 1M input tokens (non-cached). */
  inputPerMTok: number;
  /** USD per 1M cache-write input tokens. */
  cacheWritePerMTok: number;
  /** USD per 1M cache-read input tokens. */
  cacheReadPerMTok: number;
  /** USD per 1M output tokens. */
  outputPerMTok: number;
}

/**
 * Pricing table for Claude models. Prices reflect published Anthropic API
 * pricing as of 2026-04; update when Anthropic announces new tiers.
 *
 * Cache write = 1.25× base input, cache read = 0.1× base input (90% off).
 */
export const PRICING: Record<string, ModelPricing> = {
  "claude-sonnet-4-6": {
    inputPerMTok: 3.0,
    cacheWritePerMTok: 3.75,
    cacheReadPerMTok: 0.3,
    outputPerMTok: 15.0,
  },
  "claude-haiku-4-5": {
    inputPerMTok: 0.25,
    cacheWritePerMTok: 0.3125,
    cacheReadPerMTok: 0.025,
    outputPerMTok: 1.25,
  },
  "claude-opus-4-7": {
    inputPerMTok: 15.0,
    cacheWritePerMTok: 18.75,
    cacheReadPerMTok: 1.5,
    outputPerMTok: 75.0,
  },
};

export interface UsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
}

/** Compute actual USD cost from an Anthropic API usage breakdown. */
export function actualCost(model: string, usage: UsageBreakdown): number {
  const p = PRICING[model];
  if (!p) throw new Error(`pricing: unknown model "${model}"`);
  const baseInput = usage.inputTokens - (usage.cacheCreationTokens ?? 0) - (usage.cacheReadTokens ?? 0);
  return (
    (Math.max(0, baseInput) * p.inputPerMTok +
      (usage.cacheCreationTokens ?? 0) * p.cacheWritePerMTok +
      (usage.cacheReadTokens ?? 0) * p.cacheReadPerMTok +
      usage.outputTokens * p.outputPerMTok) /
    1_000_000
  );
}

/**
 * Pre-flight USD estimate for budget.reserve(). Pessimistic: assumes no
 * cache read (worst case) and a typical 25% output-to-input ratio.
 */
export function estimateCallCost(model: string, estimatedInputTokens: number, maxOutputTokens: number): number {
  const p = PRICING[model];
  if (!p) throw new Error(`pricing: unknown model "${model}"`);
  return (estimatedInputTokens * p.inputPerMTok + maxOutputTokens * p.outputPerMTok) / 1_000_000;
}
