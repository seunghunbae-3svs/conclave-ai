import type { EpisodicEntry, MemoryStore, OutcomeWriter } from "@conclave-ai/core";
import {
  fetchPrState,
  classifyTransition,
  type GhRunner,
  type OutcomeForPr,
  type PullRequestState,
} from "./pr-state.js";

export interface PollRunnerOptions {
  store: MemoryStore;
  writer: OutcomeWriter;
  /** Optional test hook: replaces the gh CLI invocation path. */
  run?: GhRunner;
}

export interface PollResult {
  episodicId: string;
  repo: string;
  prNumber: number;
  classification: OutcomeForPr;
  wrote: boolean;
  error?: string;
}

export interface PollSummary {
  scanned: number;
  merged: number;
  rejected: number;
  reworked: number;
  pending: number;
  errors: number;
  results: PollResult[];
}

/**
 * Scan the memory store for episodic entries in `outcome: "pending"` and,
 * for each one whose PR number is valid, poll GitHub for the current PR
 * state. Any pending→merged / pending→rejected / pending→reworked
 * transition is recorded through the OutcomeWriter (which classifies +
 * writes AnswerKey / FailureEntry records).
 *
 * This is the "pull" alternative to a webhook listener. Users can run
 * `conclave poll-outcomes` on a cron or manually after a batch of
 * reviews settles. Webhook listener (which needs a hosted server) lands
 * in a later package if / when Bae wants it.
 */
export async function pollOutcomes(opts: PollRunnerOptions): Promise<PollSummary> {
  const pending = await listPendingEpisodics(opts.store);
  const summary: PollSummary = {
    scanned: 0,
    merged: 0,
    rejected: 0,
    reworked: 0,
    pending: 0,
    errors: 0,
    results: [],
  };

  for (const ep of pending) {
    summary.scanned += 1;
    if (!ep.pullNumber || ep.pullNumber <= 0) {
      // Local / file reviews (pullNumber = 0) have no GitHub state to poll.
      summary.pending += 1;
      summary.results.push({
        episodicId: ep.id,
        repo: ep.repo,
        prNumber: ep.pullNumber,
        classification: "pending",
        wrote: false,
      });
      continue;
    }
    try {
      const state = await fetchPrState(ep.repo, ep.pullNumber, { run: opts.run });
      const classification = classifyTransition(state, ep.sha);
      const wrote = await applyClassification(opts.writer, ep.id, classification);
      tally(summary, classification, wrote);
      summary.results.push({
        episodicId: ep.id,
        repo: ep.repo,
        prNumber: ep.pullNumber,
        classification,
        wrote,
      });
    } catch (err) {
      summary.errors += 1;
      summary.results.push({
        episodicId: ep.id,
        repo: ep.repo,
        prNumber: ep.pullNumber,
        classification: "pending",
        wrote: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return summary;
}

async function applyClassification(
  writer: OutcomeWriter,
  episodicId: string,
  classification: OutcomeForPr,
): Promise<boolean> {
  if (classification === "pending") return false;
  await writer.recordOutcome({ episodicId, outcome: classification });
  return true;
}

function tally(summary: PollSummary, classification: OutcomeForPr, wrote: boolean): void {
  if (classification === "merged" && wrote) summary.merged += 1;
  else if (classification === "rejected" && wrote) summary.rejected += 1;
  else if (classification === "reworked" && wrote) summary.reworked += 1;
  else summary.pending += 1;
}

/**
 * Walk the MemoryStore for episodic entries still in `outcome: "pending"`.
 * For FS stores this is a one-shot directory walk; for DB stores it would
 * be a filtered query. We depend only on `findEpisodic` + a walker — any
 * MemoryStore can implement this path.
 *
 * Current implementation probes the store by walking an incrementing
 * depth-2 directory tree if available. For interfaces without a list
 * method, we accept that callers pass a list explicitly via a higher-
 * level helper. For now this helper lives here so the CLI can call it
 * against the default FS store.
 */
export async function listPendingEpisodics(store: MemoryStore): Promise<EpisodicEntry[]> {
  // Duck-type: FileSystemMemoryStore exposes `_listEpisodic` when present.
  const duck = store as unknown as { listEpisodic?: () => Promise<EpisodicEntry[]> };
  if (typeof duck.listEpisodic === "function") {
    const all = await duck.listEpisodic();
    return all.filter((e) => e.outcome === "pending");
  }
  return [];
}

export { listPendingEpisodics as _listPendingEpisodics };
