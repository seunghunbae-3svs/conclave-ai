import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

/**
 * v0.12 — local-daemon notification source.
 *
 * The poller wraps `gh api repos/:owner/:repo/pulls?state=open` (NOT
 * `/notifications` — that path requires the user to be subscribed,
 * which most repo owners aren't on their own repos by default and
 * which silently truncates after 50 unread items). Polling open PRs
 * directly is more reliable for the watch use case.
 *
 * The poller is stateless — it reports the CURRENT set of open PRs.
 * The `conclave watch` command holds the seen-set in memory across
 * polls and dispatches a workflow ONLY for newly-appeared PRs +
 * NEW commits on existing PRs (head SHA changed). That keeps watch
 * resumable without an on-disk cache for the common case.
 */

export interface PullRequestSnapshot {
  /** "owner/name" */
  repoSlug: string;
  /** PR number. */
  number: number;
  /** Head SHA at poll time — drives "new commit since last poll" detection. */
  headSha: string;
  /** PR title (for diagnostics + `gh workflow run` payload). */
  title: string;
  /** PR state — only OPEN PRs are returned by the poller. */
  state: "open";
  /** ISO-8601 last-updated timestamp. Used as a tiebreaker when head_sha is missing. */
  updatedAt: string;
  /** Author login — useful for filters (skip dependabot etc.). */
  authorLogin: string;
  /** Whether the PR is a draft. Watch defaults to skipping drafts. */
  draft: boolean;
}

export interface PollerDeps {
  /**
   * Test seam. Production calls `gh` via execFile. Tests inject a stub
   * that returns a fixture array.
   */
  ghRun?: (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
}

const DEFAULT_GH: NonNullable<PollerDeps["ghRun"]> = async (cmd, args) => {
  const { stdout, stderr } = await execFile(cmd, args, { maxBuffer: 4 * 1024 * 1024 });
  return { stdout, stderr };
};

interface RawPr {
  number: number;
  title: string;
  state: string;
  head: { sha: string };
  user: { login: string } | null;
  draft: boolean;
  updated_at: string;
}

/**
 * Poll one repo for open PRs. Returns the FULL current snapshot — the
 * caller diffs against the previous snapshot to find new PRs.
 *
 * Failure handling:
 *   - `gh` not installed → throws with an actionable message.
 *   - `gh` exits non-zero → throws with the stderr tail attached.
 *   - JSON parse failure → throws (means the gh contract changed).
 *   - The watch loop catches and logs without dying, so a transient
 *     failure on one repo doesn't take the daemon down.
 */
export async function pollOpenPrs(
  repoSlug: string,
  deps: PollerDeps = {},
): Promise<PullRequestSnapshot[]> {
  const ghRun = deps.ghRun ?? DEFAULT_GH;
  const path = `repos/${repoSlug}/pulls?state=open&per_page=50`;
  let stdout: string;
  try {
    const result = await ghRun("gh", ["api", path]);
    stdout = result.stdout;
  } catch (err) {
    const e = err as Error & { stderr?: string; code?: string };
    if (e.code === "ENOENT") {
      throw new Error(
        "conclave watch: `gh` CLI not found. Install from https://cli.github.com and run `gh auth login`.",
      );
    }
    const tail = (e.stderr ?? "").toString().slice(-300);
    throw new Error(`gh api ${path} failed: ${tail || e.message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new Error(
      `gh api ${path} returned non-JSON stdout: ${(err as Error).message}; first 200 chars: ${stdout.slice(0, 200)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`gh api ${path} expected array, got ${typeof parsed}`);
  }
  const out: PullRequestSnapshot[] = [];
  for (const raw of parsed as RawPr[]) {
    if (!raw || typeof raw !== "object") continue;
    if (typeof raw.number !== "number") continue;
    if (raw.state !== "open") continue;
    const headSha = raw.head?.sha ?? "";
    if (!headSha) continue;
    out.push({
      repoSlug,
      number: raw.number,
      headSha,
      title: typeof raw.title === "string" ? raw.title : "",
      state: "open",
      updatedAt: typeof raw.updated_at === "string" ? raw.updated_at : "",
      authorLogin: raw.user?.login ?? "",
      draft: raw.draft === true,
    });
  }
  return out;
}

/**
 * v0.12 — diff helper for the watch loop. Given the previous snapshot
 * (a Map keyed by `${repoSlug}#${number}`) and the current poll
 * results, returns:
 *   - newPrs   — PRs not seen in the previous snapshot
 *   - updated  — PRs whose head_sha changed since the previous snapshot
 *   - closed   — PRs in the previous snapshot but absent from current
 *
 * The caller dispatches a review for newPrs ∪ updated and prunes
 * closed from the seen-set.
 */
export interface PollDiff {
  newPrs: PullRequestSnapshot[];
  updated: PullRequestSnapshot[];
  closed: string[]; // keys ("repoSlug#number")
}

export function diffPolls(
  previous: Map<string, PullRequestSnapshot>,
  current: PullRequestSnapshot[],
): PollDiff {
  const currentKeys = new Set<string>();
  const newPrs: PullRequestSnapshot[] = [];
  const updated: PullRequestSnapshot[] = [];
  for (const cur of current) {
    const key = `${cur.repoSlug}#${cur.number}`;
    currentKeys.add(key);
    const prev = previous.get(key);
    if (!prev) {
      newPrs.push(cur);
      continue;
    }
    if (prev.headSha !== cur.headSha) {
      updated.push(cur);
    }
  }
  const closed: string[] = [];
  for (const key of previous.keys()) {
    if (!currentKeys.has(key)) closed.push(key);
  }
  return { newPrs, updated, closed };
}

/**
 * v0.12 — fire `gh workflow run conclave-review.yml --ref <branch>
 * -f pr_number=<N>` to dispatch a review on a target PR. Mirrors what
 * the central plane does for autonomy reworks; here it's the DAEMON
 * doing the dispatch instead.
 *
 * Failures throw — the watch loop catches per-repo so one repo's
 * dispatch failure doesn't poison the others.
 */
export async function dispatchReviewWorkflow(
  pr: PullRequestSnapshot,
  workflow: string,
  deps: PollerDeps = {},
): Promise<void> {
  const ghRun = deps.ghRun ?? DEFAULT_GH;
  const args = [
    "workflow",
    "run",
    workflow,
    "--repo",
    pr.repoSlug,
    "-f",
    `pr_number=${pr.number}`,
  ];
  try {
    await ghRun("gh", args);
  } catch (err) {
    const e = err as Error & { stderr?: string };
    const tail = (e.stderr ?? "").toString().slice(-300);
    throw new Error(`gh workflow run ${workflow} on ${pr.repoSlug}#${pr.number} failed: ${tail || e.message}`);
  }
}
