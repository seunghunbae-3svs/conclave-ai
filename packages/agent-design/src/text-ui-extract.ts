/**
 * Text-UI diff extraction — given a unified diff, pull out only the
 * hunks that touch UI files (as classified by `ui-globs.ts`) and return
 * a size-bounded string suitable for the Mode B prompt.
 *
 * Non-UI hunks get dropped entirely; the code agents (Claude / OpenAI /
 * Gemini) will cover those. The design agent should focus its tokens on
 * what only it can see — semantic HTML, tokens, a11y, interaction states.
 */

import { isUiPath } from "./ui-globs.js";

/** Maximum UI diff size we'll inline into the prompt, in characters. */
export const MAX_UI_DIFF_CHARS = 8_000;

export interface ExtractedUiDiff {
  /** The UI-only diff text, possibly truncated to `MAX_UI_DIFF_CHARS`. */
  text: string;
  /** Whether truncation was applied. */
  truncated: boolean;
  /** UI files seen in the diff (deduped, input order). */
  files: string[];
  /** Original UI-only diff size in characters, pre-truncation. */
  originalChars: number;
}

interface DiffBlock {
  header: string;
  aPath: string;
  bPath: string;
  body: string[];
}

/**
 * Parse a unified diff into `diff --git` blocks. Each block includes its
 * header line plus every subsequent line up to (but not including) the
 * next `diff --git` line.
 */
function splitIntoBlocks(diff: string): DiffBlock[] {
  const blocks: DiffBlock[] = [];
  const lines = diff.split("\n");
  let current: DiffBlock | null = null;
  for (const line of lines) {
    const m = /^diff --git a\/(\S+)\s+b\/(\S+)/.exec(line);
    if (m) {
      if (current) blocks.push(current);
      current = {
        header: line,
        aPath: m[1] ?? "",
        bPath: m[2] ?? "",
        body: [],
      };
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) blocks.push(current);
  return blocks;
}

/**
 * Extract UI-only blocks from a unified diff and bundle them into a
 * bounded-size string. If the UI content exceeds `MAX_UI_DIFF_CHARS`,
 * blocks are truncated (fairly, per-file) and a note is appended.
 */
export function extractUiDiff(diff: string, maxChars: number = MAX_UI_DIFF_CHARS): ExtractedUiDiff {
  const blocks = splitIntoBlocks(diff);
  const uiBlocks = blocks.filter((b) => isUiPath(b.aPath) || isUiPath(b.bPath));
  const files: string[] = [];
  const seen = new Set<string>();
  for (const b of uiBlocks) {
    const path = b.bPath || b.aPath;
    if (path && !seen.has(path)) {
      seen.add(path);
      files.push(path);
    }
  }
  const fullText = uiBlocks.map((b) => [b.header, ...b.body].join("\n")).join("\n");
  const originalChars = fullText.length;
  if (originalChars <= maxChars) {
    return { text: fullText, truncated: false, files, originalChars };
  }

  // Truncate fairly: allocate a per-file budget so no single mega-file
  // starves the rest. The prompt includes a note so the model knows it's
  // reading a truncated view.
  const perBlockBudget = Math.max(256, Math.floor(maxChars / Math.max(1, uiBlocks.length)));
  const pieces: string[] = [];
  let used = 0;
  for (const b of uiBlocks) {
    const whole = [b.header, ...b.body].join("\n");
    const budget = Math.min(perBlockBudget, Math.max(0, maxChars - used - 128 /* reserve for note */));
    if (budget <= 0) break;
    if (whole.length <= budget) {
      pieces.push(whole);
      used += whole.length + 1;
    } else {
      pieces.push(whole.slice(0, budget) + "\n… [truncated]");
      used += budget + 16;
    }
  }
  const note = `\n\n[note] UI diff exceeded ${maxChars} chars (${originalChars} raw) — truncated per-file. Review the visible hunks; ask the author if anything critical was dropped.`;
  return {
    text: pieces.join("\n") + note,
    truncated: true,
    files,
    originalChars,
  };
}
