import { promises as fs } from "node:fs";
import path from "node:path";
import type { Blocker, BlockerFix } from "@conclave-ai/core";
import type { HandlerResult, BinaryEncodingHandlerDeps } from "./binary-encoding.js";

/**
 * AF-5 — contrast handler.
 *
 * Council emits contrast/accessibility blockers on inline `style={{ color, backgroundColor }}`
 * pairs that fail WCAG AA (4.5:1). Pre-AF-5 the worker tried to rewrite via unified diff
 * which failed reliably (off-by-N hunks). This handler does it mechanically: read the file,
 * find the offending `style={{ color: '#X', backgroundColor: '#Y' }}` pair, replace with
 * a contrast-safe pair (slate-900 on white for input text, blue-600/white CTA), git add.
 *
 * Conservative: only matches inline-style blocks where BOTH color and backgroundColor are
 * literal hex strings. When the styles are computed, dynamic, or come from a theme prop,
 * declines (worker can try).
 */

export interface ContrastHandlerDeps extends BinaryEncodingHandlerDeps {}

const CONTRAST_CATEGORIES = [
  "contrast",
  "accessibility",
  "a11y",
  "wcag",
];

function looksLikeContrastBlocker(b: Blocker): boolean {
  if (!b.file) return false;
  const cat = (b.category ?? "").toLowerCase();
  if (!CONTRAST_CATEGORIES.some((c) => cat.includes(c))) return false;
  // Must mention contrast / WCAG / readability / "X on Y" / a hex color in the message —
  // weeds out aria-label and other accessibility blockers that aren't color contrast.
  const msg = b.message ?? "";
  return /(contrast|wcag|readab|invisible|on\s+(?:white|black|#[0-9a-f])|#[0-9a-f]{3,8})/i.test(msg);
}

interface InlineStylePair {
  /** Index of the line where the style={{...}} expression starts. */
  lineIndex: number;
  /** Original line text (verbatim, for replacement context). */
  originalLine: string;
  /** Hex color literal of `color` field. */
  color: string;
  /** Hex color literal of `backgroundColor` field. */
  bg: string;
  /** Indentation prefix (whitespace before `style=`). */
  indent: string;
  /** Whether the surrounding element is a button (vs input/text). Affects replacement. */
  isButton: boolean;
}

const INLINE_PAIR_RE = /style=\{\{\s*color:\s*['"]([^'"]+)['"]\s*,\s*backgroundColor:\s*['"]([^'"]+)['"]\s*\}\}|style=\{\{\s*backgroundColor:\s*['"]([^'"]+)['"]\s*,\s*color:\s*['"]([^'"]+)['"]\s*\}\}/;

function findInlineStylePairs(content: string): InlineStylePair[] {
  const lines = content.split(/\r?\n/);
  const out: InlineStylePair[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = INLINE_PAIR_RE.exec(line);
    if (!m) continue;
    const color = m[1] ?? m[4] ?? "";
    const bg = m[2] ?? m[3] ?? "";
    if (!color || !bg) continue;
    // Walk up a few lines to find the enclosing JSX element tag.
    let isButton = false;
    for (let j = i; j >= Math.max(0, i - 10); j--) {
      const upLine = lines[j]!;
      if (/<button\b/i.test(upLine)) { isButton = true; break; }
      if (/<input\b/i.test(upLine)) { isButton = false; break; }
      // closing of previous element - stop walking up (we're not in any tag context anymore)
      if (/^\s*<\//.test(upLine)) break;
    }
    out.push({
      lineIndex: i,
      originalLine: line,
      color,
      bg,
      indent: line.match(/^\s*/)?.[0] ?? "",
      isButton,
    });
  }
  return out;
}

/**
 * Compute WCAG luminance for a hex color (sRGB → linear → relative luminance).
 * Pure — used to decide whether a pair fails AA.
 */
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const clean = hex.replace(/^#/, "");
  let h: string;
  if (clean.length === 3) {
    h = clean.split("").map((c) => c + c).join("");
  } else if (clean.length === 6) {
    h = clean;
  } else {
    return null;
  }
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
  return { r, g, b };
}

function relativeLuminance(rgb: { r: number; g: number; b: number }): number {
  const conv = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * conv(rgb.r) + 0.7152 * conv(rgb.g) + 0.0722 * conv(rgb.b);
}

export function contrastRatio(fgHex: string, bgHex: string): number {
  const fg = hexToRgb(fgHex);
  const bg = hexToRgb(bgHex);
  if (!fg || !bg) return 0;
  const lFg = relativeLuminance(fg);
  const lBg = relativeLuminance(bg);
  const [light, dark] = lFg > lBg ? [lFg, lBg] : [lBg, lFg];
  return (light + 0.05) / (dark + 0.05);
}

const WCAG_AA = 4.5;

/** Pick a safe replacement for the failing pair. */
function safeReplacement(pair: InlineStylePair): { color: string; bg: string } {
  // For BUTTONS we want a strong CTA pair — Tailwind blue-600 / white = 7.04:1.
  // For inputs/text we want slate-900 / white = 16.0:1.
  // Both pass AA decisively. Conservative choice over preserving the user's bg
  // because the user's bg may itself be the contrast-violating element.
  if (pair.isButton) return { color: "#ffffff", bg: "#2563eb" };
  return { color: "#0f172a", bg: "#ffffff" };
}

function rewriteContrast(content: string, pair: InlineStylePair, replacement: { color: string; bg: string }): string {
  const lines = content.split(/\r?\n/);
  const old = lines[pair.lineIndex]!;
  // Replace the entire style={{...}} match with a safe pair (preserves the surrounding
  // attribute order/indent on that line). The regex handles either property order.
  const replaced = old.replace(
    INLINE_PAIR_RE,
    `style={{ color: '${replacement.color}', backgroundColor: '${replacement.bg}' }}`,
  );
  lines[pair.lineIndex] = replaced;
  return lines.join("\n");
}

export async function tryContrastFix(
  agent: string,
  blocker: Blocker,
  deps: ContrastHandlerDeps,
): Promise<HandlerResult> {
  if (!looksLikeContrastBlocker(blocker)) return { claimed: false };
  const log = deps.log ?? (() => {});
  const file = blocker.file!;
  const abs = path.isAbsolute(file) ? file : path.join(deps.cwd, file);
  let content: string;
  try {
    content = await fs.readFile(abs, "utf8");
  } catch {
    return { claimed: false };
  }
  const pairs = findInlineStylePairs(content);
  // Only act on pairs that ACTUALLY fail AA. A blocker can be flagged on a borderline
  // pair that's already passing post a previous edit.
  const failing = pairs.filter((p) => contrastRatio(p.color, p.bg) < WCAG_AA);
  if (failing.length === 0) {
    log(`AF-5 contrast: ${file} — no AA-failing inline color pairs found, declining\n`);
    return { claimed: false };
  }
  let next = content;
  for (const p of failing) {
    const replacement = safeReplacement(p);
    next = rewriteContrast(next, { ...p, originalLine: next.split(/\r?\n/)[p.lineIndex]! }, replacement);
  }
  if (next === content) return { claimed: false };
  const writeText = deps.writeBytes
    ? async (p: string, data: Buffer) => deps.writeBytes!(p, data)
    : async (p: string, data: Buffer) => fs.writeFile(p, data);
  await writeText(abs, Buffer.from(next, "utf8"));
  try {
    await deps.git("git", ["add", file], { cwd: deps.cwd });
  } catch (err) {
    log(`AF-5 contrast: git add failed — ${err instanceof Error ? err.message : String(err)}\n`);
    return { claimed: false };
  }
  log(`AF-5 contrast: rewrote ${failing.length} inline pair(s) in ${file} to AA-safe values\n`);
  return {
    claimed: true,
    fix: {
      agent,
      blocker,
      status: "ready",
      patch: `# AF-5 mechanical contrast fix on ${file} (no unified diff — direct file rewrite + git add)\n`,
      commitMessage: `fix(a11y): AA-safe contrast pair for ${file} (AF-5)`,
      appliedFiles: [file],
      costUsd: 0,
      tokensUsed: 0,
    },
  };
}
