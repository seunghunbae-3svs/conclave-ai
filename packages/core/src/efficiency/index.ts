export { PromptCache, ANTHROPIC_PROMPT_CACHE_TTL_MS } from "./cache.js";
export type { CacheEntry, CacheOptions } from "./cache.js";

export { BudgetTracker, BudgetExceededError, DEFAULT_PER_PR_BUDGET_USD } from "./budget.js";
export type { BudgetOptions } from "./budget.js";

export { MetricsRecorder } from "./metrics.js";
export type { CallMetric, MetricsSummary, MetricsSink } from "./metrics.js";

export {
  triageReview,
  touchesRiskyPath,
  DEFAULT_RISKY_PATH_PATTERNS,
} from "./triage.js";
export type { TriagePath, TriageInput, TriageOptions, TriageOutcome } from "./triage.js";

export { selectModel, estimateTokens, DEFAULT_MODELS } from "./router.js";
export type { ModelClass, ModelChoice, RouterOptions } from "./router.js";

export { compact } from "./compact.js";
export type { CompactableMessage, CompactOptions, CompactResult } from "./compact.js";

export { buildRelevanceContext, inferTestPath } from "./relevance.js";
export type { RelevanceChunk, RelevanceInput, RelevanceOptions } from "./relevance.js";

export { EfficiencyGate } from "./gate.js";
export type {
  EfficiencyGateOptions,
  GateCallInput,
  GateCallOutcome,
  GateExecuteFn,
} from "./gate.js";
