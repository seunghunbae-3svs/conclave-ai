import type { NotifyReviewInput } from "@conclave-ai/core";

const VERDICT_EMOJI: Record<"approve" | "rework" | "reject", string> = {
  approve: "✅",
  rework: "🔧",
  reject: "❌",
};

const SEVERITY_EMOJI: Record<"blocker" | "major" | "minor" | "nit", string> = {
  blocker: "🛑",
  major: "⚠️",
  minor: "🔹",
  nit: "💬",
};

/** Telegram HTML mode allows <b>, <i>, <code>, <pre>, <a href>. Escape &, <, >. */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Render a NotifyReviewInput into a Telegram HTML-mode message body.
 *
 * Contract:
 *   - Max length 4096 chars per Telegram (longer → truncated with ellipsis).
 *   - Per-agent sections, each capped to the top-3 blockers by severity.
 *   - Repo + PR link line at the top if `prUrl` is set.
 *   - Cost + episodic id in a footer for ops visibility.
 */
export function formatReviewForTelegram(input: NotifyReviewInput): string {
  const { outcome, ctx, totalCostUsd, prUrl, episodicId } = input;
  const lines: string[] = [];

  const verdictBadge = `${VERDICT_EMOJI[outcome.verdict]} <b>${outcome.verdict.toUpperCase()}</b>`;
  const header = prUrl
    ? `${verdictBadge} — <a href="${esc(prUrl)}">${esc(ctx.repo)} #${ctx.pullNumber}</a>`
    : `${verdictBadge} — <b>${esc(ctx.repo)}${ctx.pullNumber ? ` #${ctx.pullNumber}` : ""}</b>`;
  lines.push(header);
  if (!outcome.consensusReached) lines.push("<i>no consensus reached</i>");
  lines.push("");

  for (const result of outcome.results) {
    lines.push(
      `<b>${esc(result.agent)}</b> → ${VERDICT_EMOJI[result.verdict]} <i>${result.verdict}</i>`,
    );
    if (result.blockers.length === 0) {
      lines.push("  (no blockers)");
    } else {
      const sorted = [...result.blockers]
        .sort((a, b) => severityOrder(a.severity) - severityOrder(b.severity))
        .slice(0, 3);
      for (const b of sorted) {
        const where = b.file ? ` <code>${esc(b.file)}${b.line ? `:${b.line}` : ""}</code>` : "";
        lines.push(
          `  ${SEVERITY_EMOJI[b.severity]} <b>${b.severity}</b> (${esc(b.category)})${where}`,
        );
        lines.push(`    ${esc(b.message)}`);
      }
      if (result.blockers.length > 3) lines.push(`  … +${result.blockers.length - 3} more`);
    }
    if (result.summary) lines.push(`  <i>${esc(truncate(result.summary, 240))}</i>`);
    lines.push("");
  }

  lines.push(`<i>cost: $${totalCostUsd.toFixed(4)} · episodic: <code>${esc(episodicId)}</code></i>`);

  const message = lines.join("\n");
  return message.length <= 4090 ? message : message.slice(0, 4085) + "\n…";
}

function severityOrder(s: "blocker" | "major" | "minor" | "nit"): number {
  return { blocker: 0, major: 1, minor: 2, nit: 3 }[s];
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
