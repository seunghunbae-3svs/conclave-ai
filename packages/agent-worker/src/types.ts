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
