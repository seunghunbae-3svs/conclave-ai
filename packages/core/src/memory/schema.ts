import { z } from "zod";
import { BlockerSchema, ReviewResultSchema } from "../schema.js";

/**
 * EpisodicEntry — raw event log. One record per review cycle.
 * 90-day TTL per architecture. Nightly Haiku job classifies these into
 * answer-keys (on merge) + failure-catalog (on reject/rework).
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
