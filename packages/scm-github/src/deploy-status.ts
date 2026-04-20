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
  try {
    const { stdout } = await run("gh", [
      "api",
      `repos/${repo}/commits/${sha}/check-runs`,
      "--paginate",
    ]);
    const parsed = JSON.parse(stdout) as CheckRunsResponse | CheckRunsResponse[];
    // --paginate may return an array of response pages; flatten
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
