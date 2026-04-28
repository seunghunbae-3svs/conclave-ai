import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  Blocker,
  BlockerFix,
  ReviewResult,
} from "@conclave-ai/core";
import { isFileDenied } from "@conclave-ai/core";
import type {
  ClaudeWorker,
  FileSnapshot,
  WorkerContext,
  WorkerOutcome,
  WorkerRejectedAttempt,
} from "@conclave-ai/agent-worker";
import { recountHunkHeaders } from "./patch-fixup.js";

export type WorkerLike = {
  work: (ctx: WorkerContext) => Promise<WorkerOutcome>;
};

export type GitLike = (
  bin: string,
  args: readonly string[],
  opts?: { cwd?: string; input?: string; timeout?: number },
) => Promise<{ stdout: string; stderr?: string; code?: number }>;

export type FileReader = (absPath: string) => Promise<string>;

export interface AutofixWorkerDeps {
  worker: WorkerLike;
  /** Runs a unified diff through `git apply --check` to validate. */
  git: GitLike;
  /** Read file content for the snapshot attached to the worker prompt. */
  readFile?: FileReader;
  /** Current working directory (the PR branch checkout). */
  cwd: string;
  /** Override deny-list (defaults to DEFAULT_AUTOFIX_DENY_PATTERNS). */
  denyPatterns?: readonly string[];
  /** Write + delete the temp patch file used for `git apply --check`. */
  writeTempPatch?: (absPath: string, contents: string) => Promise<void>;
  removeTempPatch?: (absPath: string) => Promise<void>;
  /**
   * v0.13.19 (H1 #4) — when the validate step rejects a worker patch,
   * call the worker AGAIN with the rejection reason in the prompt so
   * it can correct the specific failure mode (off-by-N start line,
   * miscounted hunk header, hallucinated context). Default 2 (so up
   * to 3 total worker calls per blocker per iteration). Hard-capped at
   * 4 inside `runPerBlocker` to keep per-blocker cost bounded.
   *
   * Each retry costs roughly $0.20 (one extra worker call). Live RC:
   * eventbadge#29 burnt 3 OUTER cycles because each cycle's first
   * worker call emitted a bad patch and the loop bailed. With this
   * retry, the second call sees "your last patch landed at line 17
   * but the deletion is at line 18" and corrects in-cycle — so the
   * outer loop doesn't have to be exhausted.
   */
  workerRetries?: number;
  /** stderr sink for retry-progress logs. Default: process.stderr. */
  stderr?: (s: string) => void;
}

const HARD_MAX_WORKER_RETRIES = 4;
const DEFAULT_WORKER_RETRIES = 2;

export interface BuildPerBlockerContextInput {
  repo: string;
  pullNumber: number;
  newSha: string;
  diff?: string;
  answerKeys?: readonly string[];
  failureCatalog?: readonly string[];
  /** The agent that raised this specific blocker (for prompt context). */
  agent: string;
  blocker: Blocker;
  /**
   * Optional build-failure tail from the previous iteration. When set,
   * we append it to the WorkerContext.reviews[0].summary so the worker
   * sees what broke.
   */
  buildErrorTail?: string;
  /**
   * H3 #13 — auto-tuned hint lines from past `rework-loop-failure`
   * catalog entries. The worker prompt builder splices them into the
   * cache-prefix so the worker sees concrete prior failure shapes.
   */
  priorBailHints?: readonly string[];
}

/**
 * Build a minimal `WorkerContext` focused on a SINGLE blocker. We
 * synthesize a one-agent, one-blocker ReviewResult (the ClaudeWorker
 * prompt is designed around `reviews[]`) so the existing worker prompt
 * — which expects `reviews[*].blockers[*]` — works unchanged.
 */
export function buildPerBlockerContext(
  input: BuildPerBlockerContextInput,
  fileSnapshots: FileSnapshot[],
): WorkerContext {
  const review: ReviewResult = {
    agent: input.agent,
    verdict: "rework",
    summary: input.buildErrorTail
      ? `Previous autofix attempt built but the verification step failed. Do NOT repeat the same edits; adjust based on the failure tail below.\n\n--- build/test failure tail ---\n${input.buildErrorTail}`
      : `Autofix target — fix ONLY the single blocker below.`,
    blockers: [input.blocker],
  };
  const ctx: WorkerContext = {
    repo: input.repo,
    pullNumber: input.pullNumber,
    newSha: input.newSha,
    reviews: [review],
    fileSnapshots,
  };
  if (input.diff !== undefined) ctx.diff = input.diff;
  if (input.answerKeys && input.answerKeys.length > 0) ctx.answerKeys = input.answerKeys;
  if (input.failureCatalog && input.failureCatalog.length > 0) ctx.failureCatalog = input.failureCatalog;
  if (input.priorBailHints && input.priorBailHints.length > 0) ctx.priorBailHints = input.priorBailHints;
  return ctx;
}

/**
 * Run the worker against a single blocker, validate the returned patch
 * with `git apply --check --recount`, and return a `BlockerFix` entry.
 *
 * This function is intentionally *pure* w.r.t. staging / committing —
 * the caller (autofix.ts) collects ready fixes, runs the diff-budget
 * guard, applies them, commits, and verifies.
 */
export async function runPerBlocker(
  input: BuildPerBlockerContextInput,
  deps: AutofixWorkerDeps,
): Promise<BlockerFix> {
  // Design-domain blockers — v0.13.7 update.
  //
  // Pre-v0.13.7 we hard-skipped any blocker whose category started with
  // "design-*" / "ui-*" / "visual-*". That left a class of trivially
  // fixable visual regressions on the table — e.g. a contrast or
  // accessibility blocker that names a specific component file (`file:
  // "src/Button.tsx"`) is structurally no different from a code blocker:
  // the worker can swap a Tailwind class, a color value, or an aria-*
  // prop and produce a clean unified diff.
  //
  // New rule: only skip when there is no `file` field — i.e. the blocker
  // points at a visual surface (route label, screenshot id) with no
  // attributable source. With a `file` set, fall through to the worker;
  // if the file doesn't exist or the worker can't see how to patch, the
  // downstream patch-validation handles it (worker-error / no-patch).
  const cat = input.blocker.category?.toLowerCase() ?? "";
  const isDesignDomain =
    cat.startsWith("design") ||
    cat.startsWith("ui-") ||
    cat.startsWith("visual") ||
    cat === "contrast" ||
    cat === "accessibility" ||
    cat === "layout-regression" ||
    cat === "style-drift" ||
    cat === "cropped-text" ||
    cat === "missing-state" ||
    cat === "overflow";
  if (isDesignDomain && !input.blocker.file) {
    return {
      agent: input.agent,
      blocker: input.blocker,
      status: "skipped",
      reason: "design-domain blocker without a file — human visual judgment required",
    };
  }

  // File allowlist — never autofix secrets / env files / keys.
  if (input.blocker.file) {
    const denied = isFileDenied(input.blocker.file, deps.denyPatterns);
    if (denied) {
      return {
        agent: input.agent,
        blocker: input.blocker,
        status: "skipped",
        reason: `file "${input.blocker.file}" matches deny-list (secrets/keys/env)`,
      };
    }
  }

  // Snapshot the file the blocker names (and only it). ClaudeWorker
  // prompt supports multiple snapshots, but for per-blocker fixes we
  // keep the context tight — the worker should not be patching
  // unrelated files anyway.
  const readOne = deps.readFile ?? ((p: string) => readFile(p, "utf8"));
  const fileSnapshots: FileSnapshot[] = [];
  if (input.blocker.file) {
    const rel = input.blocker.file;
    const abs = path.isAbsolute(rel) ? rel : path.join(deps.cwd, rel);
    try {
      const contents = await readOne(abs);
      fileSnapshots.push({ path: rel, contents });
    } catch {
      // Worker will still run, but with no snapshot — it may decline.
    }
  }

  // v0.13.19 (H1 #4) — retry-with-feedback loop. On apply-validation
  // failure, call the worker AGAIN with the rejection reason in the
  // prompt. Capped at workerRetries (default 2 → up to 3 total worker
  // calls per blocker). Each retry is roughly $0.20.
  const maxRetries = Math.min(
    HARD_MAX_WORKER_RETRIES,
    Math.max(0, deps.workerRetries ?? DEFAULT_WORKER_RETRIES),
  );
  const stderr = deps.stderr ?? ((s: string) => process.stderr.write(s));
  const previousAttempts: WorkerRejectedAttempt[] = [];
  let totalCostUsd = 0;
  let totalTokensUsed = 0;
  // Hold the last validation error so the conflict-path return can
  // include it after all retries are exhausted.
  let lastValidationError: string | undefined;
  let lastValidationOutcome: WorkerOutcome | undefined;

  const writeTemp = deps.writeTempPatch ?? (async (p: string, c: string) => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(p, c, "utf8");
  });
  const removeTemp = deps.removeTempPatch ?? (async (p: string) => {
    const { unlink } = await import("node:fs/promises");
    await unlink(p);
  });

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const baseCtx = buildPerBlockerContext(input, fileSnapshots);
    // Snapshot the rejected-attempts array so the worker sees the
    // history at the moment of THIS call. Without the slice, later
    // pushes mutate the same array reference the worker captured —
    // which breaks both unit-test inspection AND any worker mock that
    // re-reads ctx after returning.
    const ctx: WorkerContext = previousAttempts.length > 0
      ? { ...baseCtx, previousAttempts: previousAttempts.slice() }
      : baseCtx;

    let outcome: WorkerOutcome;
    try {
      outcome = await deps.worker.work(ctx);
    } catch (err) {
      return {
        agent: input.agent,
        blocker: input.blocker,
        status: "worker-error",
        reason: err instanceof Error ? err.message : String(err),
        ...(totalCostUsd > 0 ? { costUsd: totalCostUsd } : {}),
        ...(totalTokensUsed > 0 ? { tokensUsed: totalTokensUsed } : {}),
      };
    }
    if (outcome.costUsd !== undefined) totalCostUsd += outcome.costUsd;
    if (outcome.tokensUsed !== undefined) totalTokensUsed += outcome.tokensUsed;

    if (!outcome.patch || outcome.patch.trim().length === 0) {
      return {
        agent: input.agent,
        blocker: input.blocker,
        status: "worker-error",
        reason: "worker returned empty patch",
        costUsd: totalCostUsd,
        tokensUsed: totalTokensUsed,
      };
    }

    // Also apply deny-list to every file the patch touches — the
    // worker might report a fix on `src/x.ts` but have snuck changes
    // into `.env.production` as part of the same hunk set.
    let denyHit = false;
    for (const f of outcome.appliedFiles ?? []) {
      if (isFileDenied(f, deps.denyPatterns)) {
        return {
          agent: input.agent,
          blocker: input.blocker,
          status: "skipped",
          reason: `worker patch touches deny-listed file "${f}"`,
          patch: outcome.patch,
          appliedFiles: outcome.appliedFiles,
          costUsd: totalCostUsd,
          tokensUsed: totalTokensUsed,
        };
      }
    }
    if (denyHit) break;

    // Validate with `git apply --check --recount` then GNU patch fuzz
    // fallback. Same shape as pre-v0.13.19, just inside the retry loop
    // so we can re-prompt on validation failure.
    const tempPath = path.join(deps.cwd, `.conclave-autofix-${randomId()}.patch`);
    // v0.13.10 — recount hunk headers. Worker miscounts (B too large)
    // trip `git apply --recount` with "corrupt patch at line N" before
    // --recount can do its job.
    const validatedPatch = recountHunkHeaders(outcome.patch);
    let validateErr: Error | undefined;
    try {
      await writeTemp(tempPath, validatedPatch);
      try {
        await deps.git("git", ["apply", "--check", "--recount", tempPath], { cwd: deps.cwd });
      } catch (err) {
        let fuzzOk = false;
        try {
          await deps.git(
            "patch",
            ["-p1", "--fuzz=3", "-F", "3", "--dry-run", "--no-backup-if-mismatch", "-i", tempPath],
            { cwd: deps.cwd },
          );
          fuzzOk = true;
        } catch {
          /* patch(1) also rejected — fall through to retry / conflict */
        }
        if (!fuzzOk) {
          validateErr = err instanceof Error ? err : new Error(String(err));
        }
      }
    } finally {
      await removeTemp(tempPath).catch(() => undefined);
    }

    if (!validateErr) {
      // 🎯 patch validates. Done.
      return {
        agent: input.agent,
        blocker: input.blocker,
        status: "ready",
        patch: outcome.patch,
        commitMessage: outcome.message,
        appliedFiles: outcome.appliedFiles,
        costUsd: totalCostUsd,
        tokensUsed: totalTokensUsed,
        ...(attempt > 0 ? { workerAttempts: attempt + 1 } : {}),
      };
    }

    // Validation failed. Either retry with feedback, or give up.
    lastValidationError = validateErr.message;
    lastValidationOutcome = outcome;
    if (attempt < maxRetries) {
      stderr(
        `runPerBlocker: worker attempt ${attempt + 1} produced an invalid patch (${
          validateErr.message.split("\n")[0]
        }) — retrying with apply-error feedback (${maxRetries - attempt} retries left)\n`,
      );
      previousAttempts.push({
        patch: outcome.patch,
        // Cap reject reason at 800 chars so the worker prompt doesn't
        // bloat (typical git apply messages are well under 200).
        rejectReason: validateErr.message.slice(0, 800),
      });
      continue;
    }
    // Retries exhausted — surface the conflict.
    break;
  }

  // All retries failed.
  return {
    agent: input.agent,
    blocker: input.blocker,
    status: "conflict",
    reason: lastValidationError ?? "patch validation failed across all retries",
    ...(lastValidationOutcome ? { patch: lastValidationOutcome.patch } : {}),
    ...(lastValidationOutcome?.appliedFiles
      ? { appliedFiles: lastValidationOutcome.appliedFiles }
      : {}),
    costUsd: totalCostUsd,
    tokensUsed: totalTokensUsed,
    workerAttempts: previousAttempts.length + 1,
  };
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export type { ClaudeWorker };
