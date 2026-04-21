import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";
import {
  BudgetTracker,
  CircuitBreaker,
  CircuitOpenError,
  EfficiencyGate,
  FileSystemMemoryStore,
  LoopDetectedError,
  LoopGuard,
  MetricsRecorder,
  OutcomeWriter,
  dedupeBlockersAcrossAgents,
  summarizeAutofixPatches,
  type AutofixIteration,
  type AutofixResult,
  type AutofixResultStatus,
  type Blocker,
  type BlockerFix,
  type EpisodicEntry,
  type MemoryStore,
  type ReviewResult,
} from "@conclave-ai/core";
import {
  ClaudeWorker,
  type ClaudeWorkerOptions,
  type WorkerOutcome,
  type WorkerContext,
} from "@conclave-ai/agent-worker";
import { formatFinding, scanPatch, type ScanResult } from "@conclave-ai/secret-guard";
import { fetchPrState, type GhRunner, type PullRequestState } from "@conclave-ai/scm-github";
import { loadConfig, resolveMemoryRoot, type ConclaveConfig } from "../lib/config.js";
import { runPerBlocker, type GitLike, type WorkerLike } from "../lib/autofix-worker.js";
import {
  detectCommand,
  runCommand,
  summarizeFailure,
  verify,
  type BuildResult,
  type VerifierDeps,
} from "../lib/build-verifier.js";

const execFile = promisify(execFileCallback);

const HELP = `conclave autofix — autonomous fix loop for council blockers (v0.7)

Usage:
  conclave autofix [--pr N] [--verdict <file>] [--budget <usd>] [--max-iterations N]
                   [--build-cmd <cmd>] [--test-cmd <cmd>] [--autonomy l2|l3]
                   [--cwd <dir>] [--dry-run]

Options:
  --pr N                Pull-request number (default: current branch's open PR).
  --verdict <file>      Pre-existing Council verdict JSON (skip re-running review).
  --budget <usd>        Hard cap on LLM spend. Default 3, MAX 10.
  --max-iterations N    Max fix→build→review cycles. Default 2, hard max 3.
  --build-cmd <cmd>     Explicit build command (default: auto-detect).
  --test-cmd <cmd>      Explicit test command (default: auto-detect).
  --autonomy l2|l3      l2 (default) — commits fixes, awaits Bae approval.
                        l3 — auto-merges when final verdict is approve.
  --cwd <dir>           Working directory — must be checked out to the PR branch. Default '.'.
  --dry-run             Show which patches would apply; do not touch the filesystem.
  --allow-secret <id>   Allow-list a secret-guard rule id (repeatable).
  --skip-secret-guard   Disable the pre-apply secret scan (strongly discouraged).

Safety rails (all mandatory):
  - LoopGuard (per repo#pr:sha, 5 attempts / 1h window — inherited from v0.4).
  - CircuitBreaker (3 consecutive worker errors trip the circuit).
  - Secret-guard scan runs on every patch before apply (see @conclave-ai/secret-guard).
  - File deny-list: .env* / *.pem / *.key / *secret* / *.credentials*.
  - Diff budget: 500 lines total across all patches per iteration. Tripping STOPS the loop.
  - Tests MUST pass before commit; failures revert the staged changes.
  - Hard max: 3 iterations, $10 budget. No --force override.

Environment:
  ANTHROPIC_API_KEY     required — the worker uses Claude.
`;

export interface AutofixArgs {
  pr?: number;
  verdictFile?: string;
  budgetUsd: number;
  maxIterations: number;
  buildCmd?: string;
  testCmd?: string;
  autonomy: "l2" | "l3";
  cwd: string;
  dryRun: boolean;
  help: boolean;
  allowSecrets: string[];
  skipSecretGuard: boolean;
}

export const HARD_MAX_ITERATIONS = 3;
export const HARD_MAX_BUDGET_USD = 10;
export const DIFF_BUDGET_LINES = 500;
export const DEFAULT_BUDGET_USD = 3;
export const DEFAULT_MAX_ITERATIONS = 2;

export function parseArgv(argv: string[]): AutofixArgs {
  const out: AutofixArgs = {
    budgetUsd: DEFAULT_BUDGET_USD,
    maxIterations: DEFAULT_MAX_ITERATIONS,
    autonomy: "l2",
    cwd: ".",
    dryRun: false,
    help: false,
    allowSecrets: [],
    skipSecretGuard: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--skip-secret-guard") out.skipSecretGuard = true;
    else if (a === "--pr" && argv[i + 1]) {
      const n = Number.parseInt(argv[i + 1]!, 10);
      if (!Number.isNaN(n)) out.pr = n;
      i += 1;
    } else if (a === "--verdict" && argv[i + 1]) {
      out.verdictFile = argv[i + 1];
      i += 1;
    } else if (a === "--budget" && argv[i + 1]) {
      const v = Number.parseFloat(argv[i + 1]!);
      if (!Number.isNaN(v) && v > 0) {
        out.budgetUsd = Math.min(v, HARD_MAX_BUDGET_USD);
      }
      i += 1;
    } else if (a === "--max-iterations" && argv[i + 1]) {
      const n = Number.parseInt(argv[i + 1]!, 10);
      if (!Number.isNaN(n) && n > 0) {
        out.maxIterations = Math.min(n, HARD_MAX_ITERATIONS);
      }
      i += 1;
    } else if (a === "--build-cmd" && argv[i + 1]) {
      out.buildCmd = argv[i + 1];
      i += 1;
    } else if (a === "--test-cmd" && argv[i + 1]) {
      out.testCmd = argv[i + 1];
      i += 1;
    } else if (a === "--autonomy" && argv[i + 1]) {
      const v = argv[i + 1];
      if (v === "l2" || v === "l3") out.autonomy = v;
      i += 1;
    } else if (a === "--cwd" && argv[i + 1]) {
      out.cwd = argv[i + 1]!;
      i += 1;
    } else if (a === "--allow-secret" && argv[i + 1]) {
      out.allowSecrets.push(argv[i + 1]!);
      i += 1;
    }
  }
  return out;
}

export interface AutofixDeps {
  loadConfig?: () => Promise<{ config: ConclaveConfig; configDir: string }>;
  store?: MemoryStore;
  writer?: OutcomeWriter;
  /** Injected worker (tests). */
  worker?: WorkerLike;
  /** Factory used when `worker` is not given (real ClaudeWorker). */
  workerFactory?: (opts: ClaudeWorkerOptions) => WorkerLike;
  /** gh runner. */
  gh?: GhRunner;
  /** git runner — same contract as rework.ts for consistency. */
  git?: GitLike;
  /** Read a file for the per-blocker snapshot. */
  readFile?: (absPath: string) => Promise<string>;
  /** Load verdict JSON from disk. */
  readVerdictFile?: (absPath: string) => Promise<string>;
  /** Temp-patch helpers for per-blocker validation. */
  writeTempPatch?: (absPath: string, contents: string) => Promise<void>;
  removeTempPatch?: (absPath: string) => Promise<void>;
  /** Secret-guard scanner override. */
  secretScan?: (patch: string, opts?: { allow?: readonly string[] }) => ScanResult;
  /** Build / test runners. */
  verifier?: {
    build: (cwd: string, explicit?: string) => Promise<BuildResult | null>;
    test: (cwd: string, explicit?: string) => Promise<BuildResult | null>;
  };
  /** Run `conclave review --pr N` and return the verdict. Tests inject a stub. */
  runReview?: (input: {
    prNumber: number;
    cwd: string;
  }) => Promise<{ verdict: "approve" | "rework" | "reject"; reviews: ReviewResult[] }>;
  /** Run `gh pr merge`. Tests inject a stub. */
  mergePr?: (prNumber: number, cwd: string) => Promise<void>;
  /** Stdout / stderr sinks. */
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  /** Safety guards. */
  loopGuard?: LoopGuard;
  breaker?: CircuitBreaker;
}

const defaultGit: GitLike = async (bin, args, opts) => {
  try {
    const { stdout, stderr } = await execFile(bin, args as string[], {
      ...(opts?.cwd ? { cwd: opts.cwd } : {}),
      ...(opts?.input ? { input: opts.input } : {}),
      ...(opts?.timeout ? { timeout: opts.timeout } : {}),
      maxBuffer: 20 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    throw Object.assign(new Error(`${bin} ${args.join(" ")} failed: ${e.stderr ?? e.message}`), {
      stdout: e.stdout ?? "",
      stderr: e.stderr,
      code: e.code,
    });
  }
};

const defaultGh: GhRunner = async (bin, args, opts) => {
  const { stdout, stderr } = await execFile(bin, args as string[], {
    ...opts,
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout, stderr };
};

/**
 * Parse a verdict JSON file. Accepts either an episodic-entry shape
 * (what `conclave review` persists) or a standalone `{ verdict, reviews }`
 * payload. Throws on malformed input.
 */
export function parseVerdictFile(raw: string): { verdict: "approve" | "rework" | "reject"; reviews: ReviewResult[] } {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("verdict file is not a JSON object");
  }
  const p = parsed as {
    verdict?: string;
    councilVerdict?: string;
    reviews?: ReviewResult[];
  };
  const verdict = (p.councilVerdict ?? p.verdict) as "approve" | "rework" | "reject" | undefined;
  if (!verdict || !["approve", "rework", "reject"].includes(verdict)) {
    throw new Error("verdict file missing 'verdict' / 'councilVerdict' field");
  }
  if (!Array.isArray(p.reviews)) {
    throw new Error("verdict file missing 'reviews' array");
  }
  return { verdict, reviews: p.reviews };
}

export async function runAutofix(args: AutofixArgs, deps: AutofixDeps = {}): Promise<{ code: number; result: AutofixResult }> {
  const stdout = deps.stdout ?? ((s) => process.stdout.write(s));
  const stderr = deps.stderr ?? ((s) => process.stderr.write(s));

  // Clamp — even if parseArgv let something weird through.
  args.maxIterations = Math.min(Math.max(1, args.maxIterations), HARD_MAX_ITERATIONS);
  args.budgetUsd = Math.min(Math.max(0.01, args.budgetUsd), HARD_MAX_BUDGET_USD);

  const loadCfg = deps.loadConfig ?? loadConfig;
  const cfg = await loadCfg();
  const git = deps.git ?? defaultGit;
  const gh = deps.gh ?? defaultGh;
  const readVerdict = deps.readVerdictFile ?? ((p: string) => fs.readFile(p, "utf8"));

  // --- 1. Resolve PR + initial verdict ------------------------------------
  let prNumber = args.pr;
  let repo: string | undefined;
  let headSha: string | undefined;
  let initialReviews: ReviewResult[] = [];
  let initialVerdict: "approve" | "rework" | "reject" | undefined;

  if (args.verdictFile) {
    const raw = await readVerdict(args.verdictFile);
    const parsed = parseVerdictFile(raw);
    initialReviews = parsed.reviews;
    initialVerdict = parsed.verdict;
    // Episodic shape also carries repo / pullNumber / sha.
    try {
      const ep = JSON.parse(raw) as Partial<EpisodicEntry>;
      if (!prNumber && typeof ep.pullNumber === "number") prNumber = ep.pullNumber;
      if (typeof ep.repo === "string") repo = ep.repo;
      if (typeof ep.sha === "string") headSha = ep.sha;
    } catch { /* best-effort */ }
  }

  if (!prNumber) {
    stderr(`autofix: --pr is required when --verdict does not carry pullNumber\n`);
    return {
      code: 2,
      result: bailResult("bailed-no-patches", "no PR number resolved", []),
    };
  }

  if (!repo || !headSha) {
    const prState: PullRequestState = await fetchPrState("", prNumber, { run: gh }).catch(async () => {
      // Fall back to `gh pr view N` against the current repo.
      const { stdout: out } = await gh("gh", ["pr", "view", String(prNumber), "--json", "state,headRefOid,updatedAt,headRepository,headRepositoryOwner"]);
      const view = JSON.parse(out) as {
        state?: string;
        headRefOid?: string;
        updatedAt?: string;
        headRepository?: { name?: string };
        headRepositoryOwner?: { login?: string };
      };
      const rName = view.headRepository?.name ?? "";
      const rOwner = view.headRepositoryOwner?.login ?? "";
      return {
        repo: rOwner && rName ? `${rOwner}/${rName}` : repo ?? "unknown/unknown",
        prNumber,
        state: (view.state?.toLowerCase() ?? "open") as "open" | "merged" | "closed",
        headSha: view.headRefOid ?? "",
        updatedAt: view.updatedAt ?? new Date().toISOString(),
      };
    });
    if (prState.state !== "open") {
      stderr(`autofix: PR #${prNumber} is ${prState.state}, not open — nothing to autofix\n`);
      return {
        code: 1,
        result: bailResult("bailed-no-patches", `pr is ${prState.state}`, []),
      };
    }
    repo = repo ?? prState.repo;
    headSha = headSha ?? prState.headSha;
  }

  // --- 2. Safety guards ---------------------------------------------------
  const loopGuard = deps.loopGuard ?? new LoopGuard({ threshold: 5, windowMs: 60 * 60_000 });
  const breaker = deps.breaker ?? new CircuitBreaker({ failureThreshold: 3 });
  const loopKey = `autofix:${repo}#${prNumber}:${headSha}`;
  try {
    loopGuard.check(loopKey);
  } catch (err) {
    if (err instanceof LoopDetectedError) {
      stderr(`autofix: loop guard tripped on ${loopKey} (${err.count} attempts) — human needed\n`);
      return { code: 2, result: bailResult("bailed-loop-guard", `loop guard: ${err.count} attempts`, []) };
    }
    throw err;
  }

  // --- 3. If no verdict given, run review first --------------------------
  if (initialVerdict === undefined) {
    if (!deps.runReview) {
      stderr(`autofix: --verdict required when no runReview runner is injected (would need to spawn 'conclave review' subprocess in production)\n`);
      // In production we'd shell out to `conclave review --pr N --json`
      // here. For v0.7 we document --verdict as the supported path and
      // keep the subprocess spawn out of the test matrix.
      return {
        code: 2,
        result: bailResult("bailed-no-patches", "no verdict; pass --verdict <file>", []),
      };
    }
    const reviewed = await deps.runReview({ prNumber, cwd: args.cwd });
    initialReviews = reviewed.reviews;
    initialVerdict = reviewed.verdict;
  }

  if (initialVerdict === "approve") {
    stdout(`autofix: council already approves — nothing to fix\n`);
    return {
      code: 0,
      result: {
        status: "approved",
        iterations: [],
        totalCostUsd: 0,
        finalVerdict: "approve",
        remainingBlockers: [],
        mergeStatus: "not-merged",
      },
    };
  }

  // --- 4. The loop --------------------------------------------------------
  const worker = deps.worker ?? buildWorker(deps, cfg.config);
  const iterations: AutofixIteration[] = [];
  let totalCost = 0;
  let currentReviews = initialReviews;
  let finalVerdict: "approve" | "rework" | "reject" = initialVerdict;

  for (let i = 0; i < args.maxIterations; i += 1) {
    // v0.7 — collect unique (agent, blocker) pairs across the council.
    const targets = dedupeBlockersAcrossAgents(currentReviews);
    if (targets.length === 0) {
      stdout(`autofix: no blockers this iteration — exiting loop\n`);
      break;
    }

    const fixes: BlockerFix[] = [];
    let previousBuildErrorTail: string | undefined;
    const prevIter = iterations[iterations.length - 1];
    if (prevIter && !prevIter.verified && (prevIter.buildOk === false || prevIter.testsOk === false)) {
      // Fed back into the next iteration so the worker sees what broke.
      previousBuildErrorTail = prevIter.notes.find((n) => n.startsWith("failure:"))?.slice("failure:".length).trim();
    }

    // --- Per-blocker worker invocations ---------------------------------
    for (const t of targets) {
      // Budget early-exit — never burn past the cap.
      if (totalCost >= args.budgetUsd) {
        stdout(`autofix: budget ($${args.budgetUsd}) hit mid-iteration — finishing early\n`);
        break;
      }
      let bfix: BlockerFix;
      try {
        bfix = await breaker.guard("worker", () =>
          runPerBlocker(
            {
              repo: repo!,
              pullNumber: prNumber!,
              newSha: headSha!,
              agent: t.agent,
              blocker: t.blocker,
              ...(previousBuildErrorTail ? { buildErrorTail: previousBuildErrorTail } : {}),
            },
            {
              worker,
              git,
              cwd: args.cwd,
              ...(deps.readFile ? { readFile: deps.readFile } : {}),
              ...(deps.writeTempPatch ? { writeTempPatch: deps.writeTempPatch } : {}),
              ...(deps.removeTempPatch ? { removeTempPatch: deps.removeTempPatch } : {}),
            },
          ),
        );
      } catch (err) {
        if (err instanceof CircuitOpenError) {
          stderr(`autofix: circuit breaker open (until ${new Date(err.openUntil).toISOString()}) — aborting\n`);
          iterations.push(finalizeIteration(i, fixes, false, [`circuit:${err.provider}`]));
          const itTotal = fixes.reduce((n, f) => n + (f.costUsd ?? 0), 0);
          totalCost += itTotal;
          return {
            code: 2,
            result: {
              status: "bailed-circuit",
              iterations,
              totalCostUsd: totalCost,
              finalVerdict,
              remainingBlockers: remainingBlockersFrom(currentReviews),
              mergeStatus: "not-merged",
              reason: err.message,
            },
          };
        }
        throw err;
      }
      fixes.push(bfix);
      totalCost += bfix.costUsd ?? 0;
    }

    // --- Secret-guard + file-deny already applied per-patch. Now run
    //     one final secret scan across ALL ready patches for belt-and-
    //     suspenders (a multi-patch combo could sneak through).
    const readyFixes = fixes.filter((f) => f.status === "ready" && f.patch);
    if (!args.skipSecretGuard) {
      const scanner = deps.secretScan ?? scanPatch;
      for (const rf of readyFixes) {
        const scan = scanner(rf.patch!, { allow: args.allowSecrets });
        if (scan.blocked) {
          rf.status = "secret-block";
          rf.reason = `secret-guard blocked: ${scan.findings.map((f) => formatFinding(f)).join("; ")}`;
        }
      }
    }
    const stillReady = fixes.filter((f) => f.status === "ready" && f.patch);

    // --- Diff-budget guard ---------------------------------------------
    const patches = stillReady.map((f) => f.patch!);
    const summary = summarizeAutofixPatches(patches);
    if (summary.totalLines > DIFF_BUDGET_LINES) {
      stderr(
        `autofix: diff budget exceeded — ${summary.totalLines} lines across ${summary.totalFiles} files (limit ${DIFF_BUDGET_LINES}). Stopping for human review.\n`,
      );
      iterations.push(finalizeIteration(i, fixes, false, [`diff-budget:${summary.totalLines}`]));
      return {
        code: 2,
        result: {
          status: "bailed-diff-budget",
          iterations,
          totalCostUsd: totalCost,
          finalVerdict,
          remainingBlockers: remainingBlockersFrom(currentReviews),
          mergeStatus: "not-merged",
          reason: `diff too large (${summary.totalLines} lines)`,
        },
      };
    }

    // --- Dry-run: print + exit -----------------------------------------
    if (args.dryRun) {
      stdout(`autofix[dry-run]: ${stillReady.length} patches would apply (${summary.totalLines} lines, ${summary.totalFiles} files)\n`);
      for (const rf of stillReady) {
        stdout(`--- ${rf.blocker.file ?? "(unscoped)"} — ${rf.blocker.category} ---\n${rf.patch}\n`);
      }
      const nonReady = fixes.filter((f) => f.status !== "ready");
      for (const nr of nonReady) {
        stdout(`[skipped] ${nr.blocker.category} (${nr.blocker.file ?? "unscoped"}): ${nr.status} — ${nr.reason ?? ""}\n`);
      }
      iterations.push(finalizeIteration(i, fixes, false, ["dry-run"]));
      return {
        code: 0,
        result: {
          status: "dry-run",
          iterations,
          totalCostUsd: totalCost,
          finalVerdict,
          remainingBlockers: remainingBlockersFrom(currentReviews),
          mergeStatus: "not-merged",
        },
      };
    }

    if (stillReady.length === 0) {
      stderr(`autofix: no applicable patches this iteration (all blockers skipped/conflict) — stopping\n`);
      iterations.push(finalizeIteration(i, fixes, false, ["no-ready-patches"]));
      return {
        code: 1,
        result: {
          status: "bailed-no-patches",
          iterations,
          totalCostUsd: totalCost,
          finalVerdict,
          remainingBlockers: remainingBlockersFrom(currentReviews),
          mergeStatus: "not-merged",
        },
      };
    }

    // --- Apply patches sequentially ------------------------------------
    //     Each patch runs through `git apply --recount` (already validated
    //     individually). If a later patch conflicts after earlier ones
    //     landed, we ROLLBACK the whole staging area and bail — partial
    //     autofix is worse than no autofix.
    const appliedPaths: string[] = [];
    let applyFailed = false;
    for (const rf of stillReady) {
      const tempPath = path.join(args.cwd, `.conclave-autofix-apply-${shortId()}.patch`);
      await fs.writeFile(tempPath, rf.patch!, "utf8").catch(() => undefined);
      try {
        // re-check then apply (files may have shifted after earlier patches).
        await git("git", ["apply", "--check", "--recount", tempPath], { cwd: args.cwd });
        await git("git", ["apply", "--recount", tempPath], { cwd: args.cwd });
        appliedPaths.push(...(rf.appliedFiles ?? []));
      } catch (err) {
        // Mark THIS fix as conflict and bail the iteration. Stage gets
        // reset below.
        rf.status = "conflict";
        rf.reason = err instanceof Error ? err.message : String(err);
        applyFailed = true;
        break;
      } finally {
        await fs.unlink(tempPath).catch(() => undefined);
      }
    }

    if (applyFailed) {
      // Roll back: hard reset working tree to HEAD. We do NOT touch the
      // commit graph — only the index + worktree.
      await git("git", ["reset", "--hard", "HEAD"], { cwd: args.cwd }).catch(() => undefined);
      stderr(`autofix: apply conflict mid-iteration — rolled back staged changes\n`);
      iterations.push(finalizeIteration(i, fixes, false, ["apply-conflict"]));
      return {
        code: 1,
        result: {
          status: "bailed-no-patches",
          iterations,
          totalCostUsd: totalCost,
          finalVerdict,
          remainingBlockers: remainingBlockersFrom(currentReviews),
          mergeStatus: "not-merged",
          reason: "apply-conflict mid-iteration",
        },
      };
    }

    // --- Build verification ---------------------------------------------
    const buildResult = deps.verifier
      ? await deps.verifier.build(args.cwd, args.buildCmd)
      : await verify(args.cwd, "build", { ...(args.buildCmd ? { explicit: args.buildCmd } : {}) });
    const buildOk = buildResult === null ? true : buildResult.success; // null = no detection = trust CI.
    if (buildResult && !buildResult.success) {
      stderr(`autofix: build failed (${buildResult.command}) — reverting\n`);
      await git("git", ["reset", "--hard", "HEAD"], { cwd: args.cwd }).catch(() => undefined);
      const note = `failure: ${summarizeFailure(buildResult)}`;
      iterations.push(
        finalizeIteration(i, fixes, false, [note], {
          buildOk: false,
          buildCommand: buildResult.command,
        }),
      );
      // Feed back into next iteration via previousBuildErrorTail pickup.
      if (i + 1 >= args.maxIterations) {
        return {
          code: 1,
          result: {
            status: "bailed-build-failed",
            iterations,
            totalCostUsd: totalCost,
            finalVerdict,
            remainingBlockers: remainingBlockersFrom(currentReviews),
            mergeStatus: "not-merged",
            reason: "build failed after max iterations",
          },
        };
      }
      continue; // try next iteration with the failure context.
    }

    // --- Test verification ---------------------------------------------
    const testResult = deps.verifier
      ? await deps.verifier.test(args.cwd, args.testCmd)
      : await verify(args.cwd, "test", { ...(args.testCmd ? { explicit: args.testCmd } : {}) });
    const testsOk = testResult === null ? true : testResult.success;
    if (testResult && !testResult.success) {
      stderr(`autofix: tests failed (${testResult.command}) — reverting, will NOT commit\n`);
      await git("git", ["reset", "--hard", "HEAD"], { cwd: args.cwd }).catch(() => undefined);
      const note = `failure: ${summarizeFailure(testResult)}`;
      iterations.push(
        finalizeIteration(i, fixes, false, [note], {
          buildOk: true,
          testsOk: false,
          testCommand: testResult.command,
          ...(buildResult?.command ? { buildCommand: buildResult.command } : {}),
        }),
      );
      if (i + 1 >= args.maxIterations) {
        return {
          code: 1,
          result: {
            status: "bailed-tests-failed",
            iterations,
            totalCostUsd: totalCost,
            finalVerdict,
            remainingBlockers: remainingBlockersFrom(currentReviews),
            mergeStatus: "not-merged",
            reason: "tests failed after max iterations",
          },
        };
      }
      continue;
    }

    // --- Commit ---------------------------------------------------------
    //     Everything passed — stage + commit one consolidated commit per
    //     iteration. The summary line comes from the first fix's
    //     commitMessage or a generic fallback.
    await git("git", ["add", "-A"], { cwd: args.cwd });
    const title = stillReady[0]?.commitMessage ?? `autofix: ${stillReady.length} blockers (conclave-ai)`;
    const body = stillReady.map((f) => `- [${f.blocker.severity}/${f.blocker.category}] ${f.blocker.message}`).join("\n");
    const fullMsg = `${title} (conclave-ai)\n\n${body}`;
    await git(
      "git",
      [
        "-c",
        "user.name=conclave-autofix[bot]",
        "-c",
        "user.email=noreply@conclave.ai",
        "commit",
        "-m",
        fullMsg,
        "--author",
        "conclave-autofix[bot] <noreply@conclave.ai>",
      ],
      { cwd: args.cwd },
    );
    await git("git", ["push"], { cwd: args.cwd }).catch((err) => {
      stderr(`autofix: git push warning — ${err instanceof Error ? err.message : String(err)}\n`);
    });

    iterations.push(
      finalizeIteration(i, fixes, true, [`committed:${stillReady.length}`], {
        buildOk,
        testsOk,
        ...(buildResult?.command ? { buildCommand: buildResult.command } : {}),
        ...(testResult?.command ? { testCommand: testResult.command } : {}),
      }),
    );

    // --- Meta-review ----------------------------------------------------
    if (!deps.runReview) {
      // Production code would spawn `conclave review --pr N --json` here.
      // For v0.7, if no stub runner is wired we STOP after the first
      // successful commit and let the CI re-run review on the pushed
      // commit — the L2/L3 final gate still requires Bae's approval in
      // that path.
      stdout(`autofix: committed — awaiting re-review (no inline runReview dep; CI picks up push)\n`);
      break;
    }
    const meta = await deps.runReview({ prNumber: prNumber!, cwd: args.cwd });
    finalVerdict = meta.verdict;
    currentReviews = meta.reviews;
    if (meta.verdict === "approve") break;
    // else loop continues (if iterations remain).
  }

  // --- 5. Terminal verdict ------------------------------------------------
  const reachedMax = iterations.length >= args.maxIterations && finalVerdict !== "approve";
  let status: AutofixResultStatus;
  let mergeStatus: AutofixResult["mergeStatus"] = "not-merged";
  let code = 0;

  if (finalVerdict === "approve") {
    if (args.autonomy === "l3") {
      try {
        if (deps.mergePr) {
          await deps.mergePr(prNumber!, args.cwd);
        } else {
          await gh("gh", ["pr", "merge", String(prNumber), "--repo", repo!, "--squash"]);
        }
        mergeStatus = "merged";
        status = "approved";
        stdout(`autofix: L3 auto-merged PR #${prNumber}\n`);
      } catch (err) {
        mergeStatus = "merge-failed";
        status = "awaiting-approval";
        code = 1;
        stderr(`autofix: L3 merge failed — ${err instanceof Error ? err.message : String(err)} (falling back to awaiting-approval)\n`);
      }
    } else {
      status = "awaiting-approval";
      stdout(`autofix: complete, awaiting Bae approval (L2)\n`);
    }
  } else if (reachedMax) {
    status = "bailed-max-iterations";
    code = 1;
    stdout(`autofix: bailed after ${iterations.length} iterations — remaining blockers: ${remainingBlockersFrom(currentReviews).length}\n`);
    // Best-effort PR comment.
    try {
      await gh("gh", [
        "pr",
        "comment",
        String(prNumber),
        "--repo",
        repo!,
        "--body",
        `autofix bailed after ${iterations.length} iterations. Remaining blockers:\n${remainingBlockersFrom(currentReviews).slice(0, 10).map((b) => `- [${b.severity}/${b.category}] ${b.message}`).join("\n")}`,
      ]);
    } catch (err) {
      stderr(`autofix: post-bailout comment failed — ${err instanceof Error ? err.message : String(err)}\n`);
    }
  } else if (totalCost >= args.budgetUsd) {
    status = "bailed-budget";
    code = 1;
    stdout(`autofix: budget exhausted at $${totalCost.toFixed(4)}\n`);
  } else {
    // Terminated early without approve — likely mid-loop break with no
    // new blockers but verdict stayed at rework.
    status = iterations.length === 0 ? "bailed-no-patches" : "awaiting-approval";
  }

  return {
    code,
    result: {
      status,
      iterations,
      totalCostUsd: totalCost,
      finalVerdict,
      remainingBlockers: remainingBlockersFrom(currentReviews),
      mergeStatus,
    },
  };
}

function finalizeIteration(
  index: number,
  fixes: BlockerFix[],
  verified: boolean,
  notes: string[],
  extra: Partial<AutofixIteration> = {},
): AutofixIteration {
  const appliedCount = fixes.filter((f) => f.status === "ready").length;
  const costUsd = fixes.reduce((n, f) => n + (f.costUsd ?? 0), 0);
  return {
    index,
    fixes,
    appliedCount,
    verified,
    costUsd,
    notes,
    ...extra,
  };
}

function remainingBlockersFrom(reviews: readonly ReviewResult[]): Blocker[] {
  const out: Blocker[] = [];
  const seen = new Set<string>();
  for (const r of reviews) {
    for (const b of r.blockers) {
      if (b.severity === "nit") continue;
      const key = `${b.category}|${b.file ?? ""}|${b.message.slice(0, 60)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(b);
    }
  }
  return out;
}

function bailResult(status: AutofixResultStatus, reason: string, iterations: AutofixIteration[]): AutofixResult {
  return {
    status,
    iterations,
    totalCostUsd: 0,
    remainingBlockers: [],
    mergeStatus: "not-merged",
    reason,
  };
}

function shortId(): string {
  return Math.random().toString(36).slice(2, 8);
}

function buildWorker(deps: AutofixDeps, config: ConclaveConfig): WorkerLike {
  const perPrUsd = config.budget?.perPrUsd ?? 0.5;
  const gate = new EfficiencyGate({
    budget: new BudgetTracker({ perPrUsd }),
    metrics: new MetricsRecorder(),
  });
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    throw new Error("autofix: ANTHROPIC_API_KEY is not set (the worker agent needs it)");
  }
  const factory = deps.workerFactory ?? ((opts: ClaudeWorkerOptions) => new ClaudeWorker(opts));
  return factory({ apiKey, gate });
}

export async function autofix(argv: string[]): Promise<void> {
  const args = parseArgv(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  const { code } = await runAutofix(args);
  if (code !== 0) process.exit(code);
}

export function renderAutofixSummary(result: AutofixResult, repo: string, prNumber: number): string {
  const lines: string[] = [];
  lines.push(`── conclave autofix — ${repo}#${prNumber} ──`);
  lines.push(`  status:         ${result.status}`);
  if (result.finalVerdict) lines.push(`  final verdict:  ${result.finalVerdict}`);
  lines.push(`  iterations:     ${result.iterations.length}`);
  lines.push(`  total cost:     $${result.totalCostUsd.toFixed(4)}`);
  lines.push(`  merge status:   ${result.mergeStatus}`);
  if (result.reason) lines.push(`  reason:         ${result.reason}`);
  for (const it of result.iterations) {
    lines.push(`  iter ${it.index + 1}: ${it.appliedCount}/${it.fixes.length} patches applied, verified=${it.verified}${it.buildCommand ? `, build=${it.buildOk}` : ""}${it.testCommand ? `, tests=${it.testsOk}` : ""}`);
    for (const note of it.notes) lines.push(`    note: ${note}`);
  }
  if (result.remainingBlockers.length > 0) {
    lines.push(`  remaining blockers (${result.remainingBlockers.length}):`);
    for (const b of result.remainingBlockers.slice(0, 5)) {
      lines.push(`    [${b.severity}/${b.category}] ${b.message} ${b.file ? `(${b.file})` : ""}`);
    }
  }
  return lines.join("\n") + "\n";
}

// Re-exports for tests that need types
export type { WorkerOutcome, WorkerContext };
