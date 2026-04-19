export interface DeepseekModelPricing {
  /** USD per 1M input tokens (standard, non-cached). */
  inputPerMTok: number;
  /** USD per 1M output tokens. */
  outputPerMTok: number;
  /** USD per 1M cached-input tokens. Deepseek's cache hit price is much
   *  lower than standard input — reflected here. */
  cachedInputPerMTok?: number;
}

/**
 * Deepseek pricing as of 2026-04. Deepseek's API is OpenAI-compatible,
 * so the cost math mirrors `agent-openai/pricing.ts`. Numbers sourced
 * from https://api-docs.deepseek.com/quick_start/pricing — revisit
 * each publish.
 *
 * `deepseek-chat` is Deepseek-V3 (general).
 * `deepseek-reasoner` is Deepseek-R1 (chain-of-thought, higher output token count).
 */
export const PRICING: Record<string, DeepseekModelPricing> = {
  "deepseek-chat": { inputPerMTok: 0.27, outputPerMTok: 1.1, cachedInputPerMTok: 0.07 },
  "deepseek-reasoner": { inputPerMTok: 0.55, outputPerMTok: 2.19, cachedInputPerMTok: 0.14 },
};

export interface UsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

export function actualCost(model: string, usage: UsageBreakdown): number {
  const p = PRICING[model];
  if (!p) throw new Error(`pricing: unknown Deepseek model "${model}"`);
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
  if (!p) throw new Error(`pricing: unknown Deepseek model "${model}"`);
  return (estimatedInputTokens * p.inputPerMTok + maxOutputTokens * p.outputPerMTok) / 1_000_000;
}
