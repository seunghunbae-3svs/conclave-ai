export type TriagePath = "lite" | "full";

export interface TriageInput {
  /** Net lines changed (adds + deletes). */
  linesChanged: number;
  /** Number of files in the diff. */
  fileCount: number;
  /** Whether the diff touches any test files. */
  hasTests: boolean;
  /** Whether any of the changed files matches a "risky path" pattern (e.g. schema/, migrations/, auth/, payments/). */
  touchesRiskyPath: boolean;
  /** Total added/deleted characters (optional, used as a size tiebreaker). */
  sizeBytes?: number;
}

export interface TriageOptions {
  /** Under this many lines of change, a PR is considered lite-eligible. Default 40. */
  liteLineThreshold?: number;
  /** Under this many files, a PR is considered lite-eligible. Default 3. */
  liteFileThreshold?: number;
}

export interface TriageOutcome {
  path: TriagePath;
  /** Human-readable reason the path was chosen. */
  reason: string;
}

const DEFAULT_LITE_LINES = 40;
const DEFAULT_LITE_FILES = 3;

/**
 * Classifies a review as "lite" (single agent, short review) or "full" (3-round council).
 *
 * Rules in priority order:
 *   1. Risky-path touches always go full — missing a security/schema bug is more expensive than the review cost.
 *   2. Large PRs (>threshold lines OR >threshold files) go full.
 *   3. PRs that TOUCH but don't ADD tests for changed logic go full (we want the second agent to catch missing coverage).
 *   4. Everything else → lite.
 */
export function triageReview(input: TriageInput, opts: TriageOptions = {}): TriageOutcome {
  const lineThreshold = opts.liteLineThreshold ?? DEFAULT_LITE_LINES;
  const fileThreshold = opts.liteFileThreshold ?? DEFAULT_LITE_FILES;

  if (input.touchesRiskyPath) {
    return { path: "full", reason: "diff touches a risky path (schema / auth / payment / migration)" };
  }
  if (input.linesChanged > lineThreshold) {
    return { path: "full", reason: `linesChanged ${input.linesChanged} > ${lineThreshold}` };
  }
  if (input.fileCount > fileThreshold) {
    return { path: "full", reason: `fileCount ${input.fileCount} > ${fileThreshold}` };
  }
  if (!input.hasTests && input.linesChanged >= 10) {
    return { path: "full", reason: "non-trivial diff without any test files touched" };
  }
  return { path: "lite", reason: "small, low-risk, has test coverage or trivial" };
}

/** Default patterns that force a full council review when touched. */
export const DEFAULT_RISKY_PATH_PATTERNS = [
  /(^|\/)(schema|schemas)\//i,
  /(^|\/)migrations?\//i,
  /(^|\/)auth\//i,
  /(^|\/)(payment|payments|billing)\//i,
  /\.sql$/i,
  /prisma\/schema\.prisma$/i,
] as const;

export function touchesRiskyPath(
  paths: readonly string[],
  patterns: readonly RegExp[] = DEFAULT_RISKY_PATH_PATTERNS,
): boolean {
  return paths.some((p) => patterns.some((re) => re.test(p)));
}
