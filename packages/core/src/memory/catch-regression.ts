import { createHash } from "node:crypto";
import type { Blocker, ReviewContext, ReviewResult } from "../agent.js";
import type { CouncilOutcome } from "../council.js";
import type { FailureEntry } from "./schema.js";
import type { MemoryStore } from "./store.js";

/**
 * H3 #15 — regression-detection meta-loop.
 *
 * Detect "catch regressions": cases where a previously-cataloged failure
 * pattern is present in the diff (tokens overlap at a RELAXED threshold)
 * but neither the council nor the H2 #7 failure-gate raised a blocker
 * of the same category. The semantic is: "we caught this kind of thing
 * before; we didn't catch it now." Each detection becomes a meta
 * FailureEntry tagged 'catch-regression' so the next review's retrieval
 * surfaces it with extra weight.
 *
 * Detection is deterministic — no LLM call. Inputs come straight off the
 * post-deliberation pipeline (the same retrieval the gate used).
 */

const META_TAGS = new Set(["catch-regression", "rework-loop-failure"]);

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "to", "of", "in", "on", "for", "with", "by",
  "is", "are", "was", "were", "be", "been", "being", "it", "its", "this",
  "that", "these", "those", "at", "from", "as", "but", "not", "if", "then",
  "should", "must", "fix", "use", "add", "have", "has",
]);

export interface DetectCatchRegressionsInput {
  /** Post-deliberation outcome (after the H2 #7 failure-gate has run). */
  outcome: CouncilOutcome;
  /** Council's input — only `diff` is consumed. */
  ctx: Pick<ReviewContext, "diff">;
  /** Retrieved failure-catalog entries from the same review pass. */
  retrievedFailures: readonly FailureEntry[];
}

export interface DetectCatchRegressionsOptions {
  /**
   * Relaxed overlap threshold. The H2 #7 active gate defaults to 2;
   * regression detection runs at a lower bar so it catches near-misses
   * the gate's conservative match wouldn't. Default 1 — any single
   * meaningful token overlap is enough to flag a regression candidate.
   */
  minTokenOverlap?: number;
  /** Cap on how many regressions to surface per call. Default 5. */
  maxRegressions?: number;
}

export interface CatchRegression {
  /** id of the catalog FailureEntry that triggered the detection. */
  failureId: string;
  /** Free-form category from the failure (or its seedBlocker if present). */
  category: string;
  /** Distinct tokens that matched between failure and diff. */
  matchedTokens: string[];
  /** Failure title carried verbatim — useful for the alert string. */
  title: string;
}

export function detectCatchRegressions(
  input: DetectCatchRegressionsInput,
  opts: DetectCatchRegressionsOptions = {},
): CatchRegression[] {
  const minOverlap = opts.minTokenOverlap ?? 1;
  const maxOut = opts.maxRegressions ?? 5;
  const diffTokens = extractAddedLineTokens(input.ctx.diff);
  if (diffTokens.size === 0) return [];

  // Categories the council OR gate already raised this round count as
  // "caught" — don't flag them as regressions.
  const caughtCategories = new Set<string>();
  for (const review of input.outcome.results) {
    for (const blocker of review.blockers) {
      caughtCategories.add(blocker.category);
    }
  }

  const out: CatchRegression[] = [];
  const seenKeys = new Set<string>();

  for (const failure of input.retrievedFailures) {
    if (out.length >= maxOut) break;
    // Don't recurse on meta entries — they describe past misses, not
    // patterns themselves.
    if (failure.tags.some((t) => META_TAGS.has(t))) continue;

    // Tokens from this failure's title + body + tags.
    const failureTokens = collectFailureTokens(failure);
    if (failureTokens.size === 0) continue;

    const matched: string[] = [];
    for (const t of failureTokens) {
      if (diffTokens.has(t)) matched.push(t);
    }
    if (matched.length < minOverlap) continue;

    // Use the free-form seedBlocker.category when available — same
    // round-trip behaviour as the failure-gate (H2 QA fix).
    const category = failure.seedBlocker?.category ?? failure.category;
    if (caughtCategories.has(category)) continue;

    const dedupKey = `${category}|${truncate(failure.title, 60)}`;
    if (seenKeys.has(dedupKey)) continue;
    seenKeys.add(dedupKey);

    out.push({
      failureId: failure.id,
      category,
      matchedTokens: matched,
      title: failure.title,
    });
  }
  return out;
}

export interface WriteCatchRegressionInput {
  /** Where the regression was detected (e.g. "acme/app#42"). */
  contextLabel: string;
  regression: CatchRegression;
  /** Optional pointer back to the episodic that surfaced this. */
  episodicId?: string;
}

/**
 * Persist a catch-regression as a new FailureEntry. The entry carries
 * tag 'catch-regression' + the original category so the next review's
 * retrieval brings it back with the same retrieval ranking the original
 * pattern had.
 *
 * Stable id keyed on (category, source failureId) so re-detections of
 * the same regression don't spawn duplicate entries.
 */
export async function writeCatchRegression(
  store: MemoryStore,
  input: WriteCatchRegressionInput,
): Promise<FailureEntry> {
  const r = input.regression;
  const id = `fc-regression-${shortHash(`${r.category}|${r.failureId}`)}`;
  const entry: FailureEntry = {
    id,
    createdAt: new Date().toISOString(),
    domain: "code",
    category: "regression",
    severity: "major",
    title: `Catch regression: ${truncate(r.title, 100)}`,
    body:
      `Failure-catalog entry ${r.failureId} (${r.category}) matched the diff at ` +
      `${input.contextLabel} but no blocker of that category was raised by the council ` +
      `or the failure-gate. Matched tokens: ${r.matchedTokens.slice(0, 6).join(", ")}.`,
    tags: ["catch-regression", r.category],
    ...(input.episodicId ? { episodicId: input.episodicId } : {}),
  };
  await store.writeFailure(entry);
  return entry;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9가-힣_]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 4 && !STOP_WORDS.has(t));
}

function extractAddedLineTokens(diff: string): Set<string> {
  const tokens = new Set<string>();
  for (const line of diff.split(/\r?\n/)) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    for (const t of tokenize(line.slice(1))) tokens.add(t);
  }
  return tokens;
}

function collectFailureTokens(failure: FailureEntry): Set<string> {
  const set = new Set<string>();
  for (const t of tokenize(failure.title)) set.add(t);
  for (const t of tokenize(failure.body)) set.add(t);
  for (const tag of failure.tags) {
    for (const t of tokenize(tag)) set.add(t);
  }
  return set;
}

function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

// Re-export Blocker / ReviewResult to avoid a circular import surprise
// for downstream callers that destructure from the same module — kept
// as a compile-time-only re-export so it doesn't bloat runtime.
export type { Blocker, ReviewResult };
