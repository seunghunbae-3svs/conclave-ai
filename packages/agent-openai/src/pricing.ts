export interface OpenAIModelPricing {
  /** USD per 1M input tokens. */
  inputPerMTok: number;
  /** USD per 1M output tokens. */
  outputPerMTok: number;
  /** USD per 1M cached-input tokens (OpenAI prompt-cache; ~50% discount on supported models). */
  cachedInputPerMTok?: number;
}

/**
 * Pricing table for OpenAI review-capable models. Numbers reflect
 * published OpenAI API pricing as of 2026-04; revisit at each publish.
 *
 * Unknown / unpublished: caching discounts on reasoning models vary and
 * are handled conservatively (no discount if cachedInputPerMTok absent).
 */
export const PRICING: Record<string, OpenAIModelPricing> = {
  "gpt-4.1": { inputPerMTok: 2.5, outputPerMTok: 10.0, cachedInputPerMTok: 1.25 },
  "gpt-4.1-mini": { inputPerMTok: 0.4, outputPerMTok: 1.6, cachedInputPerMTok: 0.2 },
  "gpt-5": { inputPerMTok: 5.0, outputPerMTok: 20.0, cachedInputPerMTok: 2.5 },
  "gpt-5-mini": { inputPerMTok: 0.5, outputPerMTok: 2.0, cachedInputPerMTok: 0.25 },
  // GPT-5.4 flagship (released 2026-03-05). Pricing placeholder matches
  // gpt-5 rates until OpenAI's public rate card is verified — budget
  // cap still enforces total spend so conservative placeholder is safe.
  "gpt-5.4": { inputPerMTok: 5.0, outputPerMTok: 20.0, cachedInputPerMTok: 2.5 },
  "o5": { inputPerMTok: 15.0, outputPerMTok: 60.0 },
};

export interface UsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

export function actualCost(model: string, usage: UsageBreakdown): number {
  const p = PRICING[model];
  if (!p) throw new Error(`pricing: unknown OpenAI model "${model}"`);
  const baseInput = usage.inputTokens - (usage.cachedInputTokens ?? 0);
  return (
    (Math.max(0, baseInput) * p.inputPerMTok +
      (usage.cachedInputTokens ?? 0) * (p.cachedInputPerMTok ?? p.inputPerMTok) +
      usage.outputTokens * p.outputPerMTok) /
    1_000_000
  );
}

export function estimateCallCost(model: string, estimatedInputTokens: number, maxOutputTokens: number): number {
  const p = PRICING[model];
  if (!p) throw new Error(`pricing: unknown OpenAI model "${model}"`);
  return (estimatedInputTokens * p.inputPerMTok + maxOutputTokens * p.outputPerMTok) / 1_000_000;
}
