import type { NotifyReviewInput } from "@ai-conclave/core";

const VERDICT_COLOR: Record<"approve" | "rework" | "reject", number> = {
  approve: 0x22c55e, // green-500
  rework: 0xf59e0b, // amber-500
  reject: 0xef4444, // red-500
};

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

export interface DiscordEmbed {
  title: string;
  url?: string;
  description?: string;
  color: number;
  fields: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
  timestamp?: string;
}

export interface DiscordWebhookPayload {
  username?: string;
  avatar_url?: string;
  content?: string;
  embeds: DiscordEmbed[];
}

/**
 * Render a NotifyReviewInput as a Discord webhook payload. One embed per
 * review with color-coded verdict + per-agent fields.
 *
 * Discord embed limits (truncated automatically):
 *   - title ≤ 256 chars
 *   - description ≤ 4096 chars
 *   - field.name ≤ 256, field.value ≤ 1024
 *   - max 25 fields
 *   - total embed size ≤ 6000 chars
 */
export function formatReviewForDiscord(input: NotifyReviewInput): DiscordWebhookPayload {
  const { outcome, ctx, totalCostUsd, prUrl, episodicId } = input;
  const title = trunc(
    `${VERDICT_EMOJI[outcome.verdict]} ${outcome.verdict.toUpperCase()} — ${ctx.repo}${ctx.pullNumber ? ` #${ctx.pullNumber}` : ""}`,
    256,
  );
  const descriptionParts: string[] = [];
  if (!outcome.consensusReached) descriptionParts.push("*no consensus reached*");
  if (descriptionParts.length === 0) descriptionParts.push(`sha \`${ctx.newSha.slice(0, 12)}\``);

  const fields: DiscordEmbed["fields"] = [];
  for (const r of outcome.results) {
    if (fields.length >= 24) break; // leave 1 slot for footer-like info
    const header = `${VERDICT_EMOJI[r.verdict]} ${r.agent}`;
    const lines: string[] = [];
    if (r.blockers.length === 0) {
      lines.push("_(no blockers)_");
    } else {
      const sorted = [...r.blockers]
        .sort((a, b) => severityOrder(a.severity) - severityOrder(b.severity))
        .slice(0, 3);
      for (const b of sorted) {
        const where = b.file ? ` \`${b.file}${b.line ? `:${b.line}` : ""}\`` : "";
        lines.push(`${SEVERITY_EMOJI[b.severity]} **${b.severity}** (${b.category})${where}`);
        lines.push(`    ${b.message}`);
      }
      if (r.blockers.length > 3) lines.push(`… +${r.blockers.length - 3} more`);
    }
    if (r.summary) lines.push(`_${trunc(r.summary, 400)}_`);
    fields.push({ name: header, value: trunc(lines.join("\n"), 1024), inline: false });
  }

  const footerText = `cost $${totalCostUsd.toFixed(4)} · episodic ${episodicId}`;
  const embed: DiscordEmbed = {
    title,
    description: trunc(descriptionParts.join("\n"), 4096),
    color: VERDICT_COLOR[outcome.verdict],
    fields,
    footer: { text: trunc(footerText, 2048) },
    timestamp: new Date().toISOString(),
  };
  if (prUrl) embed.url = prUrl;
  return { embeds: [embed] };
}

function severityOrder(s: "blocker" | "major" | "minor" | "nit"): number {
  return { blocker: 0, major: 1, minor: 2, nit: 3 }[s];
}

function trunc(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
