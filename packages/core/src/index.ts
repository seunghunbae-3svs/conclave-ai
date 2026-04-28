export type { Agent, ReviewContext, ReviewResult, Blocker, Severity, PriorReview, ReviewDomain, ReviewMode } from "./agent.js";
export { Council } from "./council.js";
export type { CouncilOutcome, CouncilOptions, RoundOutcome } from "./council.js";
export { TieredCouncil } from "./tiered-council.js";
export type { TieredCouncilOptions, TieredCouncilOutcome } from "./tiered-council.js";
export { LoopGuard, CircuitBreaker, LoopDetectedError, CircuitOpenError } from "./guards.js";
export type { LoopGuardOptions, CircuitBreakerOptions } from "./guards.js";
export { ReviewResultSchema, BlockerSchema } from "./schema.js";
export type {
  Notifier,
  NotifyReviewInput,
  NotifyProgressInput,
  ProgressStage,
  ProgressPayload,
} from "./notifier.js";
export { resolveFirstPreview } from "./platform.js";
export type { Platform, PreviewResolution, ResolvePreviewInput } from "./platform.js";
export { computeAgentScore, computeAllAgentScores, AGENT_SCORE_WEIGHTS } from "./scoring.js";
export type { AgentScore, AgentScoreComponents } from "./scoring.js";

// UI / design-surface detection (v0.9.3 — shared between
// @conclave-ai/cli's domain-detect and @conclave-ai/agent-design's
// ui-globs so the two layers can't drift on what counts as "UI").
export {
  DEFAULT_UI_SIGNALS,
  DEFAULT_EXCLUDES,
  IMAGE_EXTS,
  pathExt,
  globToRegExp,
  matchesAny,
  isUiPath,
  filterUiFiles,
  diffTouchesUi,
  extractChangedFilePaths,
  extractChangedFilesFromDiff,
} from "./ui-detect.js";
export type { ChangedFile, ChangedFileStatus, UiDetectOptions } from "./ui-detect.js";

// Autofix (v0.7) — shared types for the autonomous fix loop. CLI lives
// in @conclave-ai/cli; core only owns the data contracts so consumers
// can render autofix verdicts without pulling the CLI dep graph.
export {
  isFileDenied,
  summarizeAutofixPatches,
  dedupeBlockersAcrossAgents,
  isFuzzyDuplicate,
  DEFAULT_AUTOFIX_DENY_PATTERNS,
} from "./autofix.js";
export type {
  BlockerFix,
  BlockerFixStatus,
  AutofixIteration,
  AutofixResult,
  AutofixResultStatus,
} from "./autofix.js";

// Plain-language summary (v0.6.1) — routes every council/audit output through
// one cheap LLM call to produce jargon-free prose for non-dev stakeholders
// on Telegram/Discord/Slack. See plain-summary.ts for the contract.
export {
  generatePlainSummary,
  computePlainSummaryKey,
  parsePlainSummaryText,
  InMemoryPlainSummaryCache,
} from "./plain-summary.js";
export type {
  PlainSummary,
  PlainSummaryInput,
  PlainSummaryMode,
  PlainSummaryVerdict,
  PlainSummaryLocale,
  PlainSummarySubject,
  PlainSummaryChanges,
  PlainSummaryScope,
  PlainSummaryBlocker,
  PlainSummaryLlm,
  PlainSummaryCache,
  GeneratePlainSummaryDeps,
} from "./plain-summary.js";

// Autonomous pipeline (v0.8) — deterministic Telegram message + button
// renderer for the 4-state auto-rework loop. No LLM; pure data.
export {
  renderAutonomyMessage,
  buttonsToInlineKeyboard,
  decideAutonomyState,
  clampMaxCycles,
  autonomyCallbackData,
  parseCycleFromCommitMessage,
  formatCycleMarker,
  AUTONOMY_HARD_CEILING_CYCLES,
  AUTONOMY_DEFAULT_MAX_CYCLES,
} from "./autonomy.js";
export type {
  AutonomyContext,
  AutonomyState,
  AutonomyButton,
  AutonomyMergeStrategy,
  RenderedAutonomyMessage,
} from "./autonomy.js";

// Memory substrate (decision #17: answer-keys + failure-catalog duality as core primitive).
// Re-exported here for convenience; dedicated subpath at @conclave-ai/core/memory.
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
  applyFailureGate,
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
  FailureGateOptions,
  FailureGateResult,
} from "./memory/index.js";

// Federated sync (decision #21) — redact answer-keys + failures to the
// k-anonymous baseline shape and ship them across a pluggable transport.
// Re-exported here for convenience; dedicated subpath at @conclave-ai/core/federated.
export {
  FederatedBaselineSchema,
  FederatedBaselineKindSchema,
  redactAnswerKey,
  redactFailure,
  redactAll,
  normalizeTags,
  computeBaselineHash,
  hashAnswerKey,
  hashFailure,
  buildFrequencyMap,
  rerankByFrequency,
  HttpFederatedSyncTransport,
  NoopFederatedSyncTransport,
  runFederatedSync,
  FileSystemFederatedBaselineStore,
} from "./federated/index.js";
export type {
  FederatedBaseline,
  FederatedBaselineKind,
  FederatedSyncTransport,
  HttpTransportOptions,
  RerankedDoc,
  RunSyncInput,
  RunSyncResult,
  FederatedBaselineStore,
  FileSystemBaselineStoreOptions,
} from "./federated/index.js";

// Efficiency Gate (decision #22: first-class from day 1) — every LLM call
// routes through `EfficiencyGate.run(...)`. Re-exported here for convenience;
// the dedicated subpath export lives at @conclave-ai/core/efficiency.
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
