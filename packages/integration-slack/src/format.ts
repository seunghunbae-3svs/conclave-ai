import type { NotifyReviewInput } from "@conclave-ai/core";

const VERDICT_EMOJI: Record<"approve" | "rework" | "reject", string> = {
  approve: ":white_check_mark:",
  rework: ":wrench:",
  reject: ":x:",
};

const SEVERITY_EMOJI: Record<"blocker" | "major" | "minor" | "nit", string> = {
  blocker: ":no_entry:",
  major: ":warning:",
  minor: ":small_blue_diamond:",
  nit: ":speech_balloon:",
};

export interface SlackBlock {
  type: string;
  text?: { type: "mrkdwn" | "plain_text"; text: string; emoji?: boolean };
  fields?: Array<{ type: "mrkdwn" | "plain_text"; text: string }>;
  elements?: Array<{ type: "mrkdwn"; text: string }>;
}

export interface SlackWebhookPayload {
  text: string;
  username?: string;
  icon_url?: string;
  icon_emoji?: string;
  blocks: SlackBlock[];
}

/**
 * Render a NotifyReviewInput as a Slack incoming-webhook payload.
 *
 * Uses Block Kit (blocks[]) for the rich body; `text` is a fallback for
 * notifications (mobile banner, push digest). The fallback mirrors the
 * verdict + repo so notifications are meaningful even when the full
 * layout doesn't render.
 *
 * Slack limits:
 *   - top-level `text` ≤ 40_000 chars (soft); we truncate at 1_000.
 *   - each block's text ≤ 3_000 chars; we truncate at 2_900 to leave
 *     room for wrappers.
 *   - ≤ 50 blocks per message; we cap on per-agent section count.
 */
export function formatReviewForSlack(input: NotifyReviewInput): SlackWebhookPayload {
  const { outcome, ctx, totalCostUsd, prUrl, episodicId } = input;
  const verdictTag = `${VERDICT_EMOJI[outcome.verdict]} *${outcome.verdict.toUpperCase()}*`;
  const title = `${verdictTag} — ${ctx.repo}${ctx.pullNumber ? ` #${ctx.pullNumber}` : ""}`;

  const blocks: SlackBlock[] = [];

  const headerText = prUrl
    ? `${verdictTag} — <${prUrl}|${escapeText(ctx.repo)} #${ctx.pullNumber}>`
    : title;
  blocks.push({ type: "section", text: { type: "mrkdwn", text: trunc(headerText, 2900) } });
  if (!outcome.consensusReached) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: "_no consensus reached_" }],
    });
  }
  blocks.push({ type: "divider" });

  for (const r of outcome.results) {
    if (blocks.length >= 46) break; // leave slack for divider + footer
    const header = `${VERDICT_EMOJI[r.verdict]} *${r.agent}* — _${r.verdict}_`;
    const lines: string[] = [header];
    if (r.blockers.length === 0) {
      lines.push("_(no blockers)_");
    } else {
      const sorted = [...r.blockers]
        .sort((a, b) => severityOrder(a.severity) - severityOrder(b.severity))
        .slice(0, 3);
      for (const b of sorted) {
        const where = b.file ? ` \`${b.file}${b.line ? `:${b.line}` : ""}\`` : "";
        lines.push(`${SEVERITY_EMOJI[b.severity]} *${b.severity}* (${b.category})${where}`);
        lines.push(`    ${escapeText(b.message)}`);
      }
      if (r.blockers.length > 3) lines.push(`_… +${r.blockers.length - 3} more_`);
    }
    if (r.summary) lines.push(`_${escapeText(trunc(r.summary, 400))}_`);
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: trunc(lines.join("\n"), 2900) },
    });
  }

  blocks.push({ type: "divider" });
  blocks.push({
    type: "context",
    elements: [
      { type: "mrkdwn", text: `cost \`$${totalCostUsd.toFixed(4)}\` · episodic \`${episodicId}\`` },
    ],
  });

  return {
    text: trunc(title, 1000),
    blocks,
  };
}

function severityOrder(s: "blocker" | "major" | "minor" | "nit"): number {
  return { blocker: 0, major: 1, minor: 2, nit: 3 }[s];
}

function trunc(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

/**
 * Slack mrkdwn requires escaping `<`, `>`, `&` to avoid entity parsing.
 * Code fences (backticks) are safe, so blocker `file:line` paths are
 * wrapped in backticks upstream rather than escaped.
 */
function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
