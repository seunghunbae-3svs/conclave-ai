import { createHash } from "node:crypto";
import type { EpisodicEntry, AnswerKey, FailureEntry, SolutionPatch } from "./schema.js";
import type { MemoryStore } from "./store.js";
import type { CalibrationStore } from "./calibration-store.js";
import { RuleBasedClassifier, newEpisodicId, type Classifier, type OutcomeResult } from "./classifier.js";
import type { ReviewContext, ReviewResult } from "../agent.js";

export interface WriteReviewInput {
  ctx: ReviewContext;
  reviews: readonly ReviewResult[];
  councilVerdict: "approve" | "rework" | "reject";
  costUsd: number;
  /** Provide a stable id to make the write idempotent (re-runs update instead of dup). Defaults to a UUID. */
  episodicId?: string;
  /**
   * H2 #6 — 1-indexed rework cycle number. Cycle 1 is the first review;
   * cycle 2 the first auto-rework, etc. Defaults to 1 for legacy callers.
   */
  cycleNumber?: number;
  /**
   * H2 #6 — id of the episodic entry from the previous cycle of THIS PR.
   * Lets `recordOutcome` walk back across rework cycles to compute the
   * "removed blockers" signal that lands in the merged AnswerKey.
   */
  priorEpisodicId?: string;
  /**
   * H3 #11 — autofix worker patches applied between the prior cycle and
   * this one. Captured by the CLI from the autofix sidecar so the
   * merge-time classifier can promote merged solutions to answer-keys.
   */
  solutionPatches?: readonly SolutionPatch[];
}

export interface RecordOutcomeInput {
  episodicId: string;
  outcome: OutcomeResult;
}

export interface RecordOutcomeOutput {
  answerKeys: AnswerKey[];
  failures: FailureEntry[];
}

/**
 * OutcomeWriter — closes the self-evolve loop.
 *
 * Called from two points in the lifecycle:
 *   1. `writeReview(...)` — at the end of `conclave review`, persists an
 *      `EpisodicEntry` with `outcome: "pending"`.
 *   2. `recordOutcome(...)` — when the PR lands (merged / rejected /
 *      reworked), updates the stored episodic entry and invokes the
 *      classifier to produce `AnswerKey` + `FailureEntry` records.
 *
 * The classifier is pluggable (decision #17). Default is the rule-based
 * extractor — no LLM cost. A Haiku-backed classifier will slot in later
 * as a subtype, behind the same `Classifier` interface.
 */
export class OutcomeWriter {
  private readonly store: MemoryStore;
  private readonly classifier: Classifier;
  private readonly episodicIndex: Map<string, EpisodicEntry>;
  private readonly calibration: CalibrationStore | null;

  constructor(opts: {
    store: MemoryStore;
    classifier?: Classifier;
    /**
     * H2 #8 — when supplied, recordOutcome auto-records a calibration
     * override per (repo, domain, category) whenever a merge lands on
     * an episodic with councilVerdict ∈ {rework, reject}. Optional;
     * legacy callers keep working with no calibration tracking.
     */
    calibration?: CalibrationStore;
  }) {
    this.store = opts.store;
    this.classifier = opts.classifier ?? new RuleBasedClassifier();
    this.episodicIndex = new Map();
    this.calibration = opts.calibration ?? null;
  }

  async writeReview(input: WriteReviewInput): Promise<EpisodicEntry> {
    const id = input.episodicId ?? newEpisodicId();
    const entry: EpisodicEntry = {
      id,
      createdAt: new Date().toISOString(),
      repo: input.ctx.repo,
      pullNumber: input.ctx.pullNumber,
      sha: input.ctx.newSha,
      diffSha256: sha256(input.ctx.diff),
      reviews: [...input.reviews],
      councilVerdict: input.councilVerdict,
      outcome: "pending",
      costUsd: input.costUsd,
      cycleNumber: input.cycleNumber ?? 1,
      ...(input.priorEpisodicId ? { priorEpisodicId: input.priorEpisodicId } : {}),
      solutionPatches: input.solutionPatches ? [...input.solutionPatches] : [],
    };
    await this.store.writeEpisodic(entry);
    this.episodicIndex.set(id, entry);
    return entry;
  }

  async recordOutcome(input: RecordOutcomeInput): Promise<RecordOutcomeOutput> {
    const existing = this.episodicIndex.get(input.episodicId) ?? (await this.loadEpisodicFromDisk(input.episodicId));
    if (!existing) {
      throw new Error(`OutcomeWriter: no episodic entry found for id ${input.episodicId}`);
    }
    const updated: EpisodicEntry = { ...existing, outcome: input.outcome };
    await this.store.writeEpisodic(updated);
    this.episodicIndex.set(input.episodicId, updated);

    // H2 #6 — walk priorEpisodicId chain to recover earlier-cycle reviews.
    // Only relevant for "merged" outcomes (the answer-key path); skipped
    // for reject/rework since they don't read priors today.
    const priors =
      input.outcome === "merged" ? await this.collectPriors(updated) : [];
    const classification = this.classifier.classify(updated, input.outcome, priors);
    for (const key of classification.answerKeys) await this.store.writeAnswerKey(key);
    for (const entry of classification.failures) await this.store.writeFailure(entry);

    // H2 #8 — if a merge landed on a council verdict of rework or reject,
    // each blocker category counts as one override of the gate for this
    // repo. Walk the FINAL cycle's blockers (not the priors — those were
    // already-resolved cycles). Skip nits (the gate doesn't surface them
    // anyway). Best-effort: a calibration write failure does NOT
    // propagate, since the user's merge has already happened.
    if (
      this.calibration &&
      input.outcome === "merged" &&
      (existing.councilVerdict === "rework" || existing.councilVerdict === "reject")
    ) {
      const seenCategories = new Set<string>();
      for (const review of updated.reviews) {
        for (const blocker of review.blockers) {
          if (blocker.severity === "nit") continue;
          if (seenCategories.has(blocker.category)) continue;
          seenCategories.add(blocker.category);
          try {
            await this.calibration.recordOverride({
              repo: updated.repo,
              domain: "code",
              category: blocker.category,
              episodicId: updated.id,
            });
          } catch {
            // swallow — calibration is advisory; merge succeeded already
          }
        }
      }
    }

    return classification;
  }

  /**
   * Walk back through `priorEpisodicId` links and return the chain in
   * oldest-first order. Stops at the first missing link (defensive — a
   * deleted prior is treated as "no further history" rather than an
   * error). Bounded to 10 hops to prevent runaway loops if a malformed
   * chain ever forms.
   */
  private async collectPriors(start: EpisodicEntry): Promise<EpisodicEntry[]> {
    const chain: EpisodicEntry[] = [];
    let cursor: string | undefined = start.priorEpisodicId;
    const seen = new Set<string>([start.id]);
    let hops = 0;
    while (cursor && hops < 10) {
      if (seen.has(cursor)) break;
      seen.add(cursor);
      const prior = await this.store.findEpisodic(cursor);
      if (!prior) break;
      chain.push(prior);
      cursor = prior.priorEpisodicId;
      hops += 1;
    }
    return chain.reverse();
  }

  private async loadEpisodicFromDisk(id: string): Promise<EpisodicEntry | null> {
    return this.store.findEpisodic(id);
  }

  /** Test helper: inject an episodic entry into the in-memory index. */
  _setEpisodicForTest(entry: EpisodicEntry): void {
    this.episodicIndex.set(entry.id, entry);
  }
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
