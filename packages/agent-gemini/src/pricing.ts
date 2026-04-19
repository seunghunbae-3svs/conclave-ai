export interface GeminiModelPricing {
  /** USD per 1M input tokens. */
  inputPerMTok: number;
  /** USD per 1M output tokens. */
  outputPerMTok: number;
  /**
   * Context-cache rate per 1M tokens for the cached prefix. Gemini's
   * context cache bills separately from regular input. Undefined =
   * charge at `inputPerMTok` conservatively.
   */
  cachedInputPerMTok?: number;
  /** If published, max context window in tokens — useful for router long-context slot selection. */
  maxContextTokens?: number;
}

/**
 * Pricing for Gemini models used as the long-context slot per decision #10.
 * 2026-04 Google AI pricing; revisit on publish.
 *
 * Decision #10: "skip Deep Think (Ultra-tier overkill); use 2.5 Flash as triage".
 * Flash is a fallback for under-budget review on very small diffs; 2.5 Pro is
 * the canonical long-context slot (>50K input tokens per router default).
 */
export const PRICING: Record<string, GeminiModelPricing> = {
  "gemini-2.5-pro": {
    inputPerMTok: 1.25,
    outputPerMTok: 10.0,
    cachedInputPerMTok: 0.3125,
    maxContextTokens: 1_048_576,
  },
  "gemini-2.5-flash": {
    inputPerMTok: 0.15,
    outputPerMTok: 0.6,
    cachedInputPerMTok: 0.0375,
    maxContextTokens: 1_048_576,
  },
  "gemini-3.0-flash": {
    inputPerMTok: 0.2,
    outputPerMTok: 0.8,
    cachedInputPerMTok: 0.05,
    maxContextTokens: 2_097_152,
  },
};

export interface UsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

export function actualCost(model: string, usage: UsageBreakdown): number {
  const p = PRICING[model];
  if (!p) throw new Error(`pricing: unknown Gemini model "${model}"`);
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
  if (!p) throw new Error(`pricing: unknown Gemini model "${model}"`);
  return (estimatedInputTokens * p.inputPerMTok + maxOutputTokens * p.outputPerMTok) / 1_000_000;
}
