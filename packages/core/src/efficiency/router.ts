export type ModelClass = "haiku" | "sonnet" | "opus" | "long-context";

export interface ModelChoice {
  /** Provider-specific model identifier. */
  model: string;
  /** Logical class for metrics grouping. */
  class: ModelClass;
  /** Reason text for logs / traces. */
  reason: string;
}

export interface RouterOptions {
  /** Upper bound (input tokens) for Haiku path. Default 8_000. */
  haikuMax?: number;
  /** Upper bound (input tokens) for Sonnet path. Default 50_000. */
  sonnetMax?: number;
  /** Override default model IDs if needed (e.g. preview releases). */
  models?: Partial<Record<ModelClass, string>>;
}

/**
 * Default model identifiers per 34-decision tech stack (2026-04-19):
 *   haiku   → fast triage, nightly episodic→catalog classification
 *   sonnet  → main reviewer workhorse (decision-core default)
 *   long    → Gemini 2.5 Pro for >50K input tokens (long-context slot)
 */
export const DEFAULT_MODELS: Record<ModelClass, string> = {
  haiku: "claude-haiku-4-5",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-7",
  "long-context": "gemini-2.5-pro",
};

/**
 * Route by input size. Output-size driven routing is intentionally excluded
 * for now — output tends to be bounded by the prompt structure, not a
 * separate routing axis.
 */
export function selectModel(
  inputTokenEstimate: number,
  opts: RouterOptions = {},
): ModelChoice {
  const haikuMax = opts.haikuMax ?? 8_000;
  const sonnetMax = opts.sonnetMax ?? 50_000;
  const models = { ...DEFAULT_MODELS, ...opts.models };

  if (inputTokenEstimate <= haikuMax) {
    return { model: models.haiku, class: "haiku", reason: `input ${inputTokenEstimate} ≤ ${haikuMax}` };
  }
  if (inputTokenEstimate <= sonnetMax) {
    return { model: models.sonnet, class: "sonnet", reason: `input ${inputTokenEstimate} ≤ ${sonnetMax}` };
  }
  return {
    model: models["long-context"],
    class: "long-context",
    reason: `input ${inputTokenEstimate} > ${sonnetMax}`,
  };
}

/** Rough input-size estimator. Real impl should use tiktoken / Anthropic tokenizer; this is a placeholder. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
