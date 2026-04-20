/**
 * UI file globs — used by DesignAgent's Mode B (text-UI review) to detect
 * whether a code-only diff touches any UI surfaces.
 *
 * TODO(v0.5.5 refactor): `packages/cli/src/lib/domain-detect.ts` (v0.5.3) is
 * now on main. The shared glob + match logic belongs in `@conclave-ai/core`
 * — both CLI (domain-detect) and agent-design (this file) should re-export
 * from core so the two detectors can't drift. For v0.5.4 we keep the local
 * copy to avoid inverting the package dependency graph (agent → cli). Move
 * it in a dedicated v0.5.5 cleanup PR.
 *
 * The list deliberately errs on the inclusive side: it's better to run
 * Mode B on a diff with some non-UI files than to miss a UI change buried
 * in a large PR. Mode C (skip) triggers only when *no* file in the diff
 * matches any of these patterns.
 */

/**
 * File-extension patterns that indicate UI / rendered surfaces. The
 * matcher treats these as case-insensitive suffix checks against each
 * `diff --git a/... b/...` header in the unified diff.
 */
export const UI_EXTENSIONS: readonly string[] = [
  // React / JSX family
  ".tsx",
  ".jsx",
  // Vue / Svelte single-file components
  ".vue",
  ".svelte",
  // Styling
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".styl",
  // Plain markup
  ".html",
  ".htm",
  // Astro pages
  ".astro",
  // Template / dotfile pairs that commonly hold UI
  ".mdx",
];

/**
 * Path-fragment patterns that strongly suggest UI code even when the
 * extension alone isn't decisive (e.g. a `.ts` file under `components/`
 * or `theme/`). Case-insensitive substring match. Fragments starting
 * with `/` also match when the pattern appears at the start of the path
 * (i.e. `theme/foo.ts` matches `/theme/`).
 */
export const UI_PATH_FRAGMENTS: readonly string[] = [
  "/components/",
  "/ui/",
  "/pages/",
  "/views/",
  "/layouts/",
  "/theme/",
  "/tokens/",
  "/styles/",
  "/design-system/",
  "tailwind.config",
  "postcss.config",
];

/**
 * Extract the set of file paths touched by a unified diff. Reads only the
 * `diff --git` headers — cheap, no full parsing, and robust to the fact
 * that we only need post-image paths for glob matching.
 */
export function extractChangedFiles(diff: string): string[] {
  const out = new Set<string>();
  const re = /^diff --git a\/(\S+)\s+b\/(\S+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(diff)) !== null) {
    // Prefer the `b/` (post-image) path; fall back to `a/` when identical.
    out.add(m[2] ?? m[1] ?? "");
  }
  return Array.from(out).filter((p) => p.length > 0);
}

/** True when the path looks like a UI / rendered-surface file. */
export function isUiPath(path: string): boolean {
  const lower = path.toLowerCase();
  for (const ext of UI_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  for (const frag of UI_PATH_FRAGMENTS) {
    if (lower.includes(frag)) return true;
    // `/x/` fragments should also match when they appear at the start of
    // the path (no leading slash in the stored path).
    if (frag.startsWith("/") && lower.startsWith(frag.slice(1))) return true;
  }
  return false;
}

/**
 * Filter a file list down to the UI subset. Returns the same ordering as
 * the input so callers can map back to the original change order.
 */
export function filterUiFiles(files: readonly string[]): string[] {
  return files.filter(isUiPath);
}

/**
 * Quick detector — true iff the diff touches at least one UI file. Used
 * by DesignAgent to decide between Mode B and Mode C when no visual
 * artifacts are present.
 */
export function diffTouchesUi(diff: string): boolean {
  const re = /^diff --git a\/(\S+)\s+b\/(\S+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(diff)) !== null) {
    const aPath = m[1] ?? "";
    const bPath = m[2] ?? "";
    if (isUiPath(aPath) || isUiPath(bPath)) return true;
  }
  return false;
}
