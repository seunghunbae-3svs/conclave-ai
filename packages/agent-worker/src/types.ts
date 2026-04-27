import type { ReviewResult } from "@conclave-ai/core";

/**
 * Snapshot of a file as it exists on the PR branch right now.
 * The caller (e.g. the `conclave rework` CLI) is responsible for reading
 * these from disk before invoking the worker. The worker itself stays
 * pure — no filesystem side effects — so it's easy to test and so the
 * git/commit logic lives in one place (scm-github / CLI) instead of
 * being split across the LLM layer.
 */
export interface FileSnapshot {
  path: string;
  contents: string;
}

/**
 * v0.13.19 (H1 #4) — feedback from the previous worker attempt that
 * the apply layer rejected. Used by the autofix retry loop to teach
 * the worker not to re-emit the same broken patch shape (off-by-N
 * starting line, miscounted hunk header, hallucinated context, etc.).
 */
export interface WorkerRejectedAttempt {
  /** The patch the worker emitted on the previous attempt. */
  patch: string;
  /** What the apply layer said when it rejected — e.g. the
   * `git apply --check --recount` stderr. Truncated to the most useful
   * lines (typically <500 chars). */
  rejectReason: string;
}

/** Everything the worker needs to produce a rework patch. */
export interface WorkerContext {
  repo: string;
  pullNumber: number;
  /** Head commit of the PR branch that the patch will be applied on top of. */
  newSha: string;
  /** Council verdicts from the review round that triggered this rework. */
  reviews: ReviewResult[];
  /** Current contents of files the reviewers flagged. */
  fileSnapshots: FileSnapshot[];
  /** The diff that was reviewed (optional — useful when blockers reference context lines). */
  diff?: string;
  answerKeys?: readonly string[];
  failureCatalog?: readonly string[];
  /**
   * Previous attempts on the SAME blocker that the apply layer
   * rejected. Empty/undefined on the first call. The autofix worker
   * retry loop fills this for retry calls so the worker can correct
   * the specific failure mode (e.g. "you said line 17 but the hunk
   * landed at line 18").
   */
  previousAttempts?: readonly WorkerRejectedAttempt[];
}

/** Result of a worker invocation — ready to hand to `git apply` + commit. */
export interface WorkerOutcome {
  /** Unified diff patch, applicable with `git apply`. */
  patch: string;
  /** Commit message subject (single line, conventional-commit style encouraged). */
  message: string;
  /** Files this patch is expected to touch — used for post-apply sanity checking. */
  appliedFiles: string[];
  tokensUsed?: number;
  costUsd?: number;
}
