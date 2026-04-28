export {
  AnswerKeySchema,
  AnswerKeyDomainSchema,
  EpisodicEntrySchema,
  FailureEntrySchema,
  FailureCategorySchema,
  FailureSeveritySchema,
  SemanticRuleSchema,
  CalibrationEntrySchema,
  SolutionPatchSchema,
} from "./schema.js";
export type {
  AnswerKey,
  EpisodicEntry,
  FailureEntry,
  SemanticRule,
  CalibrationEntry,
  SolutionPatch,
} from "./schema.js";

export { FileSystemCalibrationStore } from "./calibration-store.js";
export type {
  CalibrationStore,
  RecordOverrideInput,
  FsCalibrationStoreOptions,
} from "./calibration-store.js";

export { formatAnswerKeyForPrompt, formatFailureForPrompt } from "./store.js";
export type { MemoryStore, MemoryReadQuery, MemoryRetrieval } from "./store.js";

export { retrieve } from "./retrieval.js";
export type { RetrievalFieldExtractor, RetrievalOptions, ScoredDoc } from "./retrieval.js";

export { FileSystemMemoryStore } from "./fs-store.js";
export type { FsStoreOptions } from "./fs-store.js";

export { OutcomeWriter } from "./outcome-writer.js";
export type {
  WriteReviewInput,
  RecordOutcomeInput,
  RecordOutcomeOutput,
} from "./outcome-writer.js";

export { applyFailureGate } from "./failure-gate.js";
export type { FailureGateOptions, FailureGateResult } from "./failure-gate.js";

export { RuleBasedClassifier, newEpisodicId } from "./classifier.js";
export type { Classifier, ClassificationOutput, OutcomeResult } from "./classifier.js";

export {
  LegacyEntrySchema,
  LegacyCatalogSchema,
  mapLegacyCategory,
  toFailureEntry,
  seedFromLegacyCatalog,
  seedFromLegacyCatalogPath,
} from "./seeder.js";
export type { LegacyEntry, LegacyCatalog, SeedOptions, SeedResult, NewFailureCategory } from "./seeder.js";
