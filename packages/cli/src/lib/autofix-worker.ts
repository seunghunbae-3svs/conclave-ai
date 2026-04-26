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
} from "@conclave-ai/agent-worker";

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
}

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

  const ctx = buildPerBlockerContext(input, fileSnapshots);

  let outcome: WorkerOutcome;
  try {
    outcome = await deps.worker.work(ctx);
  } catch (err) {
    return {
      agent: input.agent,
      blocker: input.blocker,
      status: "worker-error",
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  if (!outcome.patch || outcome.patch.trim().length === 0) {
    return {
      agent: input.agent,
      blocker: input.blocker,
      status: "worker-error",
      reason: "worker returned empty patch",
      ...(outcome.costUsd !== undefined ? { costUsd: outcome.costUsd } : {}),
      ...(outcome.tokensUsed !== undefined ? { tokensUsed: outcome.tokensUsed } : {}),
    };
  }

  // Also apply deny-list to every file the patch touches — the worker
  // might report a fix on `src/x.ts` but have snuck changes into
  // `.env.production` as part of the same hunk set.
  for (const f of outcome.appliedFiles ?? []) {
    if (isFileDenied(f, deps.denyPatterns)) {
      return {
        agent: input.agent,
        blocker: input.blocker,
        status: "skipped",
        reason: `worker patch touches deny-listed file "${f}"`,
        patch: outcome.patch,
        appliedFiles: outcome.appliedFiles,
        ...(outcome.costUsd !== undefined ? { costUsd: outcome.costUsd } : {}),
        ...(outcome.tokensUsed !== undefined ? { tokensUsed: outcome.tokensUsed } : {}),
      };
    }
  }

  // Validate with `git apply --check --recount`. We write the patch to a
  // temp file in the worktree root (git can read it), check, then
  // unlink. The caller will re-apply for real later — we don't stage
  // here because the diff-budget guard runs AFTER this loop.
  const tempPath = path.join(deps.cwd, `.conclave-autofix-${randomId()}.patch`);
  const writeTemp = deps.writeTempPatch ?? (async (p: string, c: string) => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(p, c, "utf8");
  });
  const removeTemp = deps.removeTempPatch ?? (async (p: string) => {
    const { unlink } = await import("node:fs/promises");
    await unlink(p);
  });

  try {
    await writeTemp(tempPath, outcome.patch);
    try {
      await deps.git("git", ["apply", "--check", "--recount", tempPath], { cwd: deps.cwd });
    } catch (err) {
      // v0.13.8 — fall back to GNU `patch -p1 --fuzz=3 --dry-run`. The
      // worker can emit hunk headers with off-by-N starting line
      // numbers (eventbadge#29 sha 279cb22 surfaced this: "@@ -17,..."
      // vs actual line 18); `git apply --recount` only fixes COUNTS,
      // not the start line, and on Linux runners the offset tolerance
      // isn't enough. patch(1) accepts off-by-N starts; --dry-run
      // mirrors --check semantics (validate without writing).
      let fuzzOk = false;
      try {
        await deps.git(
          "patch",
          ["-p1", "--fuzz=3", "-F", "3", "--dry-run", "--no-backup-if-mismatch", "-i", tempPath],
          { cwd: deps.cwd },
        );
        fuzzOk = true;
      } catch {
        // patch(1) also rejected (or not on PATH) — fall through to the
        // existing conflict response so operators see the original git
        // apply error in the CI logs.
      }
      if (!fuzzOk) {
        return {
          agent: input.agent,
          blocker: input.blocker,
          status: "conflict",
          reason: err instanceof Error ? err.message : String(err),
          patch: outcome.patch,
          appliedFiles: outcome.appliedFiles,
          ...(outcome.costUsd !== undefined ? { costUsd: outcome.costUsd } : {}),
          ...(outcome.tokensUsed !== undefined ? { tokensUsed: outcome.tokensUsed } : {}),
        };
      }
    }
  } finally {
    await removeTemp(tempPath).catch(() => undefined);
  }

  return {
    agent: input.agent,
    blocker: input.blocker,
    status: "ready",
    patch: outcome.patch,
    commitMessage: outcome.message,
    appliedFiles: outcome.appliedFiles,
    ...(outcome.costUsd !== undefined ? { costUsd: outcome.costUsd } : {}),
    ...(outcome.tokensUsed !== undefined ? { tokensUsed: outcome.tokensUsed } : {}),
  };
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export type { ClaudeWorker };
