/**
 * UI / design-surface detection — shared primitives.
 *
 * Two callsites consume these:
 *   1. `@conclave-ai/cli` (`lib/domain-detect.ts`) — decides whether a PR
 *      counts as `code` / `design` / `mixed` so the runner spins up the
 *      Design agent.
 *   2. `@conclave-ai/agent-design` (`ui-globs.ts`) — once the Design
 *      agent IS running and no screenshots are attached, it dispatches
 *      Mode B vs. Mode C using `diffTouchesUi(diff)` here.
 *
 * Owning the glob list + matcher in one place removes the v0.5.4
 * "duplicated locally with TODO" debt and guarantees the two layers
 * cannot drift.
 */

export type ChangedFileStatus = "added" | "modified" | "deleted" | "renamed";

export interface ChangedFile {
  path: string;
  status: ChangedFileStatus;
}

export interface UiDetectOptions {
  uiSignals?: readonly string[];
  excludes?: readonly string[];
}

/**
 * Default UI-signal globs. Any path that matches at least one of these
 * (and no exclude) counts as a UI surface for both `detectDomain` and
 * `diffTouchesUi`.
 *
 * The list is the union of v0.5.3 (CLI domain-detect) and v0.5.4
 * (agent-design ui-globs) signals so neither callsite loses coverage:
 *
 *   - Component / page / template extensions
 *   - Style sheets (.css / .scss / .sass / .less / .styl / .pcss)
 *   - Configs that drive design output (tailwind, postcss)
 *   - Plain markup (.html / .htm / .mdx)
 *   - Image / asset extensions (signal only when ADDED/MODIFIED — the
 *     `detectDomain` caller in CLI applies the delete-only carve-out
 *     before `matchesAny` is consulted; agent-design's `isUiPath` does
 *     not need that nuance because the diff already says what changed)
 *   - Fragment directories that strongly imply UI even when a single
 *     file is `.ts` rather than `.tsx` (`components/`, `ui/`, `pages/`,
 *     `views/`, `layouts/`, `theme/`, `tokens/`, `styles/`,
 *     `design-system/`)
 */
export const DEFAULT_UI_SIGNALS: readonly string[] = [
  "**/*.{tsx,jsx,vue,svelte,astro}",
  "**/*.{css,scss,sass,less,styl,pcss}",
  "**/tailwind.config.{js,ts,cjs,mjs}",
  "**/postcss.config.{js,ts,cjs,mjs}",
  "**/*.{html,htm,mdx}",
  "**/tokens/**",
  "**/design-system/**",
  "**/components/**",
  "**/ui/**",
  "**/pages/**",
  "**/views/**",
  "**/layouts/**",
  "**/theme/**",
  "**/styles/**",
  "**/theme.{js,ts,json}",
  "**/*.{svg,png,webp,avif}",
];

/**
 * Default excludes — runs before UI-signal matching. A file matching any
 * exclude is dropped entirely (treated as non-UI).
 */
export const DEFAULT_EXCLUDES: readonly string[] = [
  "node_modules/**",
  "**/node_modules/**",
  "dist/**",
  "**/dist/**",
  "build/**",
  "**/build/**",
  "coverage/**",
  "**/coverage/**",
  ".next/**",
  "**/.next/**",
  "out/**",
  "**/out/**",
  "**/*.test.{ts,tsx,js,jsx,mjs,cjs}",
  "**/*.spec.{ts,tsx,js,jsx,mjs,cjs}",
];

/**
 * Image extensions — delete-only changes to these are NOT a domain
 * signal. Exposed so CLI's `detectDomain` can apply the carve-out
 * without re-listing the extensions.
 */
export const IMAGE_EXTS: ReadonlySet<string> = new Set([
  ".svg",
  ".png",
  ".webp",
  ".avif",
]);

export function pathExt(p: string): string {
  const i = p.lastIndexOf(".");
  if (i < 0) return "";
  return p.slice(i).toLowerCase();
}

/**
 * Inline glob → RegExp converter.
 *
 * Supports:
 *   - `**`   → zero or more path segments
 *   - `*`    → anything except `/`
 *   - `?`    → single char except `/`
 *   - `{a,b}` → alternation (non-nested)
 *   - `[abc]` / `[!abc]` → character class (`!`→`^`)
 *
 * Returns a case-insensitive, fully-anchored RegExp. Filesystems on
 * Windows / macOS are case-insensitive and Linux CI runs lowercase
 * canonical paths, so case-insensitive is the safer default.
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else if (c === "{") {
      const close = glob.indexOf("}", i);
      if (close < 0) {
        re += "\\{";
        i += 1;
      } else {
        const alts = glob.slice(i + 1, close).split(",");
        re += "(?:" + alts.map(escapeRegex).join("|") + ")";
        i = close + 1;
      }
    } else if (c === "[") {
      const close = glob.indexOf("]", i);
      if (close < 0) {
        re += "\\[";
        i += 1;
      } else {
        let body = glob.slice(i + 1, close);
        if (body.startsWith("!")) body = "^" + body.slice(1);
        re += "[" + body + "]";
        i = close + 1;
      }
    } else if (/[.+^$()|\\]/.test(c)) {
      re += "\\" + c;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  return new RegExp("^" + re + "$", "i");
}

function escapeRegex(s: string): string {
  let out = "";
  for (const c of s) {
    if (c === "*") {
      out += "[^/]*";
    } else if (/[.+^$()|\\?\[\]{}]/.test(c)) {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  return out;
}

/**
 * Returns the glob that matched, or `null`. Normalizes Windows-style
 * separators so callers can pass raw paths from either platform.
 */
export function matchesAny(path: string, patterns: readonly string[]): string | null {
  const p = path.replace(/\\/g, "/");
  for (const glob of patterns) {
    const re = globToRegExp(glob);
    if (re.test(p)) return glob;
  }
  return null;
}

/**
 * Decide whether a single path is a UI / rendered-surface file.
 *
 * Honors `excludes` first (so a `.test.tsx` doesn't trip), then
 * `uiSignals`. Defaults to `DEFAULT_UI_SIGNALS` / `DEFAULT_EXCLUDES`.
 */
export function isUiPath(path: string, opts: UiDetectOptions = {}): boolean {
  const uiSignals = opts.uiSignals ?? DEFAULT_UI_SIGNALS;
  const excludes = opts.excludes ?? DEFAULT_EXCLUDES;
  if (matchesAny(path, excludes)) return false;
  return matchesAny(path, uiSignals) !== null;
}

/**
 * Filter a path list down to its UI subset, preserving order.
 */
export function filterUiFiles(
  files: readonly string[],
  opts: UiDetectOptions = {},
): string[] {
  return files.filter((f) => isUiPath(f, opts));
}

/**
 * Cheap "does this diff touch any UI surface" check — reads only the
 * `diff --git a/... b/...` headers. Used by `DesignAgent` Mode B/C
 * dispatch.
 */
export function diffTouchesUi(diff: string, opts: UiDetectOptions = {}): boolean {
  const re = /^diff --git a\/(\S+)\s+b\/(\S+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(diff)) !== null) {
    const aPath = m[1] ?? "";
    const bPath = m[2] ?? "";
    if (isUiPath(aPath, opts) || isUiPath(bPath, opts)) return true;
  }
  return false;
}

/**
 * Pull the post-image (b/) paths out of a unified diff. Order-preserving
 * and deduped. For status-aware extraction use `extractChangedFilesFromDiff`.
 */
export function extractChangedFilePaths(diff: string): string[] {
  const out = new Set<string>();
  const re = /^diff --git a\/(\S+)\s+b\/(\S+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(diff)) !== null) {
    out.add(m[2] ?? m[1] ?? "");
  }
  return Array.from(out).filter((p) => p.length > 0);
}

/**
 * Parse a unified diff into `{path, status}` records. `added` =
 * `new file mode`, `deleted` = `deleted file mode`, `renamed` = `rename
 * to`, else `modified`. Robust to `gh pr diff` / saved `.diff` files.
 */
export function extractChangedFilesFromDiff(diff: string): ChangedFile[] {
  if (!diff) return [];
  const files: ChangedFile[] = [];
  const lines = diff.split(/\r?\n/);
  let currentPath: string | null = null;
  let currentStatus: ChangedFileStatus = "modified";
  let currentRenameTo: string | null = null;

  const flush = () => {
    if (currentPath) {
      const finalPath = currentRenameTo ?? currentPath;
      files.push({ path: finalPath, status: currentStatus });
    }
    currentPath = null;
    currentStatus = "modified";
    currentRenameTo = null;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (m) {
        currentPath = m[2]!;
        currentStatus = "modified";
      }
      continue;
    }
    if (line.startsWith("new file mode")) {
      currentStatus = "added";
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      currentStatus = "deleted";
      continue;
    }
    if (line.startsWith("rename from ")) {
      currentStatus = "renamed";
      continue;
    }
    if (line.startsWith("rename to ")) {
      currentStatus = "renamed";
      currentRenameTo = line.slice("rename to ".length).trim();
      continue;
    }
  }
  flush();
  return files;
}
