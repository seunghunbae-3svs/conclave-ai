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
 * Build the stub file content for a missing module — exports a no-op
 * function for each binding the importing file uses. Bundlers (vite,
 * webpack, rollup) resolve imports at build time, so a try/catch
 * dynamic import doesn't bypass the build error: the file must
 * actually exist for the build to succeed. AF-4's strategy is
 * therefore to CREATE the missing module as a no-op stub, not rewrite
 * the call site — that keeps the existing call semantics (which the
 * worker doesn't know enough to safely remove) while making the
 * import resolve.
 */
function buildStubContent(spec: string, bindings: string[]): string {
  const lines: string[] = [
    `// AF-4 stub — auto-generated by Conclave AI's missing-import handler.`,
    `// The module '${spec}' was imported but missing from the codebase.`,
    `// This is a no-op shim so the build resolves; replace each export`,
    `// below with the real implementation when the feature lands.`,
    ``,
  ];
  // Dedupe bindings; emit each as a no-op function export. We don't
  // know whether each was a function call, value, or class — but the
  // safest stub for an unknown export is a function-shaped no-op:
  // calling it does nothing; reading it returns the function reference
  // (truthy). Both forms are safer than `undefined`.
  const uniq = Array.from(new Set(bindings));
  for (const b of uniq) {
    lines.push(`export function ${b}() { /* AF-4 no-op stub */ }`);
  }
  // Default export — used when binding-detection saw a default import
  // but couldn't bind a name. Always emit so files importing default
  // resolve.
  lines.push(``);
  lines.push(`const __af4Default = {};`);
  lines.push(`export default __af4Default;`);
  lines.push(``);
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
  // Resolve the spec to an absolute path and check if the module file
  // actually exists. The static-bundler reality (vite, webpack, rollup)
  // is that imports MUST resolve at build time — try/catch dynamic
  // imports don't bypass build failure. So if the file is missing, we
  // create a no-op stub. Eventbadge PR #41-#53 LIVE: the dynamic-import
  // approach kept failing build because './config/feature-flags-runtime.js'
  // didn't exist on disk → vite couldn't resolve it.
  const importerDir = path.dirname(abs);
  // Resolve relative to the importing file. Try common extensions if
  // the spec has no extension.
  const candidates: string[] = [];
  const baseResolved = path.resolve(importerDir, site.spec);
  candidates.push(baseResolved);
  if (!path.extname(site.spec)) {
    for (const ext of [".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs"]) {
      candidates.push(baseResolved + ext);
    }
  }
  let existingTarget: string | null = null;
  for (const c of candidates) {
    try {
      await fs.access(c);
      existingTarget = c;
      break;
    } catch { /* not found */ }
  }

  const writeText = deps.writeBytes
    ? async (p: string, data: Buffer) => deps.writeBytes!(p, data)
    : async (p: string, data: Buffer) => fs.writeFile(p, data);

  if (existingTarget) {
    // File exists — the missing-import blocker was a false alarm OR the
    // module is broken inside. Either way, AF-4 declines: the worker
    // pipeline (or human) can address what's actually wrong inside
    // the module.
    log(`AF-4 missing-import: ${file} imports '${site.spec}' which DOES exist at ${existingTarget} — declining (not a missing-file case)\n`);
    return { claimed: false };
  }

  // File missing → create a no-op stub. Pick the target path:
  //   - if spec has an extension, use spec verbatim
  //   - else default to .js (the most common in modern bundlers)
  const stubAbs = path.extname(site.spec) ? baseResolved : `${baseResolved}.js`;
  const stubContent = buildStubContent(site.spec, site.bindings);
  try {
    await fs.mkdir(path.dirname(stubAbs), { recursive: true });
    await writeText(stubAbs, Buffer.from(stubContent, "utf8"));
  } catch (err) {
    log(`AF-4 missing-import: failed to write stub at ${stubAbs} — ${err instanceof Error ? err.message : String(err)}\n`);
    return { claimed: false };
  }
  // git add the stub. Path relative to cwd.
  const stubRel = path.relative(deps.cwd, stubAbs).replace(/\\/g, "/");
  try {
    await deps.git("git", ["add", stubRel], { cwd: deps.cwd });
  } catch (err) {
    log(`AF-4 missing-import: git add ${stubRel} failed — ${err instanceof Error ? err.message : String(err)}\n`);
    return { claimed: false };
  }
  log(`AF-4 missing-import: created no-op stub at ${stubRel} for missing module '${site.spec}' (${site.bindings.length} binding(s)); leaving import + call site untouched\n`);
  const fix: BlockerFix = {
    agent,
    blocker,
    status: "ready",
    patch: `# AF-4 mechanical no-op stub created at ${stubRel} (no unified diff — direct file write + git add)\n`,
    commitMessage: `fix(safety): create no-op stub for missing module '${site.spec}' (AF-4)`,
    appliedFiles: [stubRel],
    costUsd: 0,
    tokensUsed: 0,
  };
  return { claimed: true, fix };
}
