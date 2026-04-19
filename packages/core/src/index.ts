export type { Agent, ReviewContext, ReviewResult, Blocker, Severity } from "./agent.js";
export { Council } from "./council.js";
export type { CouncilOutcome } from "./council.js";
export { ReviewResultSchema, BlockerSchema } from "./schema.js";
export type { Notifier, NotifyReviewInput } from "./notifier.js";
export { resolveFirstPreview } from "./platform.js";
export type { Platform, PreviewResolution, ResolvePreviewInput } from "./platform.js";

// Memory substrate (decision #17: 정답지 + 오답지 duality as core primitive).
// Re-exported here for convenience; dedicated subpath at @ai-conclave/core/memory.
export {
  FileSystemMemoryStore,
  AnswerKeySchema,
  EpisodicEntrySchema,
  FailureEntrySchema,
  SemanticRuleSchema,
  formatAnswerKeyForPrompt,
  formatFailureForPrompt,
  OutcomeWriter,
  RuleBasedClassifier,
  newEpisodicId,
  seedFromLegacyCatalog,
  seedFromLegacyCatalogPath,
  toFailureEntry,
  mapLegacyCategory,
  LegacyCatalogSchema,
  retrieve,
} from "./memory/index.js";
export type {
  AnswerKey,
  EpisodicEntry,
  FailureEntry,
  SemanticRule,
  MemoryStore,
  MemoryReadQuery,
  MemoryRetrieval,
  FsStoreOptions,
  WriteReviewInput,
  RecordOutcomeInput,
  RecordOutcomeOutput,
  Classifier,
  ClassificationOutput,
  OutcomeResult,
  LegacyEntry,
  LegacyCatalog,
  SeedOptions,
  SeedResult,
  NewFailureCategory,
} from "./memory/index.js";

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
  inferTestPath,
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
