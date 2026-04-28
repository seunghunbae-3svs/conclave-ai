import type { FailureEntry } from "./schema.js";

/**
 * H3 #13 — extract worker-prompt hints from retrieved failure-catalog
 * entries that were written by writeReworkLoopFailure (H3 #12). Each
 * hint is a short single-line string; the worker prompt builder
 * concatenates them under a dedicated "Past bails — avoid these failure
 * modes" section so the worker sees concrete failure shapes from prior
 * runs instead of leaning on a static prompt that drifts.
 *
 * Design choice: a deterministic text synthesis (not an LLM-rewritten
 * prompt) keeps this layer cheap, predictable, and easy to verify. An
 * LLM-driven self-tuning step can land later as a sibling helper that
 * accepts these hints + the current static prompt as input.
 */

export interface ExtractPriorBailHintsOptions {
  /**
   * Maximum hints to emit. Default 5 — past 5 the prompt gets noisy and
   * the worker stops paying attention. The caller can crank this down
   * for budget-tight runs or up for catalog-rich repos.
   */
  maxHints?: number;
  /**
   * Drop hints whose underlying failure has fewer than this many
   * occurrence-equivalents (currently 1 per FailureEntry; multi-PR
   * recurrence detection lives downstream when episodic counts go
   * available). Default 1 — every catalog entry is fair game.
   */
  minOccurrences?: number;
}

export interface PriorBailHint {
  /** Final human-readable line, ready to splice into the worker prompt. */
  text: string;
  /** Bail status that surfaced the hint (e.g. "bailed-no-patches"). */
  bailStatus: string;
  /** Blocker category from the failure's seedBlocker (free-form). */
  category: string;
}

/**
 * Filter a list of FailureEntry (typically the result of MemoryStore.retrieve(...))
 * for ones tagged 'rework-loop-failure' and turn them into hint lines.
 *
 * Hints are deduped per (bailStatus, category, message[:60]) so two
 * almost-identical entries don't shout twice. Order preserved from the
 * retrieval — typically retrieval has already ranked by relevance.
 */
export function extractPriorBailHints(
  failures: readonly FailureEntry[],
  opts: ExtractPriorBailHintsOptions = {},
): PriorBailHint[] {
  const max = opts.maxHints ?? 5;
  const seen = new Set<string>();
  const out: PriorBailHint[] = [];

  for (const f of failures) {
    if (out.length >= max) break;
    if (!f.tags.includes("rework-loop-failure")) continue;
    const bailStatus = f.tags.find((t) => t.startsWith("bailed-")) ?? "bailed-unknown";
    const category = f.seedBlocker?.category ?? "(unknown)";
    const messageStart = (f.seedBlocker?.message ?? f.title).slice(0, 60);
    const dedupKey = `${bailStatus}|${category}|${messageStart}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    out.push({
      text:
        `${bailStatus} on ${category}: ${truncate(f.seedBlocker?.message ?? f.title, 140)}` +
        (f.seedBlocker?.file ? ` (file: ${f.seedBlocker.file})` : ""),
      bailStatus,
      category,
    });
  }
  return out;
}

/**
 * Render a list of PriorBailHint into the prompt section text that
 * `buildCacheablePrefix` splices into the worker system prompt. Returns
 * an empty string when the input is empty so callers can blindly append
 * without conditional plumbing.
 */
export function renderPriorBailHintsSection(hints: readonly PriorBailHint[]): string {
  if (hints.length === 0) return "";
  const lines = hints.map((h, i) => `${i + 1}. ${h.text}`);
  return [
    "## Past worker bails — avoid these failure modes",
    "Previous autofix runs on similar shapes hit these terminal states.",
    "Take extra care to produce a complete, applicable patch that doesn't",
    "repeat the same root cause.",
    "",
    ...lines,
  ].join("\n");
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
