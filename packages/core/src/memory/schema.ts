import { z } from "zod";
import { BlockerSchema, ReviewResultSchema } from "../schema.js";

/**
 * SolutionPatch — a (blocker, patch) pair captured when the autofix
 * worker successfully addressed a council blocker. Carried on the
 * EpisodicEntry that recorded the worker's work, so the merge-time
 * classifier can promote merged solutions to answer-keys (H3 #11).
 */
export const SolutionPatchSchema = z.object({
  /** Free-form category from the original Blocker (e.g. "debug-noise"). */
  blockerCategory: z.string().min(1),
  blockerMessage: z.string().min(1),
  blockerFile: z.string().optional(),
  blockerLine: z.number().int().positive().optional(),
  /** The unified-diff hunk the worker produced and that was applied. */
  hunk: z.string().min(1),
  /** Agent that raised the original blocker ("claude", "openai", …). */
  agent: z.string().min(1),
});
export type SolutionPatch = z.infer<typeof SolutionPatchSchema>;

/**
 * EpisodicEntry — raw event log. One record per review cycle.
 * 90-day TTL per architecture. Nightly Haiku job classifies these into
 * answer-keys (on merge) + failure-catalog (on reject/rework).
 *
 * `cycleNumber` (1-indexed) and `priorEpisodicId` link reviews of the
 * same PR across rework cycles. When a merge happens at cycle N, the
 * classifier walks `priorEpisodicId` back to cycle 1 to recover blockers
 * that were caught and fixed before merge — those become "removed
 * blockers" on the resulting AnswerKey (H2 #6).
 *
 * `solutionPatches` carries the autofix worker's patches that were
 * applied between the prior cycle and this one (H3 #11). On merge,
 * each (removed-blocker, matching solutionPatch) pair becomes its own
 * answer-key with `solutionPatch` populated — the worker reads those
 * at next-PR time as RAG ("here's what I did last time for this
 * category").
 */
export const EpisodicEntrySchema = z.object({
  id: z.string().min(1),
  createdAt: z.string().datetime(),
  repo: z.string().min(1),
  pullNumber: z.number().int().nonnegative(),
  sha: z.string().min(1),
  diffSha256: z.string().length(64),
  reviews: z.array(ReviewResultSchema),
  councilVerdict: z.enum(["approve", "rework", "reject"]),
  outcome: z.enum(["merged", "rejected", "reworked", "pending"]),
  costUsd: z.number().nonnegative(),
  cycleNumber: z.number().int().min(1).default(1),
  priorEpisodicId: z.string().optional(),
  solutionPatches: z.array(SolutionPatchSchema).default([]),
});
export type EpisodicEntry = z.infer<typeof EpisodicEntrySchema>;

/**
 * AnswerKey — a SUCCESS PATTERN. Written when a PR merges.
 * Retrieved at review time so future reviews match the repo's tolerance
 * for what counts as a blocker and what counts as polish.
 */
export const AnswerKeyDomainSchema = z.enum(["code", "design"]);
export const AnswerKeySchema = z.object({
  id: z.string().min(1),
  createdAt: z.string().datetime(),
  domain: AnswerKeyDomainSchema,
  /** e.g. "by-pattern/auth-middleware", "by-component/LoginForm". Flat path inside the domain. */
  pattern: z.string().min(1),
  repo: z.string().optional(),
  user: z.string().optional(),
  /** One-paragraph distillation of what made this PR a good change. */
  lesson: z.string().min(1),
  /** Tags for filtered retrieval ("auth", "react", "refactor", "ui"). */
  tags: z.array(z.string()).default([]),
  /** Optional pointer back to the episodic entry that produced this answer-key. */
  episodicId: z.string().optional(),
  /**
   * H2 #6 — blockers that surfaced in earlier rework cycles of this PR
   * but were resolved before merge. Each entry tells the next council
   * "this repo cares about <category>; here's a representative message"
   * so retrieval can match on the same words ("console.log" → catches
   * future console.log noise without re-learning).
   *
   * Default empty for legacy answer-keys + non-rework merges.
   */
  removedBlockers: z
    .array(
      z.object({
        category: z.string().min(1),
        severity: z.enum(["blocker", "major", "minor", "nit"]),
        message: z.string().min(1),
      }),
    )
    .default([]),
  /**
   * H3 #11 — when this answer-key represents a (removed-blocker,
   * autofix-patch) pair, `solutionPatch` carries the unified-diff hunk
   * the worker produced. Future autofix iterations retrieve these as
   * RAG context — "for this repo, blockers of category X have been
   * resolved with patches that look like this".
   *
   * Absent on legacy answer-keys + on aggregate merge keys (only the
   * per-pair derivative keys carry it).
   */
  solutionPatch: SolutionPatchSchema.optional(),
});
export type AnswerKey = z.infer<typeof AnswerKeySchema>;

/**
 * FailureEntry — a FAILURE PATTERN. Written on reject or rework.
 * Seeded from solo-cto-agent's failure-catalog.json (ERR-001~) per
 * decision #18 — do not start from zero.
 */
export const FailureSeveritySchema = z.enum(["blocker", "major", "minor"]);
export const FailureCategorySchema = z.enum([
  "type-error",
  "missing-test",
  "regression",
  "security",
  "accessibility",
  "contrast",
  "performance",
  "dead-code",
  "api-misuse",
  "schema-drift",
  "other",
]);
export const FailureEntrySchema = z.object({
  id: z.string().min(1),
  createdAt: z.string().datetime(),
  domain: AnswerKeyDomainSchema,
  category: FailureCategorySchema,
  severity: FailureSeveritySchema,
  /** Short human-readable title of the pattern. */
  title: z.string().min(1),
  /** Details / why it's bad / how to fix — the thing agents read at review time. */
  body: z.string().min(1),
  /** Optional small code-or-diff snippet showing the pattern. */
  snippet: z.string().optional(),
  tags: z.array(z.string()).default([]),
  /** Blocker that first surfaced this pattern, if any. */
  seedBlocker: BlockerSchema.optional(),
  episodicId: z.string().optional(),
});
export type FailureEntry = z.infer<typeof FailureEntrySchema>;

/**
 * CalibrationEntry — per-(repo, domain, category) record of how often a
 * user has overridden the council on this category for this repo. An
 * "override" is a merge that landed despite the council verdict being
 * rework or reject. High override counts mean the repo's reviewer
 * tolerates this category as a nit, so the failure-gate (H2 #7) demotes
 * stickies for it (or skips entirely past the threshold).
 *
 * H2 #8 — adaptive calibration. The threshold rule is intentionally
 * step-function rather than continuous so behavior is predictable and
 * testable; tune the bands by editing applyCalibrationToSticky in
 * failure-gate.ts.
 */
export const CalibrationEntrySchema = z.object({
  repo: z.string().min(1),
  domain: AnswerKeyDomainSchema,
  category: z.string().min(1),
  overrideCount: z.number().int().nonnegative(),
  lastOverrideAt: z.string().datetime(),
  lastSampleEpisodicId: z.string().optional(),
});
export type CalibrationEntry = z.infer<typeof CalibrationEntrySchema>;

/**
 * SemanticRule — distilled cross-entry pattern. Weekly Haiku job.
 * Format kept intentionally narrow so rules are short, actionable, and
 * indexable by a tag vocabulary.
 */
export const SemanticRuleSchema = z.object({
  id: z.string().min(1),
  createdAt: z.string().datetime(),
  tag: z.string().min(1),
  rule: z.string().min(1),
  evidence: z.object({
    answerKeyIds: z.array(z.string()).default([]),
    failureIds: z.array(z.string()).default([]),
  }),
});
export type SemanticRule = z.infer<typeof SemanticRuleSchema>;
