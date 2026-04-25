import { loadRepos, type ReposEntry } from "../lib/repos-config.js";
import {
  diffPolls,
  dispatchReviewWorkflow,
  pollOpenPrs,
  type PollerDeps,
  type PullRequestSnapshot,
} from "../lib/notification-poller.js";

/**
 * v0.12 — `conclave watch` local daemon.
 *
 * Polls every repo on the watch list at a configurable cadence;
 * dispatches `conclave-review.yml` (configurable workflow name) on
 * GitHub Actions when a NEW PR appears or an EXISTING PR's head SHA
 * changes (a force-push or new commit).
 *
 * Why a local daemon and not a GitHub App: the App option is the right
 * long-term answer for hands-off multi-repo coverage, but it's a 2–3
 * week build. The daemon is a one-week MVP that gives Bae the
 * "hands-off after one PR" experience NOW; the App work continues in
 * parallel and ships as v0.12.1.
 *
 * Failure posture:
 *   - One repo's poll failing logs + continues — other repos still
 *     get polled this cycle.
 *   - One PR's dispatch failing logs + continues — other PRs in the
 *     same cycle still get dispatched.
 *   - SIGINT cleanly drains the in-flight poll cycle and exits 0.
 */

const HELP = `conclave watch — multi-repo PR watcher (v0.12)

Usage:
  conclave watch [--interval <seconds>] [--workflow <yml>] [--once]
                 [--include-drafts] [--include-bots]

Options:
  --interval <s>      Polling cadence in seconds. Default 30, min 5.
                      Per-repo overrides live in repos.json.
  --workflow <yml>    Workflow file to dispatch on each detected PR.
                      Default: conclave-review.yml.
  --once              Run a single poll cycle and exit. Useful for cron
                      mode and CI-side smoke tests.
  --include-drafts    Dispatch on draft PRs (default: skip them).
  --include-bots      Dispatch on bot-authored PRs (default: skip
                      dependabot/renovate/copilot).

The watch list is managed via \`conclave repos\`:
  conclave repos add owner/name
  conclave repos list
  conclave repos remove owner/name

Press Ctrl-C to stop. The current poll cycle drains before exit.
`;

export interface WatchArgs {
  intervalSec: number;
  workflow: string;
  once: boolean;
  includeDrafts: boolean;
  includeBots: boolean;
  help: boolean;
}

const DEFAULT_INTERVAL_SEC = 30;
const MIN_INTERVAL_SEC = 5;
const DEFAULT_WORKFLOW = "conclave-review.yml";
const BOT_LOGIN_RE = /^(dependabot(?:\[bot\])?|renovate(?:\[bot\])?|github-copilot(?:\[bot\])?|conclave-autofix\[bot\])$/i;

export function parseWatchArgv(argv: string[]): WatchArgs | { error: string } {
  const out: WatchArgs = {
    intervalSec: DEFAULT_INTERVAL_SEC,
    workflow: DEFAULT_WORKFLOW,
    once: false,
    includeDrafts: false,
    includeBots: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      out.help = true;
    } else if (a === "--once") {
      out.once = true;
    } else if (a === "--include-drafts") {
      out.includeDrafts = true;
    } else if (a === "--include-bots") {
      out.includeBots = true;
    } else if (a === "--interval" && argv[i + 1]) {
      const n = Number(argv[i + 1]);
      if (!Number.isFinite(n) || n < MIN_INTERVAL_SEC) {
        return { error: `--interval: expected integer ≥ ${MIN_INTERVAL_SEC} seconds` };
      }
      out.intervalSec = Math.max(MIN_INTERVAL_SEC, Math.floor(n));
      i += 1;
    } else if (a === "--workflow" && argv[i + 1]) {
      out.workflow = argv[i + 1] as string;
      i += 1;
    } else {
      return { error: `unknown arg: ${a}. Run 'conclave watch --help' for usage.` };
    }
  }
  return out;
}

export interface WatchDeps extends PollerDeps {
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  loadReposFn?: typeof loadRepos;
  pollFn?: typeof pollOpenPrs;
  dispatchFn?: typeof dispatchReviewWorkflow;
  /** Test seam — sleep returns a controllable promise. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam — when set, the loop exits after this many cycles even
   * if `--once` was not passed. */
  maxCycles?: number;
  /** Test seam — controls SIGINT-style cooperative exit. */
  shouldExit?: () => boolean;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function shouldDispatch(
  pr: PullRequestSnapshot,
  args: WatchArgs,
): { fire: true } | { fire: false; reason: string } {
  if (pr.draft && !args.includeDrafts) {
    return { fire: false, reason: "draft (use --include-drafts to dispatch)" };
  }
  if (BOT_LOGIN_RE.test(pr.authorLogin) && !args.includeBots) {
    return { fire: false, reason: `bot author '${pr.authorLogin}' (use --include-bots to dispatch)` };
  }
  return { fire: true };
}

/**
 * v0.12 — entry-point wrapper invoked by `index.ts`'s router. Parses
 * argv, dispatches to `runWatch`, and translates the numeric result
 * into a process.exit.
 */
export async function watch(argv: string[]): Promise<void> {
  const parsed = parseWatchArgv(argv);
  if ("error" in parsed) {
    process.stderr.write(`conclave watch: ${parsed.error}\n`);
    process.exit(2);
  }
  const { code } = await runWatch(parsed);
  if (code !== 0) process.exit(code);
}

export async function runWatch(
  args: WatchArgs,
  deps: WatchDeps = {},
): Promise<{ code: number; cycles: number }> {
  const stdout = deps.stdout ?? ((s) => process.stdout.write(s));
  const stderr = deps.stderr ?? ((s) => process.stderr.write(s));
  const loadFn = deps.loadReposFn ?? loadRepos;
  const pollFn = deps.pollFn ?? pollOpenPrs;
  const dispatchFn = deps.dispatchFn ?? dispatchReviewWorkflow;
  const sleep = deps.sleep ?? defaultSleep;
  const shouldExit = deps.shouldExit ?? (() => false);
  const maxCycles = typeof deps.maxCycles === "number" ? deps.maxCycles : Infinity;

  if (args.help) {
    stdout(HELP);
    return { code: 0, cycles: 0 };
  }

  const reposCfg = loadFn();
  if (reposCfg.repos.length === 0) {
    stderr(
      "conclave watch: watch list is empty. Add at least one repo with `conclave repos add owner/name`.\n",
    );
    return { code: 2, cycles: 0 };
  }

  // SIGINT handling — flip a flag, current cycle drains, loop exits 0.
  let interrupted = false;
  const onSigint = () => {
    if (!interrupted) {
      stderr("conclave watch: SIGINT received — draining current cycle, then exiting...\n");
      interrupted = true;
    }
  };
  process.once("SIGINT", onSigint);

  // Snapshot store — keyed by `${slug}#${number}`. Survives across
  // cycles; not persisted to disk (resumability is not a v0.12 goal,
  // and the trade is a small re-fire on daemon restart).
  const seen = new Map<string, PullRequestSnapshot>();

  stdout(
    `conclave watch: ${reposCfg.repos.length} repo(s) on watch list, polling every ${args.intervalSec}s, dispatching '${args.workflow}'\n`,
  );

  let cycles = 0;
  let cycleCode = 0;
  while (!interrupted && !shouldExit() && cycles < maxCycles) {
    cycles += 1;
    const startedAt = new Date().toISOString();
    stdout(`conclave watch: cycle ${cycles} starting (${startedAt})\n`);

    let totalDispatched = 0;
    let totalSkipped = 0;
    let totalErrors = 0;
    for (const repo of reposCfg.repos) {
      try {
        const current = await pollFn(repo.slug, deps);
        // For the diff we only care about THIS repo's PRs — splice out
        // the prior snapshot subset.
        const prevForRepo = new Map<string, PullRequestSnapshot>();
        for (const [k, v] of seen.entries()) {
          if (v.repoSlug === repo.slug) prevForRepo.set(k, v);
        }
        const diff = diffPolls(prevForRepo, current);
        for (const pr of [...diff.newPrs, ...diff.updated]) {
          const decision = shouldDispatch(pr, args);
          if (!decision.fire) {
            stdout(
              `conclave watch:   ${pr.repoSlug}#${pr.number} skip — ${decision.reason}\n`,
            );
            totalSkipped += 1;
            continue;
          }
          try {
            await dispatchFn(pr, args.workflow, deps);
            const verb = diff.newPrs.includes(pr) ? "new" : "updated";
            stdout(
              `conclave watch:   ${pr.repoSlug}#${pr.number} dispatched (${verb}, sha=${pr.headSha.slice(0, 7)}, by ${pr.authorLogin})\n`,
            );
            totalDispatched += 1;
          } catch (err) {
            stderr(
              `conclave watch:   ${pr.repoSlug}#${pr.number} dispatch failed — ${(err as Error).message}\n`,
            );
            totalErrors += 1;
          }
        }
        // Update seen-set: insert/refresh current; drop closed.
        for (const cur of current) {
          seen.set(`${cur.repoSlug}#${cur.number}`, cur);
        }
        for (const k of diff.closed) {
          seen.delete(k);
        }
      } catch (err) {
        stderr(
          `conclave watch:   ${repo.slug} poll failed — ${(err as Error).message}\n`,
        );
        totalErrors += 1;
      }
    }
    stdout(
      `conclave watch: cycle ${cycles} done (dispatched=${totalDispatched}, skipped=${totalSkipped}, errors=${totalErrors})\n`,
    );

    if (args.once || cycles >= maxCycles) break;
    if (interrupted || shouldExit()) break;
    await sleep(args.intervalSec * 1000);
  }

  process.removeListener("SIGINT", onSigint);
  stdout(`conclave watch: ran ${cycles} cycle(s), exiting\n`);
  return { code: cycleCode, cycles };
}

/**
 * v0.12 — per-repo cadence override hook. Currently a placeholder —
 * v0.12.0 polls every repo on the SAME cadence. Per-repo cadence lands
 * as a v0.12.x follow-up where a busy repo polls every 30s and a quiet
 * one every 600s.
 */
export function effectiveInterval(repo: ReposEntry, defaultSec: number): number {
  return repo.pollIntervalSec ?? defaultSec;
}
