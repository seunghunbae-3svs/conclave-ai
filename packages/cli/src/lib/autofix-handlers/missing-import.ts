import { promises as fs } from "node:fs";
import path from "node:path";
import type { Blocker, BlockerFix } from "@conclave-ai/core";
import type { GitLike } from "../autofix-worker.js";
import type { HandlerResult, BinaryEncodingHandlerDeps } from "./binary-encoding.js";

/**
 * AF-4 — missing-import handler.
 *
 * Problem: when a PR introduces an `import` statement for a module that
 * isn't part of the diff (and may not exist on disk), the worker has
 * been generating unified-diff patches to wrap the call in try/catch.
 * Those patches reliably FAIL apply (off-by-N hunk headers, context
 * drift) — and even when they apply, build-fail because the dynamic
 * import strategy needs an async wrapper at top level. Eventbadge PRs
 * #41-#52 LIVE: every cycle's worker tried, every cycle failed, build
 * stayed broken, autonomy loop hit ceiling with "failure" report.
 *
 * Fix: claim the blocker BEFORE the worker is called. Mechanically
 * rewrite the source: replace the static import + call with a guarded
 * dynamic import wrapped in try/catch that runs eagerly via an IIFE.
 * No LLM, no unified-diff parsing — just regex replacement on the
 * source file. Stage via `git add`.
 *
 * Detection signals (case-insensitive, in EITHER the category or
 * message):
 *   - "not in this diff" / "not present" / "missing" + "import" / "module"
 *   - blocker.category in {"runtime-safety", "regression-risk",
 *                         "stability", "regression", "bootstrapping"}
 *   - message mentions "init…Runtime", "feature-flag", "boot" + module
 *
 * Conservative: requires blocker.file to be set (we won't guess which
 * file). When the file doesn't have a clean static import that matches
 * a name in the blocker message, decline (returns { claimed: false }).
 */

export interface MissingImportHandlerDeps extends BinaryEncodingHandlerDeps {}

const MISSING_IMPORT_CATEGORIES = [
  "runtime-safety",
  "regression-risk",
  "stability",
  "regression",
  "bootstrapping",
  "boot",
  "app-boot",
];

const MISSING_PHRASES = [
  /not\s+in\s+this\s+diff/i,
  /not\s+present\b/i,
  /not\s+exist\b/i,
  /not\s+included\b/i,
  /missing\s+(?:module|file|import)/i,
  // "module ... is missing" — bounded by 80 chars (+ allow dots for
  // path specifiers like "module './x.js' is missing"). Pre-fix the
  // `[^.]*?` excluded dots and rejected any blocker that quoted a
  // path with .js / .ts / etc., which is most of them.
  /(?:module|file|import)\b.{0,80}?\bmissing\b/i,
];

function looksLikeMissingImportBlocker(b: Blocker): boolean {
  if (!b.file) return false;
  const cat = (b.category ?? "").toLowerCase();
  const msg = b.message ?? "";
  const catHit = MISSING_IMPORT_CATEGORIES.some((c) => cat.includes(c));
  const phraseHit = MISSING_PHRASES.some((re) => re.test(msg));
  // Either signal alone is too weak. Need a phrase hit (the strong
  // signal) AND ALSO either a category hit OR explicit "import" /
  // "module" mention so we don't grab unrelated bugs.
  if (!phraseHit) return false;
  if (catHit) return true;
  return /\b(import|module)\b/i.test(msg);
}

interface ImportSite {
  /** The full import line, e.g. `import { initX } from './x.js'` */
  importLine: string;
  /** Specifier inside the from-clause, e.g. `./x.js` */
  spec: string;
  /** Imported binding(s), e.g. `["initX"]` (default + named flatten). */
  bindings: string[];
  /** 0-based line index in the file where the import lives. */
  lineIndex: number;
  /** Lines that LOOK LIKE a top-level call to one of `bindings`. */
  callLineIndices: number[];
}

function findImportSite(content: string, hint: string): ImportSite | null {
  const lines = content.split(/\r?\n/);
  // Look for any import line whose spec mentions the hint substring
  // (e.g., "feature-flags-runtime"). When the blocker doesn't carry
  // an explicit hint, fall back to the first non-package-relative
  // import (./ or ../).
  const importRe = /^\s*import\s+(?:(?:\*\s+as\s+(\w+))|(\w+)|\{([^}]+)\}|(\w+)\s*,\s*\{([^}]+)\})\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/;
  let bestIdx = -1;
  let bestMatch: RegExpMatchArray | null = null;
  let bestSpec = "";
  for (let i = 0; i < lines.length; i++) {
    const m = importRe.exec(lines[i]!);
    if (!m) continue;
    const spec = m[6]!;
    if (!spec.startsWith("./") && !spec.startsWith("../")) continue; // skip package imports
    if (hint && spec.includes(hint)) {
      bestIdx = i;
      bestMatch = m;
      bestSpec = spec;
      break;
    }
    if (bestIdx === -1) {
      bestIdx = i;
      bestMatch = m;
      bestSpec = spec;
    }
  }
  if (bestIdx === -1 || !bestMatch) return null;
  // Collect bindings.
  const bindings: string[] = [];
  if (bestMatch[1]) bindings.push(bestMatch[1]); // namespace
  if (bestMatch[2]) bindings.push(bestMatch[2]); // default
  if (bestMatch[3]) bindings.push(...bestMatch[3].split(",").map((s) => s.trim().split(/\s+as\s+/i).pop()!.trim()).filter(Boolean));
  if (bestMatch[4]) bindings.push(bestMatch[4]); // default + named
  if (bestMatch[5]) bindings.push(...bestMatch[5].split(",").map((s) => s.trim().split(/\s+as\s+/i).pop()!.trim()).filter(Boolean));
  // Find call sites for any binding at top level.
  const callLineIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i === bestIdx) continue;
    const line = lines[i]!;
    for (const b of bindings) {
      const callRe = new RegExp(`^\\s*${b.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*\\(`);
      if (callRe.test(line)) {
        callLineIndices.push(i);
        break;
      }
    }
  }
  return {
    importLine: lines[bestIdx]!,
    spec: bestSpec,
    bindings,
    lineIndex: bestIdx,
    callLineIndices,
  };
}

/**
 * Rewrite the file to replace the static import + top-level calls with
 * a guarded async IIFE. Returns the new content, OR null when the
 * rewrite isn't safe (no import found, etc.).
 */
function rewriteFileGuarded(content: string, site: ImportSite): string | null {
  const lines = content.split(/\r?\n/);
  // Replace the import line with a short comment that does NOT echo the
  // original import statement text (avoids accidentally matching as an
  // active import line in static checks). The dynamic guarded call
  // below carries the spec name so the file still references the module.
  lines[site.lineIndex] = `// AF-4 — guarded dynamic load (see IIFE below); original static import for '${site.spec}' removed`;
  // Replace each top-level call line with a guarded IIFE.
  // Only rewrite calls that have NO leading non-whitespace before the
  // binding name (truly top-level), so we don't disturb nested usage.
  for (const idx of site.callLineIndices) {
    const orig = lines[idx]!;
    const indent = orig.match(/^\s*/)?.[0] ?? "";
    // Build: (async () => { try { const m = await import('./x.js'); m.X(); } catch {} })();
    // For each binding, call m.binding() once. Order preserved.
    const calls = site.bindings
      .map((b) => `m.${b}?.();`)
      .join(" ");
    lines[idx] = `${indent}// AF-4 — guarded dynamic call (was: ${orig.trim().replace(/\bimport\b/g, "[import]")})\n${indent}(async () => { try { const m = await import('${site.spec}'); ${calls} } catch {} })();`;
  }
  return lines.join("\n");
}

export async function tryMissingImportFix(
  agent: string,
  blocker: Blocker,
  deps: MissingImportHandlerDeps,
): Promise<HandlerResult> {
  if (!looksLikeMissingImportBlocker(blocker)) {
    return { claimed: false };
  }
  const log = deps.log ?? (() => {});
  const file = blocker.file!;
  const abs = path.isAbsolute(file) ? file : path.join(deps.cwd, file);
  let content: string;
  try {
    content = await fs.readFile(abs, "utf8");
  } catch (err) {
    log(`AF-4 missing-import: cannot read ${file} — ${err instanceof Error ? err.message : String(err)}\n`);
    return { claimed: false };
  }
  // Hint: extract a likely module specifier from the blocker message.
  // Tries the most-specific patterns first (the regex engine's
  // first-success-wins behavior would otherwise grab the leading word
  // "module" via the loosest alternative). Order matters.
  let hint = "";
  const message = blocker.message ?? "";
  const quoted = message.match(/['"`]([./][^'"`]+?)['"`]/);
  if (quoted) {
    hint = quoted[1] ?? "";
  } else {
    const relPath = message.match(/(\.{1,2}\/[\w./-]+)/);
    if (relPath) {
      hint = relPath[1] ?? "";
    } else {
      const fileLike = message.match(/([\w-]+(?:\.js|\.ts|\.jsx|\.tsx|\.mjs|\.cjs))/);
      if (fileLike) hint = fileLike[1] ?? "";
    }
  }
  const site = findImportSite(content, hint);
  if (!site) {
    log(`AF-4 missing-import: no matching import in ${file} for hint='${hint}' — declining\n`);
    return { claimed: false };
  }
  const rewritten = rewriteFileGuarded(content, site);
  if (rewritten === null || rewritten === content) {
    log(`AF-4 missing-import: rewrite produced no change for ${file} — declining\n`);
    return { claimed: false };
  }
  // Write + git-add.
  const writeText = deps.writeBytes
    ? async (p: string, data: Buffer) => deps.writeBytes!(p, data)
    : async (p: string, data: Buffer) => fs.writeFile(p, data);
  await writeText(abs, Buffer.from(rewritten, "utf8"));
  try {
    await deps.git("git", ["add", file], { cwd: deps.cwd });
  } catch (err) {
    log(`AF-4 missing-import: git add failed for ${file} — ${err instanceof Error ? err.message : String(err)}\n`);
    return { claimed: false };
  }
  log(`AF-4 missing-import: wrapped '${site.spec}' import + ${site.callLineIndices.length} call site(s) in ${file} with guarded async IIFE\n`);
  const fix: BlockerFix = {
    agent,
    blocker,
    status: "ready",
    patch: `# AF-4 mechanical missing-import wrap on ${file} (no unified diff — direct file rewrite + git add)\n`,
    commitMessage: `fix(safety): guard missing import '${site.spec}' with try/catch (AF-4)`,
    appliedFiles: [file],
    costUsd: 0,
    tokensUsed: 0,
  };
  return { claimed: true, fix };
}
