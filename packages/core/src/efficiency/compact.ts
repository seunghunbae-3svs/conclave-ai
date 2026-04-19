export interface CompactableMessage {
  role: "system" | "user" | "assistant";
  content: string;
  /** Tokens for this message (estimate). */
  tokens: number;
  /** If true, never compact or drop — used for the current turn's user ask and system prompt. */
  pin?: boolean;
}

export interface CompactOptions {
  /** Target token budget for the conversation after compaction. */
  targetTokens: number;
  /** Optional summarizer. If provided, older messages are collapsed into a summary message. */
  summarize?: (messages: readonly CompactableMessage[]) => Promise<string>;
}

export interface CompactResult {
  messages: CompactableMessage[];
  droppedCount: number;
  summarizedCount: number;
  finalTokens: number;
}

/**
 * Round-to-round context compression.
 *
 * Strategy:
 *   1. Keep all `pin: true` messages (system prompt, current turn).
 *   2. Walk remaining messages newest-to-oldest, keeping until budget is hit.
 *   3. If a `summarize` function is provided, collapse the dropped tail into
 *      a single assistant-role summary message at the head of unpinned history.
 *
 * The real implementation uses Haiku for the summary call — kept as an
 * injected function so callers can swap in a cached/noop variant for tests.
 */
export async function compact(
  messages: readonly CompactableMessage[],
  opts: CompactOptions,
): Promise<CompactResult> {
  const pinned = messages.filter((m) => m.pin);
  const unpinned = messages.filter((m) => !m.pin);

  const pinnedTokens = pinned.reduce((sum, m) => sum + m.tokens, 0);
  const budget = opts.targetTokens - pinnedTokens;

  if (budget <= 0) {
    return {
      messages: pinned,
      droppedCount: unpinned.length,
      summarizedCount: 0,
      finalTokens: pinnedTokens,
    };
  }

  // Fit newest-first.
  const kept: CompactableMessage[] = [];
  let used = 0;
  for (let i = unpinned.length - 1; i >= 0; i -= 1) {
    const m = unpinned[i]!;
    if (used + m.tokens > budget) break;
    kept.unshift(m);
    used += m.tokens;
  }
  const dropped = unpinned.slice(0, unpinned.length - kept.length);

  let summarized = 0;
  if (dropped.length > 0 && opts.summarize) {
    const summaryText = await opts.summarize(dropped);
    const summaryTokens = Math.ceil(summaryText.length / 4);
    if (summaryTokens <= budget - used) {
      kept.unshift({
        role: "assistant",
        content: `[compacted summary of ${dropped.length} earlier messages]\n${summaryText}`,
        tokens: summaryTokens,
      });
      used += summaryTokens;
      summarized = dropped.length;
    }
  }

  return {
    messages: [...pinned, ...kept],
    droppedCount: dropped.length - summarized,
    summarizedCount: summarized,
    finalTokens: pinnedTokens + used,
  };
}
