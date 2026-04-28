import type { FileSystemMemoryStore } from "@conclave-ai/core";

/**
 * findPriorEpisodicId — locate the episodic entry that represents the
 * cycle BEFORE `currentCycle` of the same PR. Returns undefined when
 * no prior cycle exists or none can be found locally (e.g. a fresh
 * clone where the previous cycle was written on a different runner).
 *
 * Heuristic, in order:
 *   1. Match (repo, pullNumber, cycleNumber === currentCycle - 1).
 *   2. If multiple, prefer the most recent `createdAt`.
 *   3. Fallback (legacy episodics with no cycleNumber field): match
 *      (repo, pullNumber) and prefer the most recent before this cycle.
 *
 * Listed-corpus walk is fine: episodic has a 90-day TTL so the active
 * window is bounded. Costlier indexes can land later if profile shows
 * this hot.
 */
export async function findPriorEpisodicId(
  store: FileSystemMemoryStore,
  repo: string,
  pullNumber: number,
  currentCycle: number,
): Promise<string | undefined> {
  if (currentCycle <= 1) return undefined;
  const targetCycle = currentCycle - 1;
  const all = await store.listEpisodic();
  const matchByCycle = all
    .filter(
      (e) =>
        e.repo === repo &&
        e.pullNumber === pullNumber &&
        e.cycleNumber === targetCycle,
    )
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  if (matchByCycle.length > 0) return matchByCycle[0]!.id;

  // Legacy fallback — no cycleNumber on older entries (pre-H2#6 schema).
  // The schema default is 1, so post-H2#6 entries always have a number.
  // Pick the most recent same-PR entry with cycleNumber < currentCycle.
  const legacy = all
    .filter(
      (e) =>
        e.repo === repo &&
        e.pullNumber === pullNumber &&
        e.cycleNumber < currentCycle,
    )
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return legacy[0]?.id;
}
