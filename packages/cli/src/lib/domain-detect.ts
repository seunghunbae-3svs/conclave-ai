/**
 * Domain auto-detection from changed files.
 *
 * Product principle: users change UI code, `conclave review` should
 * auto-run the Design agent alongside the code agents without any
 * config. If `--domain` is explicitly passed, we honor it. Otherwise
 * we scan the diff's changed-file list; any hit against the UI-signal
 * globs (after exclude filtering) flips the run into "mixed" mode (code
 * agents + design agent).
 *
 * v0.9.3: shared glob list + matcher + diff parser now live in
 * `@conclave-ai/core/ui-detect`. This file owns the CLI-specific
 * `detectDomain` decision tree (domain bucket + reason string) and
 * re-exports the shared primitives so existing CLI consumers keep
 * working.
 */

import {
  DEFAULT_UI_SIGNALS as CORE_DEFAULT_UI_SIGNALS,
  DEFAULT_EXCLUDES as CORE_DEFAULT_EXCLUDES,
  IMAGE_EXTS,
  pathExt,
  matchesAny,
  globToRegExp,
  extractChangedFilesFromDiff,
} from "@conclave-ai/core";
import type { ChangedFile, ChangedFileStatus } from "@conclave-ai/core";

export type { ChangedFile, ChangedFileStatus };
export { extractChangedFilesFromDiff, globToRegExp };

export interface DomainDetectionResult {
  domain: "code" | "design" | "mixed";
  reason: string;
  signals: string[];
}

export interface DomainDetectOptions {
  uiSignals?: string[];
  excludes?: string[];
}

/**
 * Default UI-signal globs. Re-exported from core; see
 * `@conclave-ai/core/ui-detect.ts` for rationale.
 */
export const DEFAULT_UI_SIGNALS: readonly string[] = CORE_DEFAULT_UI_SIGNALS;

/**
 * Default exclude globs. Re-exported from core.
 */
export const DEFAULT_EXCLUDES: readonly string[] = CORE_DEFAULT_EXCLUDES;

function summarizeSignals(signals: string[]): string {
  // Dedup extensions for a human-readable "reason" line.
  const exts = new Set<string>();
  const other: string[] = [];
  for (const s of signals) {
    const ext = pathExt(s);
    if (ext) exts.add("*" + ext);
    else other.push(s);
  }
  const parts = [...exts, ...other];
  return parts.slice(0, 6).join(", ") + (parts.length > 6 ? ", ..." : "");
}

/**
 * Inspect a changed-files list and decide whether the run is
 * code-only, design-only, or mixed.
 *
 * - Any UI-signal hit (after exclude filtering) flips to "mixed" — we
 *   keep code agents running because a design-flavored PR can still
 *   break logic and typecheck.
 * - Empty / all-excluded changed-files returns "code" with a clear
 *   reason so the caller can log it.
 * - Delete-only changes to image assets do NOT count as a UI signal.
 */
export function detectDomain(
  changedFiles: readonly ChangedFile[],
  opts: DomainDetectOptions = {},
): DomainDetectionResult {
  const uiSignals = opts.uiSignals ?? DEFAULT_UI_SIGNALS;
  const excludes = opts.excludes ?? DEFAULT_EXCLUDES;

  if (changedFiles.length === 0) {
    return {
      domain: "code",
      reason: "no changed files",
      signals: [],
    };
  }

  const signals: string[] = [];
  let allExcluded = true;
  for (const f of changedFiles) {
    if (matchesAny(f.path, excludes)) continue;
    allExcluded = false;
    // Delete-only image changes don't signal design work.
    if (f.status === "deleted" && IMAGE_EXTS.has(pathExt(f.path))) continue;
    if (matchesAny(f.path, uiSignals)) {
      signals.push(f.path);
    }
  }

  if (allExcluded) {
    return {
      domain: "code",
      reason: "all changed files excluded (node_modules / dist / tests)",
      signals: [],
    };
  }

  if (signals.length === 0) {
    return {
      domain: "code",
      reason: "no UI-signal files in diff",
      signals: [],
    };
  }

  return {
    domain: "mixed",
    reason: `changed files include ${summarizeSignals(signals)}`,
    signals,
  };
}
