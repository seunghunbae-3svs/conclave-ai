import type { Blocker, ReviewResult } from "./agent.js";
import type { CouncilOutcome } from "./council.js";

/**
 * H2 #9 — Diff splitter for large PRs.
 *
 * Parses a unified `git diff` text into per-file blocks, then bin-packs
 * them into chunks ≤ `maxLinesPerChunk`. A single file larger than the
 * cap is never broken apart (would corrupt the diff); it goes into its
 * own chunk regardless.
 *
 * Splitting + chunked review keeps each council pass focused, avoids
 * context-window blow-up on large refactors, and lets the efficiency
 * gate's cache reuse warm-up across chunks.
 */

export interface DiffChunk {
  /** Self-contained unified-diff text — one or more `diff --git` blocks. */
  diff: string;
  /** Paths of files changed in this chunk (post-image side). */
  files: string[];
  /** Total +/- content lines in this chunk (excluding `+++`/`---` headers). */
  changedLines: number;
}

export interface SplitDiffOptions {
  /** Threshold for total +/- lines per chunk. Default 500. */
  maxLinesPerChunk?: number;
  /** Defensive cap on file count per chunk so one chunk doesn't bin-pack 500 1-line files. Default 20. */
  maxChangedFilesPerChunk?: number;
}

/**
 * Split a unified diff into bin-packed chunks. Returns `[{ diff, files, changedLines }]`.
 *
 * Returns a single-chunk array (the original diff) when:
 *   - the diff has no `diff --git` headers (raw unified diff, no per-file boundaries to split on), OR
 *   - the diff fits inside one chunk's budget already.
 */
export function splitDiff(diff: string, opts: SplitDiffOptions = {}): DiffChunk[] {
  const maxLines = opts.maxLinesPerChunk ?? 500;
  const maxFiles = opts.maxChangedFilesPerChunk ?? 20;
  const blocks = parseFileBlocks(diff);
  if (blocks.length === 0) {
    // No file boundaries detected — caller should review as one pass.
    return diff.trim().length > 0
      ? [{ diff, files: [], changedLines: countChangedLines(diff) }]
      : [];
  }

  const chunks: DiffChunk[] = [];
  let buf: FileBlock[] = [];
  let bufLines = 0;

  const flush = (): void => {
    if (buf.length === 0) return;
    chunks.push({
      diff: buf.map((b) => b.text).join(""),
      files: buf.map((b) => b.path),
      changedLines: bufLines,
    });
    buf = [];
    bufLines = 0;
  };

  for (const block of blocks) {
    // Big single file → its own chunk regardless. Flush whatever is buffered first.
    if (block.changedLines > maxLines) {
      flush();
      chunks.push({ diff: block.text, files: [block.path], changedLines: block.changedLines });
      continue;
    }
    // Adding this file would overflow → flush, start new buffer with this block.
    if (buf.length >= maxFiles || bufLines + block.changedLines > maxLines) {
      flush();
    }
    buf.push(block);
    bufLines += block.changedLines;
  }
  flush();

  return chunks;
}

/**
 * Stitch `outcomes` (one per chunk) into a single CouncilOutcome.
 *
 *   verdict           = severity-max (any reject → reject; any rework → rework; else approve)
 *   results           = per-agent merge: blockers concatenated + deduped, verdict severity-max,
 *                       summaries joined, tokens/cost summed
 *   rounds            = max across chunks
 *   consensusReached  = all chunks reached consensus
 *
 * Caller invariant: every chunk's `results` should carry the same set
 * of agent ids (the council instance is the same). If an agent threw on
 * one chunk and not another, that's logged in agents' synthesized result;
 * the merge handles it gracefully (any verdict from any chunk wins).
 */
export function integrateChunkOutcomes(outcomes: readonly CouncilOutcome[]): CouncilOutcome {
  if (outcomes.length === 0) {
    throw new Error("integrateChunkOutcomes: outcomes must be non-empty");
  }
  if (outcomes.length === 1) return outcomes[0]!;

  const byAgent = new Map<string, ReviewResult>();
  for (const oc of outcomes) {
    for (const r of oc.results) {
      const prior = byAgent.get(r.agent);
      if (!prior) {
        byAgent.set(r.agent, {
          ...r,
          blockers: [...r.blockers],
        });
        continue;
      }
      const merged: ReviewResult = {
        agent: r.agent,
        verdict: maxVerdict(prior.verdict, r.verdict),
        blockers: dedupeBlockers([...prior.blockers, ...r.blockers]),
        summary: joinSummaries(prior.summary, r.summary),
      };
      if (prior.tokensUsed !== undefined || r.tokensUsed !== undefined) {
        merged.tokensUsed = (prior.tokensUsed ?? 0) + (r.tokensUsed ?? 0);
      }
      if (prior.costUsd !== undefined || r.costUsd !== undefined) {
        merged.costUsd = (prior.costUsd ?? 0) + (r.costUsd ?? 0);
      }
      byAgent.set(r.agent, merged);
    }
  }

  const finalVerdict = outcomes.reduce<CouncilOutcome["verdict"]>(
    (acc, oc) => maxVerdict(acc, oc.verdict),
    "approve",
  );
  const rounds = outcomes.reduce((acc, oc) => Math.max(acc, oc.rounds), 0);
  const consensusReached = outcomes.every((o) => o.consensusReached);

  return {
    verdict: finalVerdict,
    rounds,
    results: [...byAgent.values()],
    consensusReached,
  };
}

interface FileBlock {
  /** Original block text including the `diff --git` header line + trailing newline. */
  text: string;
  /** Post-image path (`b/<path>`). Empty string when not present. */
  path: string;
  /** Count of +/- content lines in this block (excludes `+++ b/` / `--- a/` headers). */
  changedLines: number;
}

function parseFileBlocks(diff: string): FileBlock[] {
  // Split on the start-of-line `diff --git ` marker. The first element
  // is anything before the first marker (usually empty for git output);
  // the rest are blocks missing their leading `diff --git ` prefix —
  // re-attach.
  if (!diff.includes("diff --git ")) return [];
  const parts = diff.split(/^diff --git /m);
  const out: FileBlock[] = [];
  for (let i = 1; i < parts.length; i += 1) {
    const body = parts[i]!;
    const text = `diff --git ${body}`;
    let path = "";
    let changedLines = 0;
    for (const line of text.split("\n")) {
      if (line.startsWith("+++ b/")) {
        path = line.slice(6);
      } else if (line.startsWith("+") && !line.startsWith("+++")) {
        changedLines += 1;
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        changedLines += 1;
      }
    }
    out.push({ text, path, changedLines });
  }
  return out;
}

function countChangedLines(diff: string): number {
  let n = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+") || line.startsWith("-")) n += 1;
  }
  return n;
}

function maxVerdict(
  a: CouncilOutcome["verdict"],
  b: CouncilOutcome["verdict"],
): CouncilOutcome["verdict"] {
  if (a === "reject" || b === "reject") return "reject";
  if (a === "rework" || b === "rework") return "rework";
  return "approve";
}

function dedupeBlockers(blockers: readonly Blocker[]): Blocker[] {
  const seen = new Map<string, Blocker>();
  for (const b of blockers) {
    const key = `${b.category}|${b.file ?? ""}|${b.line ?? ""}|${(b.message ?? "").slice(0, 60)}`;
    if (!seen.has(key)) seen.set(key, b);
  }
  return [...seen.values()];
}

function joinSummaries(a: string, b: string): string {
  const left = a.trim();
  const right = b.trim();
  if (!left) return right;
  if (!right) return left;
  if (left === right) return left;
  return `${left} | ${right}`;
}
