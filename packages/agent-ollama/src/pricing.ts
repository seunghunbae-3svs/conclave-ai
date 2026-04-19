/**
 * Ollama runs locally — compute cost is user-paid hardware time, not
 * metered tokens. From the efficiency gate's perspective, every call
 * is free at the wire level. Any real resource-accounting for local
 * inference is out of scope for v0.1; when we wire in wall-clock /
 * kWh estimates, this file grows.
 *
 * The exported helpers mirror the shape of the other agent pricing
 * modules so code that loops over pricing tables doesn't special-case
 * Ollama.
 */
export interface OllamaModelPricing {
  inputPerMTok: 0;
  outputPerMTok: 0;
  cachedInputPerMTok?: 0;
}

export const PRICING: Record<string, OllamaModelPricing> = {
  /** Generic default — Ollama has an open model catalog, users pull their own. */
  "llama3.3": { inputPerMTok: 0, outputPerMTok: 0 },
};

export interface UsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

/**
 * Always 0 for Ollama. Callers that want wall-clock billing should
 * layer it on top of the `MetricsRecorder.latency` field instead.
 */
export function actualCost(_model: string, _usage: UsageBreakdown): number {
  return 0;
}

export function estimateCallCost(
  _model: string,
  _estimatedInputTokens: number,
  _maxOutputTokens: number,
): number {
  return 0;
}
