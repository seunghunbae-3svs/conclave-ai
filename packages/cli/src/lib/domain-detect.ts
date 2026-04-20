/**
 * Domain auto-detection from changed files.
 *
 * Product principle: users change UI code, `conclave review` should
 * auto-run the Design agent alongside the code agents without any
 * config. If `--domain` is explicitly passed, we honor it. Otherwise
 * we scan the diff's changed-file list; any hit against the UI-signal
 * globs flips the run into "mixed" mode (code agents + design agent).
 *
 * No external deps — ships an inline glob-to-RegExp matcher covering
 * `**`, `*`, `{a,b}` alternation, and `[...]` character classes. That's
 * enough for the default signal list; users can override both the
 * UI-signal and exclude globs via `.conclaverc.json > autoDetect`.
 */

export type ChangedFileStatus = "added" | "modified" | "deleted" | "renamed";

export interface ChangedFile {
  path: string;
  status: ChangedFileStatus;
}

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
 * Default UI-signal globs. Any changed file whose path matches ONE of
 * these (after exclude filtering) flags the run as design-relevant.
 *
 * Image signals intentionally exclude delete-only changes — a deleted
 * asset is more often a code cleanup than a design change. Added /
 * modified / renamed images still count.
 */
export const DEFAULT_UI_SIGNALS: readonly string[] = [
  "**/*.{tsx,jsx,vue,svelte,astro}",
  "**/*.{css,scss,sass,less,styl,pcss}",
  "**/tailwind.config.{js,ts,cjs,mjs}",
  "**/postcss.config.{js,ts,cjs,mjs}",
  "**/*.{html,htm}",
  "**/tokens/**",
  "**/design-system/**",
  "**/theme.{js,ts,json}",
  "**/*.{svg,png,webp,avif}",
];

/**
 * Default exclude globs. Runs before UI-signal matching — a file that
 * matches ANY exclude is dropped entirely. Tests and build artifacts
 * should never trigger design review.
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
 * Image extensions — delete-only changes to these are NOT a signal.
 * Everything else in the UI-signal list triggers regardless of status.
 */
const IMAGE_EXTS = new Set([".svg", ".png", ".webp", ".avif"]);

function pathExt(p: string): string {
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
 *   - `[abc]` / `[!abc]` → character class (passthrough with `!`→`^`)
 *
 * Matches the full path (anchored). Case-insensitive — filesystems on
 * Windows/macOS are case-insensitive and CI on Linux matches lowercase
 * canonical paths anyway, so case-insensitive is the safer default.
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**` — zero or more segments. If followed by `/`, consume the
        // slash too so `a/**/b` matches `a/b`.
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

function matchesAny(path: string, patterns: readonly string[]): string | null {
  // Normalize Windows-style separators so CLI consumers can pass raw
  // paths from either platform.
  const p = path.replace(/\\/g, "/");
  for (const glob of patterns) {
    const re = globToRegExp(glob);
    if (re.test(p)) return glob;
  }
  return null;
}

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
 * - Any UI-signal hit flips to "mixed" (we keep code agents running —
 *   a design-flavored PR can still break logic and typecheck).
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

/**
 * Parse changed files out of a unified diff. Works with the output of
 * `git diff`, `gh pr diff`, or a saved .diff file — same format.
 *
 * We don't need perfect classification here; enough is enough to drive
 * the signal match. "added" = `new file mode`, "deleted" = `deleted
 * file mode`, "renamed" = `rename to`, else "modified".
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
      // diff --git a/<path> b/<path>
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
