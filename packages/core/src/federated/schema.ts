import { z } from "zod";
import {
  AnswerKeyDomainSchema,
  FailureCategorySchema,
  FailureSeveritySchema,
} from "../memory/schema.js";

/**
 * FederatedBaseline — the ONLY shape that leaves the user's machine per
 * decision #21. Carries category + severity + normalized tag vector +
 * a deterministic hash. NO code, diffs, lesson text, titles, bodies,
 * snippets, repos, or user identifiers.
 *
 * Same pattern across users produces the same `contentHash` — servers
 * aggregate by hash to build a cross-user frequency signal without
 * being able to reconstruct any individual's review history.
 */
export const FederatedBaselineKindSchema = z.enum(["answer-key", "failure"]);
export type FederatedBaselineKind = z.infer<typeof FederatedBaselineKindSchema>;

export const FederatedBaselineSchema = z.object({
  /** Bump on any breaking wire-format change. Servers MUST reject unknown versions. */
  version: z.literal(1),
  kind: FederatedBaselineKindSchema,
  /**
   * Deterministic sha256 of `(kind, domain, category, severity, sorted-tags)`.
   * Same five-tuple across users → same hash → server-side aggregation.
   */
  contentHash: z.string().length(64),
  domain: AnswerKeyDomainSchema,
  /** Present only for `kind = "failure"`. */
  category: FailureCategorySchema.optional(),
  severity: FailureSeveritySchema.optional(),
  /** Normalized vocabulary — trimmed, lowercased, deduped, sorted. */
  tags: z.array(z.string()).default([]),
  /** `YYYY-MM-DD` day bucket. Raw timestamp deliberately discarded — enough granularity for trends, not enough to fingerprint. */
  dayBucket: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type FederatedBaseline = z.infer<typeof FederatedBaselineSchema>;
