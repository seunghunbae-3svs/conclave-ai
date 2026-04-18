import { createHash } from "node:crypto";
import type { EpisodicEntry, AnswerKey, FailureEntry } from "./schema.js";
import type { MemoryStore } from "./store.js";
import { RuleBasedClassifier, newEpisodicId, type Classifier, type OutcomeResult } from "./classifier.js";
import type { ReviewContext, ReviewResult } from "../agent.js";

export interface WriteReviewInput {
  ctx: ReviewContext;
  reviews: readonly ReviewResult[];
  councilVerdict: "approve" | "rework" | "reject";
  costUsd: number;
  /** Provide a stable id to make the write idempotent (re-runs update instead of dup). Defaults to a UUID. */
  episodicId?: string;
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

  constructor(opts: { store: MemoryStore; classifier?: Classifier }) {
    this.store = opts.store;
    this.classifier = opts.classifier ?? new RuleBasedClassifier();
    this.episodicIndex = new Map();
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

    const classification = this.classifier.classify(updated, input.outcome);
    for (const key of classification.answerKeys) await this.store.writeAnswerKey(key);
    for (const entry of classification.failures) await this.store.writeFailure(entry);
    return classification;
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
