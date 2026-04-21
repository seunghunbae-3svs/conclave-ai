/**
 * File discovery for `conclave audit` (v0.6.0).
 *
 * Walks the repo rooted at `cwd`, respects `.gitignore` + `.conclaveignore`,
 * drops binaries and generated artifacts, categorizes each surviving file
 * (ui / code / infra / docs / test), filters by --scope + --include /
 * --exclude, and — when the total exceeds --max-files — samples a
 * category-representative subset biased toward recently-modified files.
 *
 * No external deps beyond node:fs / node:path and the inline glob matcher
 * re-used from `./domain-detect.js`. We deliberately avoid shelling out to
 * `git ls-files` because the CLI targets installs where git metadata may
 * be absent (e.g. a fresh scaffold before the first commit).
 */

import fs from "node:fs";
import path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { globToRegExp } from "./domain-detect.js";

const execFile = promisify(execFileCb);

export type AuditCategory = "ui" | "code" | "infra" | "docs" | "test";
export type AuditScope = "all" | AuditCategory;

export interface DiscoveredFile {
  /** Path relative to `cwd`. Forward-slash normalized on all platforms. */
  path: string;
  category: AuditCategory;
  sizeBytes: number;
  /** Epoch ms of last modification. Used for recency-sorted sampling. */
  mtimeMs: number;
}

export interface DiscoveryOptions {
  cwd: string;
  scope?: AuditScope;
  maxFiles?: number;
  include?: readonly string[];
  exclude?: readonly string[];
  /**
   * Shared with v0.5.3 domain-detect. When a file matches one of these
   * globs AND isn't excluded, we tag it `ui`.
   */
  uiSignals?: readonly string[];
  /**
   * When true, try to sort candidates by git-log recency (last 90 days
   * bias). Falls back to mtime when git isn't available.
   */
  useGitRecency?: boolean;
}

export interface DiscoveryResult {
  /** Files selected for audit. Respects maxFiles + sampling. */
  files: DiscoveredFile[];
  /** Total files that matched scope/include/exclude before sampling. */
  totalMatched: number;
  /** True when sampling was applied (totalMatched > maxFiles). */
  sampled: boolean;
  /** Reason the discovery returned what it did — surfaced to the user. */
  reason: string;
}

// ─── Constants / default lists ────────────────────────────────────────

/** UI-signal globs mirror v0.5.3's DEFAULT_UI_SIGNALS. Extended deliberately
 *  for audit-mode — we count markdown and astro as "ui/docs" respectively. */
export const DEFAULT_UI_SIGNALS: readonly string[] = [
  "**/*.{tsx,jsx,vue,svelte,astro}",
  "**/*.{css,scss,sass,less,styl,pcss}",
  "**/tailwind.config.{js,ts,cjs,mjs}",
  "**/postcss.config.{js,ts,cjs,mjs}",
  "**/*.{html,htm}",
  "**/tokens/**",
  "**/design-system/**",
  "**/theme.{js,ts,json}",
];

const DOC_GLOBS: readonly string[] = [
  "**/*.md",
  "**/*.mdx",
  "**/*.rst",
  "**/*.txt",
];

const TEST_GLOBS: readonly string[] = [
  "**/*.test.{ts,tsx,js,jsx,mjs,cjs}",
  "**/*.spec.{ts,tsx,js,jsx,mjs,cjs}",
  "**/test/**",
  "**/tests/**",
  "**/__tests__/**",
];

const INFRA_GLOBS: readonly string[] = [
  "**/Dockerfile",
  "**/docker-compose.{yml,yaml}",
  "**/*.{yml,yaml}",
  "**/wrangler.toml",
  "**/vercel.json",
  "**/netlify.toml",
  "**/.github/workflows/**",
  "**/terraform/**",
  "**/*.tf",
  "**/Makefile",
];

const CODE_GLOBS: readonly string[] = [
  "**/*.{ts,js,mjs,cjs,py,go,rs,rb,java,kt,swift,php,c,cpp,h,hpp,cs}",
];

/**
 * Always-excluded path fragments. Dropped BEFORE any other matching —
 * a file matching one of these never appears in the result set. Tuned
 * for the JS/TS ecosystem but harmless on polyglot repos.
 */
const DEFAULT_HARD_EXCLUDES: readonly string[] = [
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
  ".turbo/**",
  "**/.turbo/**",
  ".cache/**",
  "**/.cache/**",
  ".vercel/**",
  "**/.vercel/**",
  ".git/**",
  "**/.git/**",
  "**/.tsbuildinfo",
  "**/*.min.{js,css}",
  "**/*.map",
  "**/*.lock",
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  "**/bun.lockb",
  "**/Cargo.lock",
  "**/poetry.lock",
];

/**
 * Binary file extensions — we never send these to an LLM. Extensions here
 * override any include/scope match.
 */
const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".ico",
  ".pdf", ".zip", ".tar", ".gz", ".tgz", ".bz2", ".7z", ".rar",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp3", ".mp4", ".webm", ".mov", ".avi", ".mkv",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".o", ".a",
  ".class", ".pyc", ".wasm", ".bundle",
  // svg is text but rarely high-signal for audit, and we still let domain-detect
  // treat it as a UI signal in review-mode. Skip in audit.
  ".svg",
]);

/**
 * Text-file extensions we always allow regardless of category — prevents
 * surprise skips of CI / lint / editor config files when scope=infra.
 */
const ALWAYS_TEXT_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".rb", ".java", ".kt", ".swift", ".php",
  ".c", ".cpp", ".h", ".hpp", ".cs", ".m",
  ".css", ".scss", ".sass", ".less", ".styl", ".pcss",
  ".html", ".htm", ".vue", ".svelte", ".astro",
  ".md", ".mdx", ".rst", ".txt",
  ".json", ".yaml", ".yml", ".toml", ".xml", ".ini", ".env",
  ".sh", ".bash", ".zsh", ".ps1", ".bat", ".cmd",
  ".tf", ".hcl", ".sql", ".graphql", ".gql",
  ".dockerfile",
]);

// ─── ignore-file parsing ──────────────────────────────────────────────

/**
 * Parse `.gitignore` / `.conclaveignore` format into a glob list the
 * inline matcher understands. Blank + comment lines dropped. `!`-prefix
 * (negation) is rare; when present we prefix the stored entry with `!`
 * and the caller filters in two passes.
 *
 * Leading `/` means repo-root anchored; stored without the leading slash
 * so the globToRegExp matcher anchors the full path anyway.
 */
export function parseIgnoreFile(contents: string): string[] {
  const out: string[] = [];
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    let glob = line;
    if (glob.startsWith("/")) glob = glob.slice(1);
    // Trailing slash means "directory" in gitignore; we emit both a
    // directory-equivalent glob AND the bare form so the matcher catches
    // entries inside it.
    if (glob.endsWith("/")) {
      const dir = glob.slice(0, -1);
      out.push(dir + "/**");
      out.push("**/" + dir + "/**");
    } else {
      out.push(glob);
      // Also match deep — `src/foo.ts` in gitignore should match any
      // `foo.ts` under `src/`. Inline globs starting with `**/` are fine.
      if (!glob.startsWith("**/") && !glob.includes("/")) {
        out.push("**/" + glob);
      }
    }
  }
  return out;
}

async function readIgnoreFile(p: string): Promise<string[]> {
  try {
    const s = await fs.promises.readFile(p, "utf8");
    return parseIgnoreFile(s);
  } catch {
    return [];
  }
}

// ─── categorization ───────────────────────────────────────────────────

function matchesAny(normPath: string, patterns: readonly string[]): string | null {
  for (const g of patterns) {
    const re = globToRegExp(g);
    if (re.test(normPath)) return g;
  }
  return null;
}

/**
 * Assign a category. Priority: test → ui → infra → docs → code. "Test"
 * takes precedence so a `Button.test.tsx` is test, not ui.
 */
export function categorize(
  filePath: string,
  opts: { uiSignals?: readonly string[] } = {},
): AuditCategory {
  const p = filePath.replace(/\\/g, "/");
  if (matchesAny(p, TEST_GLOBS)) return "test";
  const ui = opts.uiSignals ?? DEFAULT_UI_SIGNALS;
  if (matchesAny(p, ui)) return "ui";
  if (matchesAny(p, INFRA_GLOBS)) return "infra";
  if (matchesAny(p, DOC_GLOBS)) return "docs";
  if (matchesAny(p, CODE_GLOBS)) return "code";
  // Fallback: if the extension is a known text extension, call it code.
  const ext = path.extname(p).toLowerCase();
  if (ALWAYS_TEXT_EXTS.has(ext)) return "code";
  return "code";
}

// ─── filesystem walk ──────────────────────────────────────────────────

/**
 * Recursive walk that respects the compiled ignore-set at each step.
 * Returns paths relative to `cwd`, normalized with forward slashes.
 *
 * Symlinks: not followed. Hidden dirs starting with `.` are walked
 * (ignore patterns handle `.git` etc.) — users sometimes have source
 * under `.config/` and skipping all dotdirs would mystify them.
 */
async function walk(
  cwd: string,
  ignores: readonly string[],
): Promise<Array<{ rel: string; sizeBytes: number; mtimeMs: number }>> {
  const out: Array<{ rel: string; sizeBytes: number; mtimeMs: number }> = [];
  async function recurse(dir: string, relDir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
      // Cheap early exit on hard-coded + user-supplied ignores.
      const relDirMarker = rel + "/";
      if (matchesAny(rel, ignores) || matchesAny(relDirMarker, ignores)) continue;
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        await recurse(abs, rel);
        continue;
      }
      if (!ent.isFile()) continue;
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(abs);
      } catch {
        continue;
      }
      out.push({ rel, sizeBytes: stat.size, mtimeMs: stat.mtimeMs });
    }
  }
  await recurse(cwd, "");
  return out;
}

// ─── binary detection ─────────────────────────────────────────────────

export function isBinaryExtension(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return BINARY_EXTS.has(ext);
}

// ─── scope + filter logic ─────────────────────────────────────────────

function scopeMatches(category: AuditCategory, scope: AuditScope): boolean {
  if (scope === "all") return category !== "test"; // tests never audited by default
  return category === scope;
}

// ─── git recency ──────────────────────────────────────────────────────

/**
 * Return a mapping of path → last-commit-epoch-ms for files touched in
 * the last 90 days. Returns an empty map when git isn't available or
 * the cwd isn't a git repo — callers fall back to mtime.
 */
async function gitRecencyMap(cwd: string): Promise<Map<string, number>> {
  try {
    const { stdout } = await execFile(
      "git",
      [
        "-C",
        cwd,
        "log",
        "--name-only",
        "--pretty=format:%ct",
        "--since=90.days.ago",
      ],
      { maxBuffer: 20 * 1024 * 1024 },
    );
    const map = new Map<string, number>();
    let currentTs = 0;
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      if (/^\d+$/.test(line.trim())) {
        currentTs = Number.parseInt(line.trim(), 10) * 1000;
        continue;
      }
      if (currentTs === 0) continue;
      const existing = map.get(line);
      if (existing === undefined || existing < currentTs) {
        map.set(line, currentTs);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

// ─── sampling ─────────────────────────────────────────────────────────

/**
 * Round-robin category sampling — take one from each category until
 * `maxFiles` is hit. Within a category files are pre-sorted by recency
 * so the "first N" from each bucket are the most-recent. Guarantees that
 * a 40-file cap on a repo of 1,000 files still hits every non-empty
 * category at least once (assuming ≥5 categories present).
 */
function sampleCategoryBalanced(
  files: DiscoveredFile[],
  maxFiles: number,
): DiscoveredFile[] {
  if (files.length <= maxFiles) return files;
  const byCat = new Map<AuditCategory, DiscoveredFile[]>();
  for (const f of files) {
    const list = byCat.get(f.category) ?? [];
    list.push(f);
    byCat.set(f.category, list);
  }
  // Pre-sort each bucket by recency (newest first).
  for (const [, list] of byCat) {
    list.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }
  const out: DiscoveredFile[] = [];
  const cursors = new Map<AuditCategory, number>();
  const cats = Array.from(byCat.keys());
  while (out.length < maxFiles) {
    let appendedThisRound = false;
    for (const cat of cats) {
      if (out.length >= maxFiles) break;
      const list = byCat.get(cat)!;
      const idx = cursors.get(cat) ?? 0;
      if (idx >= list.length) continue;
      out.push(list[idx]!);
      cursors.set(cat, idx + 1);
      appendedThisRound = true;
    }
    if (!appendedThisRound) break;
  }
  return out;
}

// ─── public API ───────────────────────────────────────────────────────

export async function discoverAuditFiles(opts: DiscoveryOptions): Promise<DiscoveryResult> {
  const cwd = path.resolve(opts.cwd);
  const scope: AuditScope = opts.scope ?? "all";
  const maxFiles = opts.maxFiles ?? 40;
  if (maxFiles <= 0) {
    return { files: [], totalMatched: 0, sampled: false, reason: "max-files ≤ 0 — nothing to audit" };
  }

  // Load ignore sources.
  const gitIgnore = await readIgnoreFile(path.join(cwd, ".gitignore"));
  const conclaveIgnore = await readIgnoreFile(path.join(cwd, ".conclaveignore"));
  const ignores: string[] = [
    ...DEFAULT_HARD_EXCLUDES,
    ...gitIgnore,
    ...conclaveIgnore,
    ...(opts.exclude ?? []),
  ];

  // Walk the tree.
  const walked = await walk(cwd, ignores);

  // Filter: no binaries, apply --include (if supplied).
  const include = opts.include && opts.include.length > 0 ? opts.include : null;
  const staged: DiscoveredFile[] = [];
  for (const w of walked) {
    if (isBinaryExtension(w.rel)) continue;
    // If --include is set, the file must match at least one include glob.
    if (include) {
      if (!matchesAny(w.rel, include)) continue;
    }
    const category = categorize(w.rel, { uiSignals: opts.uiSignals ?? DEFAULT_UI_SIGNALS });
    if (!scopeMatches(category, scope)) continue;
    staged.push({
      path: w.rel,
      category,
      sizeBytes: w.sizeBytes,
      mtimeMs: w.mtimeMs,
    });
  }

  const totalMatched = staged.length;
  if (totalMatched === 0) {
    return {
      files: [],
      totalMatched: 0,
      sampled: false,
      reason: `no files matched scope=${scope} after exclusions`,
    };
  }

  // Sort globally by recency first — surfaces the "fresh" files even when
  // maxFiles isn't a binding constraint.
  const gitMap = opts.useGitRecency === false ? new Map<string, number>() : await gitRecencyMap(cwd);
  for (const f of staged) {
    const git = gitMap.get(f.path);
    if (git !== undefined) f.mtimeMs = Math.max(f.mtimeMs, git);
  }
  staged.sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (totalMatched <= maxFiles) {
    return {
      files: staged,
      totalMatched,
      sampled: false,
      reason: `${totalMatched} files matched — under max-files=${maxFiles}, auditing all`,
    };
  }

  const sampled = sampleCategoryBalanced(staged, maxFiles);
  return {
    files: sampled,
    totalMatched,
    sampled: true,
    reason: `${totalMatched} matched > max-files=${maxFiles} — sampled ${sampled.length} (recency + category-balanced)`,
  };
}

// ─── batching ─────────────────────────────────────────────────────────

export interface AuditBatch {
  files: DiscoveredFile[];
  /** Rendered payload ready to stuff into ReviewContext.diff. */
  payload: string;
  charCount: number;
}

/**
 * Pack files into batches no larger than `maxCharsPerBatch` (default
 * 6000). A single oversize file is still emitted in its own batch — we
 * truncate its contents to budget with a clear marker so the agent
 * knows. Never throws.
 */
export async function buildAuditBatches(
  files: readonly DiscoveredFile[],
  cwd: string,
  maxCharsPerBatch = 6_000,
): Promise<AuditBatch[]> {
  const batches: AuditBatch[] = [];
  let current: { files: DiscoveredFile[]; chunks: string[]; chars: number } = {
    files: [],
    chunks: [],
    chars: 0,
  };

  const flush = () => {
    if (current.files.length === 0) return;
    batches.push({
      files: current.files,
      payload: current.chunks.join("\n\n"),
      charCount: current.chars,
    });
    current = { files: [], chunks: [], chars: 0 };
  };

  for (const f of files) {
    let contents: string;
    try {
      contents = await fs.promises.readFile(path.join(cwd, f.path), "utf8");
    } catch {
      contents = "(unreadable — skipped)";
    }
    // Single-file-too-large: truncate with a marker so the agent sees
    // *something*. We still count it as one batch for consistency.
    const header = `--- file: ${f.path} (${f.category}, ${f.sizeBytes} bytes) ---`;
    let chunk = `${header}\n${contents}`;
    if (chunk.length > maxCharsPerBatch) {
      const head = contents.slice(0, Math.max(0, maxCharsPerBatch - header.length - 128));
      chunk = `${header}\n${head}\n\n... [truncated — file was ${contents.length} chars, budget ${maxCharsPerBatch}]`;
    }
    if (current.chars + chunk.length > maxCharsPerBatch && current.files.length > 0) {
      flush();
    }
    current.files.push(f);
    current.chunks.push(chunk);
    current.chars += chunk.length;
  }
  flush();
  return batches;
}
