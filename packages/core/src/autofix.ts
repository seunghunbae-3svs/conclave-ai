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
  /**
   * v0.13.19 (H1 #4) — number of worker calls made for this blocker
   * before reaching the final status. 1 = first attempt was the
   * accepted patch; >1 = retry-with-feedback loop was needed
   * (each retry is another worker call costing ~$0.20). Operators
   * use this to decide whether the worker prompt needs further
   * tuning. Absent on first-attempt-success for backward compat.
   */
  workerAttempts?: number;
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
 * Dedupe Council blockers across agents — same observable issue
 * collapses to one entry (whichever agent reported first wins).
 * Keeps the autofix loop from paying two worker calls AND from
 * generating patches that conflict on the second apply.
 *
 * Key shape (v0.13.5+): `${file}|${line ?? ""}|${message[:60]}`.
 * Pre-fix the key included `category`, so different agents reporting
 * the SAME line bug under different category labels (e.g. claude
 * said "regression", openai said "logging" for the same console.log)
 * passed dedupe and produced two patches. First patch removed the
 * line, second patch failed to apply because the line was already
 * gone — `apply conflict mid-iteration — rolled back staged changes`,
 * loop stalled. Live-caught on eventbadge#28.
 *
 * Why drop `category`: agents disagree on category labels for the
 * same observable bug ("regression" vs "logging" vs "code-quality"
 * for a stray console.log). The bug is the bug; the label is taxonomy.
 *
 * Why include `line`: two different blockers might exist on the same
 * file with similar opening prose ("Add input validation to ..."
 * pattern recurs). Line number disambiguates same-file repeats.
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
      const lineKey = typeof b.line === "number" ? String(b.line) : "";
      // First 60 chars of message is enough to differentiate distinct
      // bugs at the same file+line (real-world bug messages vary
      // within the first sentence) without locking out near-paraphrases
      // from different agents.
      const key = `${b.file ?? ""}|${lineKey}|${b.message.slice(0, 60)}`;
      if (seen.has(key)) continue;

      // v0.13.13 — fuzzy dedupe across agents that disagree on the
      // EXACT line of the same observable bug. Live RC: eventbadge#29
      // verdict had Claude flagging a `console.log` at line 18 and
      // OpenAI flagging the same `console.log` at line 17 (off-by-one
      // in OpenAI's attribution). Existing key keyed on the line
      // number, so the two passed through. autofix produced 2 patches
      // — first applied with fuzz, second hit "patch already applied"
      // because the line was gone. applyFailed=true → loop stalled.
      //
      // Fuzzy rule: collapse iff (same file) AND (line diff ≤ 1) AND
      // (messages share a notable code-shaped token of ≥4 chars).
      // The token check guards against false-positives where two
      // genuinely-different blockers happen to land at adjacent lines.
      // Keep the FIRST one (highest-trust agent gets through; later
      // overlaps drop). nit-severity is already filtered above.
      if (isFuzzyDuplicate(b, out)) continue;

      seen.add(key);
      out.push({ agent: r.agent, blocker: b });
    }
  }
  return out;
}

/**
 * v0.13.13 — fuzzy duplicate detection. True iff the candidate blocker
 * is "the same observable bug" as one we've already accepted, where
 * "same" means same file, line within ±1, and the two messages share
 * at least one notable identifier-like token (≥4 chars, not a common
 * English stopword). Conservative — leans toward keeping both when in
 * doubt, since dropping a real blocker is worse than processing a
 * harmless duplicate.
 */
export function isFuzzyDuplicate(
  candidate: Blocker,
  accepted: ReadonlyArray<{ agent: string; blocker: Blocker }>,
): boolean {
  if (!candidate.file || typeof candidate.line !== "number") return false;
  for (const a of accepted) {
    const o = a.blocker;
    if (o.file !== candidate.file) continue;
    if (typeof o.line !== "number") continue;
    if (Math.abs(o.line - candidate.line) > 1) continue;
    if (sharesNotableToken(o.message, candidate.message)) return true;
  }
  return false;
}

const FUZZY_DEDUPE_STOPWORDS = new Set([
  "this", "that", "with", "from", "have", "been", "were", "your",
  "their", "should", "would", "could", "before", "after", "remove",
  "added", "fixed", "issue", "the", "and", "for", "but", "into",
  "onto", "than", "then", "when", "what", "will", "must", "very",
  "more", "most", "less", "such", "some", "other", "above", "below",
  "addresses", "addresses", "consider", "consider", "production",
]);

function sharesNotableToken(a: string, b: string): boolean {
  const ta = notableTokens(a);
  if (ta.size === 0) return false;
  const tb = notableTokens(b);
  for (const t of ta) {
    if (tb.has(t)) return true;
  }
  return false;
}

function notableTokens(s: string): Set<string> {
  const out = new Set<string>();
  // Match identifier-shaped tokens: must start with a letter, allow
  // ascii letters/digits/_/- after. Length ≥ 4. Lowercase before
  // adding to the set so case differences don't split tokens.
  for (const m of s.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? []) {
    if (FUZZY_DEDUPE_STOPWORDS.has(m)) continue;
    out.add(m);
  }
  return out;
}
