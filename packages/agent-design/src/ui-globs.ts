/**
 * UI file detection — used by DesignAgent's Mode B (text-UI review) to
 * decide whether a code-only diff touches any UI surfaces.
 *
 * v0.9.3 (Apr 2026): the canonical glob list, exclude list, and matcher
 * primitives now live in `@conclave-ai/core/ui-detect`. This file is a
 * thin re-export so the CLI's domain-detect and the DesignAgent's
 * Mode B/C dispatch share one source of truth — the v0.5.4 TODO is
 * resolved.
 *
 * The list deliberately errs inclusive: better to run Mode B on a diff
 * with some non-UI files than miss a UI change buried in a large PR.
 * Mode C (skip) triggers only when *no* file in the diff matches.
 */

import {
  isUiPath as coreIsUiPath,
  filterUiFiles as coreFilterUiFiles,
  diffTouchesUi as coreDiffTouchesUi,
  extractChangedFilePaths,
} from "@conclave-ai/core";

/** True when the path looks like a UI / rendered-surface file. */
export function isUiPath(path: string): boolean {
  return coreIsUiPath(path);
}

/**
 * Filter a file list down to the UI subset. Returns the same ordering
 * as the input so callers can map back to original change order.
 */
export function filterUiFiles(files: readonly string[]): string[] {
  return coreFilterUiFiles(files);
}

/**
 * Quick detector — true iff the diff touches at least one UI file.
 * Used by DesignAgent to decide between Mode B and Mode C when no
 * visual artifacts are present.
 */
export function diffTouchesUi(diff: string): boolean {
  return coreDiffTouchesUi(diff);
}

/**
 * Extract the set of file paths touched by a unified diff. Reads only
 * the `diff --git` headers — cheap, no full parsing.
 */
export function extractChangedFiles(diff: string): string[] {
  return extractChangedFilePaths(diff);
}
