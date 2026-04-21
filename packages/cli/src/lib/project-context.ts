/**
 * v0.6.4 — Auto-inject project + design context into every review.
 *
 * The council could previously only judge the diff. Real-world failure
 * (eventbadge PR #20): agents called `cli-version: latest` a "CI config
 * error" because they couldn't see the reusable-workflow `uses:` line
 * just above the hunk. Fix: inject a small, bounded slice of the repo's
 * own docs so agents know what the repo is FOR before critiquing what
 * the diff says.
 *
 * Sources (priority order):
 *   1. `README.md`                    — head slice, default 500 chars
 *   2. `.conclave/project-context.md` — full content
 *   3. `.conclave/design-context.md`  — full content (design domain only)
 *   4. `.conclave/design-reference/*.png` — up to 4 × 500KB (design only)
 *
 * Design goals:
 *   - Silent-skip missing files. Absence is normal.
 *   - NEVER read anything outside the 4 listed paths.
 *   - NEVER fetch remote assets.
 *   - Cheap — bounded size, no globbing beyond the dedicated directory.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export interface LoadProjectContextOptions {
  /** Max characters taken from the head of README.md. Default 500. */
  readmeMaxChars?: number;
}

export interface LoadDesignContextOptions {
  /** Max PNG files loaded from .conclave/design-reference/. Default 4. */
  maxReferences?: number;
  /** Max per-image size in bytes. Larger files are dropped. Default 500KB. */
  maxImageBytes?: number;
}

export interface LoadedProjectContext {
  /**
   * Combined README head + `.conclave/project-context.md` full content,
   * separated by a clear divider. Absent when neither source exists.
   */
  projectContext?: string;
}

export interface LoadedDesignContext {
  /** Full content of `.conclave/design-context.md`, if present. */
  designContext?: string;
  /** Reference PNGs, each ≤ maxImageBytes; capped at maxReferences entries. */
  designReferences?: Array<{ filename: string; bytes: Buffer }>;
}

const DEFAULT_README_MAX_CHARS = 500;
const DEFAULT_MAX_REFERENCES = 4;
const DEFAULT_MAX_IMAGE_BYTES = 512_000;
const TRUNCATION_MARKER = "\n... (truncated)";

/**
 * Cut a string at the nearest word boundary ≤ `maxChars`. Appends a
 * `... (truncated)` suffix when the cut actually drops content. Words
 * that themselves exceed the budget are hard-cut (no infinite loop).
 */
export function truncateOnWordBoundary(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  // Look for the last whitespace or newline at or before `maxChars`.
  // Scan backwards up to 120 chars — if we find none, fall back to a
  // hard cut. 120 is a heuristic: long enough to land on a word break
  // in prose, short enough that the head stays close to the budget.
  const windowStart = Math.max(0, maxChars - 120);
  const slice = text.slice(0, maxChars);
  const m = /[\s\n]\S*$/.exec(slice.slice(windowStart));
  let cut = maxChars;
  if (m && typeof m.index === "number") {
    cut = windowStart + m.index;
  }
  // Guard — never return empty when there's content to take.
  if (cut <= 0) cut = Math.min(maxChars, text.length);
  return text.slice(0, cut).trimEnd() + TRUNCATION_MARKER;
}

async function readIfExists(p: string): Promise<string | undefined> {
  try {
    return await fs.readFile(p, "utf8");
  } catch (err) {
    // ENOENT = file absent (expected). Any other error — still silent;
    // we don't want a broken permission or bad symlink to fail the run.
    const code = (err as NodeJS.ErrnoException).code;
    if (code && code !== "ENOENT") {
      // intentionally swallow — review continues without this source
    }
    return undefined;
  }
}

/**
 * Load README head + .conclave/project-context.md for every review.
 * Returns `{ projectContext: undefined }` when both sources are absent.
 */
export async function loadProjectContext(
  cwd: string,
  opts: LoadProjectContextOptions = {},
): Promise<LoadedProjectContext> {
  const readmeMaxChars = opts.readmeMaxChars ?? DEFAULT_README_MAX_CHARS;

  const [rawReadme, projectCtxFile] = await Promise.all([
    readIfExists(path.join(cwd, "README.md")),
    readIfExists(path.join(cwd, ".conclave", "project-context.md")),
  ]);

  const sections: string[] = [];
  if (rawReadme && rawReadme.trim().length > 0) {
    const head = truncateOnWordBoundary(rawReadme.trimStart(), readmeMaxChars);
    sections.push(`## README (head)\n${head}`);
  }
  if (projectCtxFile && projectCtxFile.trim().length > 0) {
    sections.push(`## .conclave/project-context.md\n${projectCtxFile.trim()}`);
  }
  if (sections.length === 0) {
    return {};
  }
  return { projectContext: sections.join("\n\n") };
}

/**
 * Load design-only context for DesignAgent runs:
 *   - `.conclave/design-context.md`     — brand/tone/a11y/persona text
 *   - `.conclave/design-reference/*.png` — up to N images, each ≤ M bytes
 *
 * Returns an empty object when the design-context file is absent AND
 * the reference directory is empty / missing. Silent-skips oversize
 * images (they get dropped, not erroring out).
 */
export async function loadDesignContext(
  cwd: string,
  opts: LoadDesignContextOptions = {},
): Promise<LoadedDesignContext> {
  const maxReferences = opts.maxReferences ?? DEFAULT_MAX_REFERENCES;
  const maxImageBytes = opts.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;

  const designCtxText = await readIfExists(
    path.join(cwd, ".conclave", "design-context.md"),
  );

  // Reference images — we only scan the ONE designated directory.
  // No recursion, no glob-across-repo, no remote fetch.
  const refsDir = path.join(cwd, ".conclave", "design-reference");
  let references: Array<{ filename: string; bytes: Buffer }> = [];
  try {
    const entries = await fs.readdir(refsDir, { withFileTypes: true });
    // Sort for deterministic order — matches `ls` lexical ordering so
    // users can control priority by filename prefix (e.g. "01-*.png").
    const pngNames = entries
      .filter((e) => e.isFile() && /\.png$/i.test(e.name))
      .map((e) => e.name)
      .sort();

    for (const name of pngNames) {
      if (references.length >= maxReferences) break;
      const full = path.join(refsDir, name);
      try {
        const stat = await fs.stat(full);
        if (stat.size > maxImageBytes) {
          // Oversize image — dropped silently per spec. Only the
          // `--verbose` flow would surface a warning; the loader keeps
          // quiet so the review pipeline never noises up stderr.
          continue;
        }
        const bytes = await fs.readFile(full);
        references.push({ filename: name, bytes });
      } catch {
        // Skip unreadable file; continue with siblings.
      }
    }
  } catch (err) {
    // ENOENT = directory absent, which is the normal case. Any other
    // error — still silent; we don't want perms to break reviews.
    const code = (err as NodeJS.ErrnoException).code;
    if (code && code !== "ENOENT") {
      references = [];
    }
  }

  const out: LoadedDesignContext = {};
  if (designCtxText && designCtxText.trim().length > 0) {
    out.designContext = designCtxText.trim();
  }
  if (references.length > 0) {
    out.designReferences = references;
  }
  return out;
}
