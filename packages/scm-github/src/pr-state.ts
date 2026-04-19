import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export type PrState = "open" | "merged" | "closed";
export type OutcomeForPr = "merged" | "rejected" | "reworked" | "pending";

export interface PullRequestState {
  repo: string;
  prNumber: number;
  state: PrState;
  /** If merged: the merge commit SHA. */
  mergeCommitSha?: string;
  /** Head commit SHA at the last observation. Used to detect reworks. */
  headSha: string;
  /** ISO timestamp of the last state transition observed. */
  updatedAt: string;
}

export interface GhRunner {
  (bin: string, args: readonly string[], opts?: { cwd?: string; timeout?: number }): Promise<{
    stdout: string;
    stderr?: string;
  }>;
}

const defaultRunner: GhRunner = async (bin, args, opts) => {
  const { stdout, stderr } = await execFile(bin, args as string[], {
    ...opts,
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout, stderr };
};

/**
 * Fetch a PR's current state via `gh pr view`. Uses the gh CLI for auth +
 * network — same dependency as @ai-conclave/cli already requires for
 * `conclave review --pr N`. No GitHub token needs to live in conclave's
 * config.
 */
export async function fetchPrState(
  repo: string,
  prNumber: number,
  deps: { run?: GhRunner } = {},
): Promise<PullRequestState> {
  const run = deps.run ?? defaultRunner;
  const { stdout } = await run("gh", [
    "pr",
    "view",
    String(prNumber),
    "--repo",
    repo,
    "--json",
    "state,mergeCommit,headRefOid,updatedAt",
  ]);
  const raw = JSON.parse(stdout) as {
    state?: string;
    mergeCommit?: { oid?: string };
    headRefOid?: string;
    updatedAt?: string;
  };
  if (!raw.headRefOid) {
    throw new Error(`scm-github: missing headRefOid for ${repo} #${prNumber}`);
  }
  const state = normalizeState(raw.state);
  const out: PullRequestState = {
    repo,
    prNumber,
    state,
    headSha: raw.headRefOid,
    updatedAt: raw.updatedAt ?? new Date().toISOString(),
  };
  if (state === "merged" && raw.mergeCommit?.oid) out.mergeCommitSha = raw.mergeCommit.oid;
  return out;
}

function normalizeState(raw: string | undefined): PrState {
  switch ((raw ?? "").toUpperCase()) {
    case "OPEN":
      return "open";
    case "MERGED":
      return "merged";
    case "CLOSED":
      return "closed";
    default:
      throw new Error(`scm-github: unknown PR state "${String(raw)}"`);
  }
}

/**
 * Classify the transition from a past PR observation into the outcome
 * vocabulary used by `OutcomeWriter.recordOutcome`.
 *
 * Rules:
 *   - merged                 → "merged"
 *   - closed without merge   → "rejected"
 *   - still open, but head advanced since the review's observation SHA →
 *     "reworked" (new commits landed on the PR branch)
 *   - otherwise               → "pending" (nothing to record yet)
 */
export function classifyTransition(
  current: PullRequestState,
  reviewedSha: string,
): OutcomeForPr {
  if (current.state === "merged") return "merged";
  if (current.state === "closed") return "rejected";
  if (current.state === "open" && current.headSha !== reviewedSha) return "reworked";
  return "pending";
}
