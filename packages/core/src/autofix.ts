/**
 * Autofix — shared types for v0.7's autonomous fix loop.
 *
 * The CLI `conclave autofix` command takes a Council verdict with
 * blockers and drives a fix → build → test → re-review loop. These
 * types describe the contract between the per-blocker worker call,
 * the build verifier, and the final verdict render without pulling
 * CLI-only dependencies (child_process, cosmiconfig) into `core`.
 *
 * Keep this file pure — no filesystem / process side effects here.
 */
import type { Blocker, ReviewResult } from "./agent.js";

/**
 * One blocker plus the worker's attempt to resolve it. Produced by the
 * per-blocker autofix orchestrator before anything gets applied.
 *
 * `patch` is a unified-diff string (the ClaudeWorker output). `status`
 * reports what we plan to do with it:
 *   - "ready"        → passed `git apply --check`, passed secret-guard,
 *                      in-allowlist, within diff budget.
 *   - "skipped"      → policy reason (design domain, allowlist, etc.).
 *                      `reason` carries the human explanation.
 *   - "conflict"     → worker produced a patch but it doesn't apply.
 *   - "secret-block" → secret-guard flagged the patch.
 *   - "worker-error" → LLM/transport failure (CircuitBreaker, timeout).
 */
export type BlockerFixStatus =
  | "ready"
  | "skipped"
  | "conflict"
  | "secret-block"
  | "worker-error";

export interface BlockerFix {
  /** Exact blocker echoed back so consumers don't re-index the verdict. */
  blocker: Blocker;
  /** Agent id that raised it ("claude", "openai", "design", …). */
  agent: string;
  status: BlockerFixStatus;
  patch?: string;
  commitMessage?: string;
  appliedFiles?: string[];
  reason?: string;
  tokensUsed?: number;
  costUsd?: number;
}

/**
 * Aggregate result for one autofix iteration. An iteration is a single
 * pass through `review → per-blocker patches → build → test → commit`.
 * The CLI may run up to `maxIterations` before bailing out (default 2,
 * hard max 3 per the v0.7 safety rails).
 */
export interface AutofixIteration {
  index: number;
  fixes: BlockerFix[];
  /** Count of ready patches we attempted to apply. */
  appliedCount: number;
  /** True when build + tests passed after applying. */
  verified: boolean;
  /** Build/test diagnostics — filled in by the CLI's verifier. */
  buildOk?: boolean;
  testsOk?: boolean;
  buildCommand?: string;
  testCommand?: string;
  /** Cost attributed to this iteration only (sum of fixes[*].costUsd). */
  costUsd: number;
  /** Non-fatal notes (e.g. "skipped 1 design blocker"). */
  notes: string[];
}

/** Terminal status the CLI reports + exits on. */
export type AutofixResultStatus =
  | "approved"
  | "awaiting-approval"
  | "bailed-max-iterations"
  | "bailed-diff-budget"
  | "bailed-budget"
  | "bailed-circuit"
  | "bailed-loop-guard"
  | "bailed-no-patches"
  | "bailed-build-failed"
  | "bailed-tests-failed"
  | "bailed-secret-guard"
  | "dry-run";

export interface AutofixResult {
  status: AutofixResultStatus;
  iterations: AutofixIteration[];
  totalCostUsd: number;
  /** Final Council verdict after the last applied iteration. */
  finalVerdict?: "approve" | "rework" | "reject";
  /** Remaining blockers after the loop terminated. */
  remainingBlockers: Blocker[];
  /**
   * PR merge status. Always "not-merged" in L2 mode. In L3 the CLI sets
   * "merged" after `gh pr merge` succeeds; on failure it stays
   * "not-merged" and the status moves to "awaiting-approval".
   */
  mergeStatus: "not-merged" | "merged" | "merge-failed";
  /** Short machine-readable reason to pair with `status`. */
  reason?: string;
}

/**
 * File-allowlist verdict. Default deny-list used by the CLI is:
 *   .env* | *.pem | *.key | *secret* | *.credentials*
 * Consumers may override via `.conclaverc.json autofix.denyPatterns`.
 */
export function isFileDenied(
  relPath: string,
  denyPatterns: readonly string[] = DEFAULT_AUTOFIX_DENY_PATTERNS,
): boolean {
  const norm = relPath.replace(/\\/g, "/").toLowerCase();
  const name = norm.split("/").pop() ?? norm;
  for (const pat of denyPatterns) {
    const p = pat.toLowerCase();
    if (matchGlob(name, p) || matchGlob(norm, p)) return true;
  }
  return false;
}

/**
 * Extremely small glob matcher — only `*` wildcards, no `**` / char
 * classes / brace expansion. Intentional: the deny-list is a handful
 * of patterns and we don't want a micromatch dependency in core.
 */
function matchGlob(input: string, pattern: string): boolean {
  // Anchor; `*` → `.*`, everything else escaped.
  const re = new RegExp(
    "^" +
      pattern
        .split("*")
        .map((seg) => seg.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*") +
      "$",
  );
  return re.test(input);
}

export const DEFAULT_AUTOFIX_DENY_PATTERNS: readonly string[] = Object.freeze([
  ".env",
  ".env.*",
  "*.env",
  "*.pem",
  "*.key",
  "*secret*",
  "*.credentials*",
  "*credentials.json",
  "id_rsa",
  "id_ed25519",
]);

/**
 * Extract the set of files a unified diff touches. Used by the diff-budget
 * guard to check the total line count across ALL planned patches before
 * the CLI applies any of them. Same lightweight parser as
 * `summarizeDiff` in review.ts, but returns per-file + total counts.
 */
export function summarizeAutofixPatches(patches: readonly string[]): {
  totalFiles: number;
  totalLines: number;
  perFile: Array<{ file: string; added: number; removed: number }>;
} {
  const perFile = new Map<string, { added: number; removed: number }>();
  for (const patch of patches) {
    let current: string | null = null;
    for (const line of patch.split(/\r?\n/)) {
      if (line.startsWith("+++ b/")) {
        current = line.slice("+++ b/".length).trim();
        if (current === "/dev/null") current = null;
        else if (!perFile.has(current)) perFile.set(current, { added: 0, removed: 0 });
        continue;
      }
      if (line.startsWith("--- a/") || line.startsWith("diff --git ") || line.startsWith("index ") || line.startsWith("@@ ")) continue;
      if (!current) continue;
      if (line.startsWith("+") && !line.startsWith("+++")) perFile.get(current)!.added += 1;
      else if (line.startsWith("-") && !line.startsWith("---")) perFile.get(current)!.removed += 1;
    }
  }
  const list = [...perFile.entries()].map(([file, c]) => ({ file, ...c }));
  return {
    totalFiles: list.length,
    totalLines: list.reduce((n, x) => n + x.added + x.removed, 0),
    perFile: list,
  };
}

/**
 * Dedupe Council blockers across agents — same file + category + first
 * 80 chars of message collapses to one entry (whichever agent reported
 * first wins). Keeps the autofix loop from paying two worker calls to
 * fix the same issue twice.
 */
export function dedupeBlockersAcrossAgents(
  reviews: readonly ReviewResult[],
): Array<{ agent: string; blocker: Blocker }> {
  const out: Array<{ agent: string; blocker: Blocker }> = [];
  const seen = new Set<string>();
  for (const r of reviews) {
    for (const b of r.blockers) {
      // nit-level is advisory — never autofix.
      if (b.severity === "nit") continue;
      const key = `${b.category}|${b.file ?? ""}|${b.message.slice(0, 80)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ agent: r.agent, blocker: b });
    }
  }
  return out;
}
