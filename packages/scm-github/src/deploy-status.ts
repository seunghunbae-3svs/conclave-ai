import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { GhRunner } from "./pr-state.js";

const execFile = promisify(execFileCallback);

export type DeployStatus = "success" | "failure" | "pending" | "unknown";

const defaultRunner: GhRunner = async (bin, args, opts) => {
  const { stdout, stderr } = await execFile(bin, args as string[], {
    ...opts,
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout, stderr };
};

/**
 * A single check-run as GitHub returns it from `/repos/:owner/:repo/commits/
 * :sha/check-runs`. Only the fields we use.
 */
interface CheckRun {
  name: string;
  app?: { slug?: string; name?: string } | null;
  status: "queued" | "in_progress" | "completed" | string;
  conclusion: "success" | "failure" | "neutral" | "cancelled" | "timed_out" | "action_required" | "skipped" | "stale" | null;
}

interface CheckRunsResponse {
  total_count?: number;
  check_runs?: CheckRun[];
}

/**
 * A single commit status as GitHub returns it from `/repos/:owner/:repo/
 * commits/:sha/status`. Vercel writes deploy state via the LEGACY commit
 * statuses API (not check-runs), so we must query both endpoints to see
 * Vercel deployments. (Live-caught on eventbadge PR #50: deployment was
 * "failure" via commit status but check-runs showed nothing → fetchDeployStatus
 * returned "unknown" → review-finished card said "deploy: unknown" instead
 * of "deploy: failure".)
 */
interface CommitStatus {
  context?: string;
  state?: "success" | "failure" | "pending" | "error" | string;
  description?: string;
  target_url?: string;
}

interface CombinedStatusResponse {
  state?: "success" | "failure" | "pending" | string;
  statuses?: CommitStatus[];
  total_count?: number;
}

function isDeployStatus(s: CommitStatus): boolean {
  const hay = [s.context, s.description].filter(Boolean).join(" ").toLowerCase();
  if (!hay) return false;
  return /(vercel|netlify|cloudflare|cf-pages|railway|render|fly\.io|deploy|preview)/.test(hay);
}

/**
 * Heuristic that identifies a check-run as "a deploy" — Vercel, Netlify,
 * Cloudflare Pages, Railway, Render, Fly.io, generic "Deploy" / "Preview".
 * We don't care who owns it; if the check is named or produced by a
 * deploy-flavoured app we treat it as a deploy signal. Missing entirely
 * → `unknown`, not `success`.
 */
function isDeployCheck(run: CheckRun): boolean {
  const hay = [run.app?.slug, run.app?.name, run.name].filter(Boolean).join(" ").toLowerCase();
  if (!hay) return false;
  return /(vercel|netlify|cloudflare|cf-pages|railway|render|fly\.io|deploy|preview)/.test(hay);
}

/**
 * Read the deploy status for a given commit sha. Uses `gh api` so the
 * caller's existing GitHub auth flows through (the same pattern
 * fetchPrState uses — no new token needed).
 *
 *   success  — at least one deploy-flavoured check run completed with
 *              conclusion=success AND no deploy check is failure/timed_out
 *   failure  — at least one deploy-flavoured check run completed with
 *              conclusion=failure / timed_out / cancelled / action_required
 *   pending  — deploy checks exist but none are in a terminal state yet
 *   unknown  — no deploy-flavoured check found at this sha
 */
export async function fetchDeployStatus(
  repo: string,
  sha: string,
  deps: { run?: GhRunner } = {},
): Promise<DeployStatus> {
  const run = deps.run ?? defaultRunner;
  // Probe BOTH check-runs (Cloudflare Pages, GitHub-app deploys) AND
  // commit statuses (Vercel, Netlify legacy). Vercel writes only to
  // the legacy commit-statuses API; check-runs alone returns "unknown"
  // for Vercel-deployed repos. Live-caught on eventbadge PR #50.
  const checkRunResult = await fetchCheckRunDeployStatus(repo, sha, run);
  const commitStatusResult = await fetchCommitStatusDeployStatus(repo, sha, run);
  return combineDeployStatus(checkRunResult, commitStatusResult);
}

async function fetchCheckRunDeployStatus(
  repo: string,
  sha: string,
  run: GhRunner,
): Promise<DeployStatus> {
  try {
    const { stdout } = await run("gh", [
      "api",
      `repos/${repo}/commits/${sha}/check-runs`,
      "--paginate",
    ]);
    const parsed = JSON.parse(stdout) as CheckRunsResponse | CheckRunsResponse[];
    const allRuns: CheckRun[] = Array.isArray(parsed)
      ? parsed.flatMap((p) => p.check_runs ?? [])
      : parsed.check_runs ?? [];
    const deployRuns = allRuns.filter(isDeployCheck);
    if (deployRuns.length === 0) return "unknown";
    const anyFailure = deployRuns.some(
      (r) =>
        r.status === "completed" &&
        (r.conclusion === "failure" || r.conclusion === "timed_out" || r.conclusion === "cancelled" || r.conclusion === "action_required"),
    );
    if (anyFailure) return "failure";
    const allCompleted = deployRuns.every((r) => r.status === "completed");
    if (!allCompleted) return "pending";
    const anySuccess = deployRuns.some((r) => r.conclusion === "success");
    return anySuccess ? "success" : "unknown";
  } catch {
    return "unknown";
  }
}

async function fetchCommitStatusDeployStatus(
  repo: string,
  sha: string,
  run: GhRunner,
): Promise<DeployStatus> {
  try {
    const { stdout } = await run("gh", [
      "api",
      `repos/${repo}/commits/${sha}/status`,
    ]);
    const parsed = JSON.parse(stdout) as CombinedStatusResponse;
    const statuses = (parsed.statuses ?? []).filter(isDeployStatus);
    if (statuses.length === 0) return "unknown";
    const anyFailure = statuses.some((s) => s.state === "failure" || s.state === "error");
    if (anyFailure) return "failure";
    const anyPending = statuses.some((s) => s.state === "pending");
    if (anyPending) return "pending";
    const anySuccess = statuses.some((s) => s.state === "success");
    return anySuccess ? "success" : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Combine signals from check-runs and commit-statuses. Failure dominates
 * (any failure → failure). Pending wins over success when both have signal
 * (a partial deploy isn't fully green). When one source is unknown, take
 * the other.
 */
function combineDeployStatus(a: DeployStatus, b: DeployStatus): DeployStatus {
  if (a === "failure" || b === "failure") return "failure";
  if (a === "pending" || b === "pending") return "pending";
  if (a === "success" || b === "success") return "success";
  return "unknown";
}
