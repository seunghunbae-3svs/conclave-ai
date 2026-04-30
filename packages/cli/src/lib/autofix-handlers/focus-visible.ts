import { promises as fs } from "node:fs";
import path from "node:path";
import type { Blocker, BlockerFix } from "@conclave-ai/core";
import type { HandlerResult, BinaryEncodingHandlerDeps } from "./binary-encoding.js";

/**
 * AF-9 — focus-visible handler.
 *
 * Council emits (missing-state) / (focus) / (a11y) blockers when interactive
 * elements (button, a, input) lack a visible focus indicator. The fix is
 * mechanical: append a `focus-visible:ring-2 focus-visible:ring-blue-500
 * focus-visible:ring-offset-2 focus-visible:outline-none` class set to the
 * existing className. Idempotent — if any of those classes already present,
 * skip that element.
 */

export interface FocusVisibleHandlerDeps extends BinaryEncodingHandlerDeps {}

const FOCUS_CATEGORIES = [
  "missing-state",
  "focus",
  "focus-visible",
  "keyboard",
  "a11y",
  "accessibility",
];

function looksLikeFocusBlocker(b: Blocker): boolean {
  if (!b.file) return false;
  if (!/\.(jsx|tsx)$/i.test(b.file)) return false;
  const cat = (b.category ?? "").toLowerCase();
  if (!FOCUS_CATEGORIES.some((c) => cat.includes(c))) return false;
  const msg = b.message ?? "";
  return /(focus|keyboard|outline|ring|visible)/i.test(msg);
}

/**
 * className="..." attribute on a button/input/a tag, single-line. We only handle
 * the simple-string form — `className={...}` template literals or computed
 * expressions are left for the worker.
 */
const SIMPLE_CLASSNAME_RE = /className="([^"]*)"/;

const FOCUS_CLASSES = "focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:outline-none";

interface FocusSite {
  lineIndex: number;
  rewritten: string;
}

function findFocusSites(content: string): FocusSite[] {
  const lines = content.split(/\r?\n/);
  const out: FocusSite[] = [];
  // Track which JSX tag the className belongs to by walking up. We only inject
  // for <button>, <a>, <input> tags.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = SIMPLE_CLASSNAME_RE.exec(line);
    if (!m) continue;
    const classes = m[1] ?? "";
    if (/focus-visible:/.test(classes)) continue; // already has focus-visible — skip
    // Walk up to find tag.
    let isInteractive = false;
    for (let j = i; j >= Math.max(0, i - 8); j--) {
      const upLine = lines[j]!;
      if (/<(button|input|a)\b/i.test(upLine)) { isInteractive = true; break; }
      if (/<\w+/.test(upLine)) break; // some other tag — stop walking up
    }
    if (!isInteractive) continue;
    const newClasses = classes.trim() ? `${classes.trim()} ${FOCUS_CLASSES}` : FOCUS_CLASSES;
    const rewritten = line.replace(SIMPLE_CLASSNAME_RE, `className="${newClasses}"`);
    out.push({ lineIndex: i, rewritten });
  }
  return out;
}

export async function tryFocusVisibleFix(
  agent: string,
  blocker: Blocker,
  deps: FocusVisibleHandlerDeps,
): Promise<HandlerResult> {
  if (!looksLikeFocusBlocker(blocker)) return { claimed: false };
  const log = deps.log ?? (() => {});
  const file = blocker.file!;
  const abs = path.isAbsolute(file) ? file : path.join(deps.cwd, file);
  let content: string;
  try {
    content = await fs.readFile(abs, "utf8");
  } catch {
    return { claimed: false };
  }
  const sites = findFocusSites(content);
  if (sites.length === 0) return { claimed: false };
  const lines = content.split(/\r?\n/);
  for (const s of sites) lines[s.lineIndex] = s.rewritten;
  const next = lines.join("\n");
  if (next === content) return { claimed: false };
  const writeText = deps.writeBytes
    ? async (p: string, data: Buffer) => deps.writeBytes!(p, data)
    : async (p: string, data: Buffer) => fs.writeFile(p, data);
  await writeText(abs, Buffer.from(next, "utf8"));
  try {
    await deps.git("git", ["add", file], { cwd: deps.cwd });
  } catch (err) {
    log(`AF-9 focus-visible: git add failed — ${err instanceof Error ? err.message : String(err)}\n`);
    return { claimed: false };
  }
  log(`AF-9 focus-visible: added focus-visible classes to ${sites.length} interactive element(s) in ${file}\n`);
  return {
    claimed: true,
    fix: {
      agent,
      blocker,
      status: "ready",
      patch: `# AF-9 mechanical focus-visible inject on ${file}\n`,
      commitMessage: `fix(a11y): add focus-visible ring to interactive elements (AF-9)`,
      appliedFiles: [file],
      costUsd: 0,
      tokensUsed: 0,
    },
  };
}
