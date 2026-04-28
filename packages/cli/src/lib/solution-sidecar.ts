import { promises as fs } from "node:fs";
import path from "node:path";
import type { SolutionPatch } from "@conclave-ai/core";

/**
 * H3 #11 — sidecar handoff between `conclave autofix` and the next
 * `conclave review` cycle.
 *
 * Layout: `<memoryRoot>/pending-solutions/<repoSlug>__pr-<N>__cycle-<C>.json`
 *
 * **Semantic of `cycleNumber`** (load-bearing — H3 #11 audit found a
 * silent off-by-one before this comment was here):
 *   `cycleNumber` MUST equal the `EpisodicEntry.cycleNumber` that the
 *   review CONSUMING this sidecar will write. Both writer (autofix)
 *   and reader (review) must agree on this exact key.
 *
 * Concretely:
 *   - review.ts computes `cycleNumber = (--rework-cycle ?? 0) + 1`
 *     and reads the sidecar at that key.
 *   - autofix.ts must therefore write at the value the NEXT review's
 *     formula will produce, NOT at the commit-marker cycle. Marker
 *     cycle = `reworkCycle + 1`; episodic cycleNumber the next review
 *     will write = `reworkCycle + 2` = `markerCycle + 1`.
 *   - For first autofix run (reworkCycle 0): marker=1, sidecar=2.
 *
 * Each file is a JSON array of SolutionPatch objects.
 *
 * Lifecycle:
 *   - autofix writes the file after a successful patch + push.
 *   - review reads it when starting a non-zero cycle and folds the
 *     patches into the EpisodicEntry it persists.
 *   - review deletes the file once consumed (best-effort).
 *   - Anything left behind is harmless: the next cycle's review writes
 *     a fresh file (overwrite), and recordOutcome at merge only walks
 *     the on-disk priorEpisodicId chain.
 */

export interface SolutionSidecarOptions {
  /** Path to the `.conclave` memory root. */
  memoryRoot: string;
  /** Owner/repo of the PR (e.g. "acme/app"). */
  repo: string;
  /** Pull-request number. */
  pullNumber: number;
  /** Cycle number this sidecar belongs to (1-indexed; matches EpisodicEntry.cycleNumber). */
  cycleNumber: number;
}

export function sidecarPath(opts: SolutionSidecarOptions): string {
  return path.join(
    opts.memoryRoot,
    "pending-solutions",
    `${slugRepo(opts.repo)}__pr-${opts.pullNumber}__cycle-${opts.cycleNumber}.json`,
  );
}

export async function writeSolutionSidecar(
  opts: SolutionSidecarOptions,
  patches: readonly SolutionPatch[],
): Promise<string> {
  const file = sidecarPath(opts);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(patches, null, 2), "utf8");
  return file;
}

/**
 * Read the sidecar for the given (repo, pr, cycle). Returns [] when
 * the file is missing or unreadable — callers treat the absence as
 * "no autofix patches were captured for this cycle".
 */
export async function readSolutionSidecar(
  opts: SolutionSidecarOptions,
): Promise<SolutionPatch[]> {
  const file = sidecarPath(opts);
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SolutionPatch[]) : [];
  } catch {
    return [];
  }
}

export async function deleteSolutionSidecar(opts: SolutionSidecarOptions): Promise<void> {
  const file = sidecarPath(opts);
  try {
    await fs.unlink(file);
  } catch {
    // best-effort
  }
}

function slugRepo(repo: string): string {
  return repo.replace(/\//g, "__").replace(/[^a-zA-Z0-9_.\-]/g, "_") || "default";
}
