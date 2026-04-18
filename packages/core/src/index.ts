export type { Agent, ReviewContext, ReviewResult, Blocker, Severity } from "./agent.js";
export { Council } from "./council.js";
export { ReviewResultSchema, BlockerSchema } from "./schema.js";

// Efficiency Gate (decision #22: first-class from day 1) — every LLM call
// routes through `EfficiencyGate.run(...)`. Re-exported here for convenience;
// the dedicated subpath export lives at @ai-conclave/core/efficiency.
export {
  EfficiencyGate,
  PromptCache,
  BudgetTracker,
  BudgetExceededError,
  MetricsRecorder,
  selectModel,
  estimateTokens,
  triageReview,
  touchesRiskyPath,
  compact,
  buildRelevanceContext,
  DEFAULT_PER_PR_BUDGET_USD,
  DEFAULT_MODELS,
  ANTHROPIC_PROMPT_CACHE_TTL_MS,
} from "./efficiency/index.js";
export type {
  CallMetric,
  MetricsSummary,
  MetricsSink,
  TriagePath,
  TriageInput,
  TriageOutcome,
  ModelClass,
  ModelChoice,
  RouterOptions,
  CompactableMessage,
  CompactOptions,
  CompactResult,
  RelevanceChunk,
  RelevanceInput,
  RelevanceOptions,
  EfficiencyGateOptions,
  GateCallInput,
  GateCallOutcome,
  GateExecuteFn,
} from "./efficiency/index.js";
