import { promises as fs } from "node:fs";
import path from "node:path";
import type { Blocker, BlockerFix } from "@conclave-ai/core";
import type { HandlerResult, BinaryEncodingHandlerDeps } from "./binary-encoding.js";

/**
 * AF-7 / AF-8 — debug-code + dead-code handler.
 *
 * Council emits (debug-code) / (logging) / (regression) / (dead-code) blockers
 * for stray console.log / console.debug / unused let-const declarations.
 * These are syntactically simple — we don't need an LLM. Reads the file, removes
 * full-line console.{log,debug,info,warn} statements + lines declaring an unused
 * `const|let foo = ...` that match a unused_X / _X / X_unused naming hint.
 *
 * Conservative: removes ENTIRE LINE only when the line is a top-level
 * statement expression that starts with `console.` OR a single-line declaration
 * whose identifier matches an unused-naming heuristic. Inline console calls
 * (e.g., `if (debug) console.log(...)`) and multi-line declarations are LEFT.
 */

export interface DebugCodeHandlerDeps extends BinaryEncodingHandlerDeps {}

const DEBUG_CATEGORIES = [
  "debug-code",
  "logging",
  "regression", // generic catch-all when the message mentions console.log
  "dead-code",
  "code-quality",
  "cleanliness",
  "unused",
];

function looksLikeDebugBlocker(b: Blocker): boolean {
  if (!b.file) return false;
  const cat = (b.category ?? "").toLowerCase();
  if (!DEBUG_CATEGORIES.some((c) => cat.includes(c))) return false;
  const msg = b.message ?? "";
  return /(console\.(log|debug|info|warn)|stray\s+console|debug\s+log|unused\s+(?:const|let|var|variable|constant|declaration|legacy))/i.test(msg);
}

const CONSOLE_LINE_RE = /^\s*console\.(log|debug|info|warn)\s*\([^;]*\)\s*;?\s*$/;
const UNUSED_DECL_RE = /^\s*(?:const|let)\s+(_?\w*?(?:unused|legacy|tmp|temp)\w*|\w*_unused\w*)\s*=.+;?\s*$/;

interface RemovalSite {
  lineIndex: number;
  reason: "console" | "unused-decl";
}

function findRemovalSites(content: string): RemovalSite[] {
  const lines = content.split(/\r?\n/);
  const out: RemovalSite[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (CONSOLE_LINE_RE.test(line)) {
      out.push({ lineIndex: i, reason: "console" });
      continue;
    }
    if (UNUSED_DECL_RE.test(line)) {
      out.push({ lineIndex: i, reason: "unused-decl" });
    }
  }
  return out;
}

export async function tryDebugCodeFix(
  agent: string,
  blocker: Blocker,
  deps: DebugCodeHandlerDeps,
): Promise<HandlerResult> {
  if (!looksLikeDebugBlocker(blocker)) return { claimed: false };
  const log = deps.log ?? (() => {});
  const file = blocker.file!;
  const abs = path.isAbsolute(file) ? file : path.join(deps.cwd, file);
  let content: string;
  try {
    content = await fs.readFile(abs, "utf8");
  } catch {
    return { claimed: false };
  }
  const sites = findRemovalSites(content);
  if (sites.length === 0) return { claimed: false };
  const lines = content.split(/\r?\n/);
  // Filter to keep — drop the targeted indices.
  const drop = new Set(sites.map((s) => s.lineIndex));
  const next = lines.filter((_, idx) => !drop.has(idx)).join("\n");
  if (next === content) return { claimed: false };
  const writeText = deps.writeBytes
    ? async (p: string, data: Buffer) => deps.writeBytes!(p, data)
    : async (p: string, data: Buffer) => fs.writeFile(p, data);
  await writeText(abs, Buffer.from(next, "utf8"));
  try {
    await deps.git("git", ["add", file], { cwd: deps.cwd });
  } catch (err) {
    log(`AF-7/8 debug-code: git add failed — ${err instanceof Error ? err.message : String(err)}\n`);
    return { claimed: false };
  }
  const consoleN = sites.filter((s) => s.reason === "console").length;
  const unusedN = sites.filter((s) => s.reason === "unused-decl").length;
  log(`AF-7/8 debug-code: removed ${consoleN} console + ${unusedN} unused decl line(s) in ${file}\n`);
  return {
    claimed: true,
    fix: {
      agent,
      blocker,
      status: "ready",
      patch: `# AF-7/8 mechanical debug-code/dead-code strip on ${file}\n`,
      commitMessage: `chore: remove debug code + dead declarations in ${file} (AF-7/8)`,
      appliedFiles: [file],
      costUsd: 0,
      tokensUsed: 0,
    },
  };
}
