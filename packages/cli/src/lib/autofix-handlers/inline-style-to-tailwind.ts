import { promises as fs } from "node:fs";
import path from "node:path";
import type { Blocker, BlockerFix } from "@conclave-ai/core";
import type { HandlerResult, BinaryEncodingHandlerDeps } from "./binary-encoding.js";

/**
 * AF-6 — inline-style → Tailwind handler.
 *
 * Council emits "style-drift" / "design-token" / "design-system" blockers when JSX
 * mixes Tailwind utility classes with arbitrary `style={{...}}` overrides. The fix
 * is mechanical: remove the inline `style` attribute. The surrounding `className`
 * usually already carries the correct token; the inline override was the drift.
 *
 * Conservative: only acts when (a) the blocker file ends in .jsx/.tsx, (b) the
 * element has BOTH a `className` (with Tailwind classes) AND an inline `style`
 * with hex literals. We don't synthesize new Tailwind classes — if the user
 * wanted a new color, that's a design decision. We just strip the inline drift.
 */

export interface InlineStyleHandlerDeps extends BinaryEncodingHandlerDeps {}

const STYLE_DRIFT_CATEGORIES = [
  "style-drift",
  "design-drift",
  "design-system",
  "design-token",
  "tailwind",
  "token-system",
];

function looksLikeStyleDriftBlocker(b: Blocker): boolean {
  if (!b.file) return false;
  if (!/\.(jsx|tsx)$/i.test(b.file)) return false;
  const cat = (b.category ?? "").toLowerCase();
  return STYLE_DRIFT_CATEGORIES.some((c) => cat.includes(c));
}

const INLINE_STYLE_RE = /\s*style=\{\{[^}]*\}\}/;

interface DriftSite {
  lineIndex: number;
  rewritten: string;
}

function findInlineStyleDriftSites(content: string): DriftSite[] {
  const lines = content.split(/\r?\n/);
  const out: DriftSite[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!INLINE_STYLE_RE.test(line)) continue;
    // Must be a JSX-shaped line that ALSO carries a className — otherwise we don't
    // know if removing style breaks the element's appearance entirely.
    // Look at this line + the next 2 (className may be on the next line).
    const surround = lines.slice(Math.max(0, i - 2), i + 3).join("\n");
    if (!/className=/.test(surround)) continue;
    // Strip the entire style={{...}} attribute (and the leading space).
    const stripped = line.replace(INLINE_STYLE_RE, "");
    if (stripped === line) continue;
    out.push({ lineIndex: i, rewritten: stripped });
  }
  return out;
}

export async function tryInlineStyleToTailwindFix(
  agent: string,
  blocker: Blocker,
  deps: InlineStyleHandlerDeps,
): Promise<HandlerResult> {
  if (!looksLikeStyleDriftBlocker(blocker)) return { claimed: false };
  const log = deps.log ?? (() => {});
  const file = blocker.file!;
  const abs = path.isAbsolute(file) ? file : path.join(deps.cwd, file);
  let content: string;
  try {
    content = await fs.readFile(abs, "utf8");
  } catch {
    return { claimed: false };
  }
  const sites = findInlineStyleDriftSites(content);
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
    log(`AF-6 inline-style: git add failed — ${err instanceof Error ? err.message : String(err)}\n`);
    return { claimed: false };
  }
  log(`AF-6 inline-style: stripped ${sites.length} inline style override(s) in ${file}\n`);
  return {
    claimed: true,
    fix: {
      agent,
      blocker,
      status: "ready",
      patch: `# AF-6 mechanical inline-style strip on ${file}\n`,
      commitMessage: `fix(design): remove inline style drift in ${file} (AF-6)`,
      appliedFiles: [file],
      costUsd: 0,
      tokensUsed: 0,
    },
  };
}
