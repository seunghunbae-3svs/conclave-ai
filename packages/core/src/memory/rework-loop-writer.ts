import { createHash } from "node:crypto";
import type { Blocker } from "../agent.js";
import { mapCategory } from "./classifier.js";
import type { FailureEntry } from "./schema.js";
import type { MemoryStore } from "./store.js";

/**
 * H3 #12 — record a failure-catalog entry when the autofix rework loop
 * bails. The entry's `tags` carry the marker `"rework-loop-failure"` so
 * downstream tooling can filter for this class. The H2 #7 active gate
 * surfaces these as sticky blockers on subsequent reviews whose diff
 * tokens overlap, so "this kind of thing has stalled the loop before"
 * lands in the council prompt without a manual playbook.
 */

export interface ReworkLoopFailureInput {
  /** Owning repo, e.g. "acme/app". Used only for traceability — the
   *  FailureEntry isn't repo-scoped (catalog is global). */
  repo: string;
  /** Autofix terminal status — drives the title + tags. */
  bailStatus: string;
  /** Optional one-line rationale (paired with `bailStatus`). */
  bailReason?: string;
  /** Number of iterations actually executed before bailing. */
  iterationsAttempted: number;
  /** Total $ spent across all iterations of the bailed run. */
  totalCostUsd: number;
  /**
   * Blockers still present when the loop bailed. The first blocker is
   * used as the seed/representative; the rest contribute their
   * categories to the tag vector.
   */
  remainingBlockers: readonly Blocker[];
  /** Optional episodic id of the cycle the bail happened on. */
  episodicId?: string;
}

export interface ReworkLoopFailureOutput {
  written: FailureEntry | null;
  reason?: string;
}

/**
 * Construct + persist a FailureEntry for a bailed autofix loop. Returns
 * `{ written: null, reason }` when no representative blocker exists
 * (loop bailed before any blocker was identified — likely a config
 * problem, not a pattern worth cataloging). Idempotent in spirit: the
 * derived id is stable for the same (repo, bailStatus, blocker
 * category + message[:60]) tuple, so a re-run won't spawn duplicates.
 */
export async function writeReworkLoopFailure(
  store: MemoryStore,
  input: ReworkLoopFailureInput,
): Promise<ReworkLoopFailureOutput> {
  const seed = input.remainingBlockers[0];
  if (!seed) {
    return { written: null, reason: "no remaining blockers — nothing to seed the catalog entry with" };
  }

  // Closest enum match for FailureEntry.category. mapCategory already
  // coerces free-form blocker categories into the closed enum; for
  // rework-loop-failure entries we lean on it for consistency.
  const category = mapCategory(seed.category);
  const severity: FailureEntry["severity"] =
    seed.severity === "blocker" ? "blocker" : seed.severity === "major" ? "major" : "minor";

  const otherCategories = new Set<string>();
  for (const b of input.remainingBlockers.slice(1)) otherCategories.add(b.category);

  const tags = [
    "rework-loop-failure",
    input.bailStatus,
    seed.category,
    ...otherCategories,
  ];

  const dedupKey = `${input.bailStatus}|${seed.category}|${(seed.message ?? "").slice(0, 60)}`;
  const id = `fc-rework-${shortHash(dedupKey)}`;

  const titleSuffix = input.bailReason ? `: ${input.bailReason}` : "";
  const title = `Autofix rework loop bailed (${input.bailStatus})${titleSuffix}`;
  const body =
    `Autofix attempted ${input.iterationsAttempted} iteration(s) totaling ` +
    `$${input.totalCostUsd.toFixed(2)} before bailing with status "${input.bailStatus}". ` +
    `${input.remainingBlockers.length} blocker(s) remained. ` +
    `Representative blocker — ${seed.category} (${seed.severity}): ${truncate(seed.message ?? "", 200)}` +
    (seed.file ? ` at ${seed.file}${seed.line ? `:${seed.line}` : ""}` : "") +
    (input.bailReason ? `\nReason: ${input.bailReason}` : "");

  const entry: FailureEntry = {
    id,
    createdAt: new Date().toISOString(),
    domain: "code",
    category,
    severity,
    title,
    body,
    tags,
    seedBlocker: seed,
    ...(input.episodicId ? { episodicId: input.episodicId } : {}),
  };
  await store.writeFailure(entry);
  return { written: entry };
}

function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
