import type { Blocker, ReviewContext, ReviewResult } from "../agent.js";
import type { CouncilOutcome } from "../council.js";
import type { CalibrationEntry, FailureEntry } from "./schema.js";

export interface FailureGateOptions {
  /**
   * Minimum number of distinct content tokens (length ≥ 4, stopword-
   * filtered) the failure body must share with the diff's added lines
   * before a sticky blocker is injected. Default 2.
   *
   * False-positive cost is "council told repo cared, but it's noise";
   * false-negative cost is "regression slipped through". The default
   * leans toward false-negatives — the answer-keys + agents already
   * catch the obvious cases, the gate's job is the not-already-caught.
   */
  minTokenOverlap?: number;
  /**
   * Drop matches whose failure severity is below this threshold. Default
   * "minor" — every catalog entry is fair game. Set to "major" to limit
   * the gate to high-severity stickies only.
   */
  minSeverity?: "blocker" | "major" | "minor";
  /**
   * H2 #8 — per-repo calibration map keyed by category. When the user
   * has overridden the council on a category multiple times, the gate
   * demotes / skips stickies for that category:
   *   0–1 overrides → full strength
   *   2 overrides    → demote one severity step (blocker→major, major→minor, minor→skip)
   *   3+ overrides   → skip the sticky entirely
   * Pass an empty map (or omit) for default behaviour.
   */
  calibration?: ReadonlyMap<string, CalibrationEntry>;
}

export interface FailureGateResult {
  /** The CouncilOutcome with the synthetic `failure-gate` agent appended (if anything matched) and verdict escalated. */
  outcome: CouncilOutcome;
  /** Sticky blockers added by the gate. Empty when nothing matched. */
  stickyBlockers: Blocker[];
  /** Per-sticky reason (failure id + matching tokens) — useful for the renderer + tests. */
  matches: Array<{ failureId: string; tokens: string[] }>;
  /**
   * H2 #8 — categories whose stickies were suppressed entirely because
   * the per-repo override count put them in the "skip" band. Reported
   * for visibility (CLI logs, tests) so users can see what calibration
   * is doing.
   */
  calibrationSkips: Array<{ failureId: string; category: string; overrideCount: number }>;
}

/**
 * Active gating for the failure-catalog (H2 #7). Runs AFTER the council
 * deliberates: deterministic, no LLM cost. The contract is "same mistake
 * never sneaks past twice" — once a category lands in failure-catalog,
 * any subsequent diff that resembles it gets a sticky blocker injected
 * with the original severity preserved.
 *
 * The gate suppresses a sticky when the council already raised a blocker
 * of the same category covering the same file — duplicates would be
 * noise, not signal.
 */
export function applyFailureGate(
  outcome: CouncilOutcome,
  retrievedFailures: readonly FailureEntry[],
  ctx: ReviewContext,
  opts: FailureGateOptions = {},
): FailureGateResult {
  const minOverlap = opts.minTokenOverlap ?? 2;
  const severityFloor = severityRank(opts.minSeverity ?? "minor");
  const diffAddedTokens = extractAddedLineTokens(ctx.diff);
  const changedFiles = extractChangedFiles(ctx.diff);

  const existingByCategory = new Map<string, Blocker[]>();
  for (const review of outcome.results) {
    for (const blocker of review.blockers) {
      const arr = existingByCategory.get(blocker.category);
      if (arr) arr.push(blocker);
      else existingByCategory.set(blocker.category, [blocker]);
    }
  }

  const stickies: Blocker[] = [];
  const matches: FailureGateResult["matches"] = [];
  const calibrationSkips: FailureGateResult["calibrationSkips"] = [];
  const seenStickyKeys = new Set<string>();

  for (const failure of retrievedFailures) {
    if (severityRank(failure.severity) < severityFloor) continue;

    const matchedTokens = matchTokens(failure, diffAddedTokens, minOverlap);
    if (matchedTokens.length === 0) continue;

    if (alreadyCoveredByCouncil(failure, existingByCategory, changedFiles)) continue;

    // Sticky uses the original FREE-FORM blocker category (preserved on
    // seedBlocker) rather than the closed-enum FailureEntry.category, so
    // (a) calibration can round-trip through OutcomeWriter recordOverride
    //     keyed on the same string the gate looked up, and
    // (b) end-users see the same category name they originally wrote in
    //     blocker.category, not the mapCategory-coerced enum.
    const stickyCategory = failure.seedBlocker?.category ?? failure.category;
    const stickyKey = `${stickyCategory}|${truncate(failure.title, 60)}`;
    if (seenStickyKeys.has(stickyKey)) continue;
    seenStickyKeys.add(stickyKey);

    // H2 #8 — apply per-repo calibration before constructing the sticky.
    // Calibration is keyed on the FREE-FORM blocker category (what the
    // agent emitted, e.g. "debug-noise") because OutcomeWriter records
    // overrides from blocker.category. FailureEntry.category is a closed
    // enum (mapped via classifier.mapCategory) — using it here would miss
    // calibrations recorded under free-form names. seedBlocker preserves
    // the original; fall back to failure.category for legacy entries
    // without a seedBlocker.
    const calLookupCategory = failure.seedBlocker?.category ?? failure.category;
    const calEntry = opts.calibration?.get(calLookupCategory);
    const calibrated = applyCalibrationToSeverity(failure.severity, calEntry?.overrideCount ?? 0);
    if (calibrated === null) {
      calibrationSkips.push({
        failureId: failure.id,
        category: calLookupCategory,
        overrideCount: calEntry?.overrideCount ?? 0,
      });
      continue;
    }

    const calibratedNote =
      calibrated !== failure.severity
        ? ` (severity demoted ${failure.severity}→${calibrated} — repo overrode "${calLookupCategory}" ${calEntry?.overrideCount ?? 0}x)`
        : "";
    const sticky: Blocker = {
      severity: calibrated,
      category: stickyCategory,
      message:
        `[sticky from failure-catalog] ${failure.title} — ${truncate(failure.body, 240)}${calibratedNote}`,
      ...(failure.seedBlocker?.file ? { file: failure.seedBlocker.file } : {}),
      ...(failure.seedBlocker?.line ? { line: failure.seedBlocker.line } : {}),
    };
    stickies.push(sticky);
    matches.push({ failureId: failure.id, tokens: matchedTokens });
  }

  if (stickies.length === 0) {
    return { outcome, stickyBlockers: [], matches: [], calibrationSkips };
  }

  const stickyVerdict = highestStickyVerdict(stickies);
  const synthetic: ReviewResult = {
    agent: "failure-gate",
    verdict: stickyVerdict,
    blockers: stickies,
    summary: `Active failure-catalog gate matched ${stickies.length} prior pattern${
      stickies.length === 1 ? "" : "s"
    }: ${stickies.map((s) => s.category).join(", ")}`,
  };
  const augmented: CouncilOutcome = {
    ...outcome,
    results: [...outcome.results, synthetic],
    verdict: escalateVerdict(outcome.verdict, stickyVerdict),
  };
  return { outcome: augmented, stickyBlockers: stickies, matches, calibrationSkips };
}

/**
 * H2 #8 — step-function calibration. Predictable bands beat a continuous
 * weight: a user can reason about "after I override 3 times the gate
 * stops bothering me about this".
 *
 *   0–1 overrides → unchanged (full strength)
 *   2 overrides    → demote one severity step (blocker→major, major→minor, minor→nit-skip)
 *   3+ overrides   → skip entirely (returns null)
 *
 * Returning a "nit" is intentional: nits don't escalate verdicts in
 * `highestStickyVerdict`. Returning null means caller should drop the
 * sticky and record it under calibrationSkips for visibility.
 */
function applyCalibrationToSeverity(
  base: "blocker" | "major" | "minor",
  overrides: number,
): "blocker" | "major" | "minor" | null {
  if (overrides <= 1) return base;
  if (overrides === 2) {
    if (base === "blocker") return "major";
    if (base === "major") return "minor";
    return null; // minor → skip
  }
  return null; // 3+ → skip regardless of base
}

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "to", "of", "in", "on", "for", "with", "by",
  "is", "are", "was", "were", "be", "been", "being", "it", "its", "this",
  "that", "these", "those", "at", "from", "as", "but", "not", "if", "then",
  "should", "must", "fix", "use", "add", "have", "has",
]);

function tokenize(text: string): string[] {
  // Split on punctuation AND on hyphens — `sk-prod-hardcoded-values` should
  // produce {hardcoded, values}, not the literal dash-joined string. Keep
  // underscores so identifiers like `api_key` survive as a single token.
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

function extractChangedFiles(diff: string): string[] {
  const files: string[] = [];
  for (const line of diff.split(/\r?\n/)) {
    const m = line.match(/^\+\+\+ b\/(.+?)$/);
    if (m) files.push(m[1]!);
  }
  return files;
}

function matchTokens(
  failure: FailureEntry,
  diffTokens: ReadonlySet<string>,
  minOverlap: number,
): string[] {
  const failureTokens = new Set([
    ...tokenize(failure.title),
    ...tokenize(failure.body),
    ...failure.tags.flatMap((t) => tokenize(t)),
  ]);
  const matched: string[] = [];
  for (const t of failureTokens) {
    if (diffTokens.has(t)) matched.push(t);
  }
  return matched.length >= minOverlap ? matched : [];
}

function alreadyCoveredByCouncil(
  failure: FailureEntry,
  existingByCategory: ReadonlyMap<string, readonly Blocker[]>,
  changedFiles: readonly string[],
): boolean {
  const sameCat = existingByCategory.get(failure.category);
  if (!sameCat || sameCat.length === 0) return false;
  // If the catalog entry has no file context, any same-category blocker counts as coverage.
  const seedFile = failure.seedBlocker?.file;
  if (!seedFile) return true;
  // Otherwise only suppress when the existing blocker mentions the same file (or any changed file).
  for (const b of sameCat) {
    if (b.file && (b.file === seedFile || changedFiles.includes(b.file))) return true;
  }
  return false;
}

function severityRank(s: "blocker" | "major" | "minor"): number {
  return s === "blocker" ? 3 : s === "major" ? 2 : 1;
}

function highestStickyVerdict(stickies: readonly Blocker[]): "approve" | "rework" | "reject" {
  for (const s of stickies) {
    if (s.severity === "blocker") return "reject";
  }
  for (const s of stickies) {
    if (s.severity === "major") return "rework";
  }
  // Only minor stickies remain — surface them as informational, but
  // don't override the council's verdict. (H2 #8 calibration relies on
  // this so demoted stickies stop blocking merges over time.)
  return "approve";
}

function escalateVerdict(
  current: CouncilOutcome["verdict"],
  injected: "approve" | "rework" | "reject",
): CouncilOutcome["verdict"] {
  // Strict ordering: reject > rework > approve. Never downgrade.
  if (current === "reject") return "reject";
  if (injected === "reject") return "reject";
  if (injected === "rework") return "rework";
  return current; // injected === "approve" — sticky is informational only.
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
