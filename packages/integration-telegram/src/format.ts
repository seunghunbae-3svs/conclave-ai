import type { Blocker, NotifyReviewInput, PlainSummary, ReviewResult } from "@conclave-ai/core";

const VERDICT_EMOJI: Record<"approve" | "rework" | "reject", string> = {
  approve: "✅",
  rework: "🔧",
  reject: "❌",
};

const VERDICT_LABEL: Record<"approve" | "rework" | "reject", string> = {
  approve: "Approved",
  rework: "Needs changes",
  reject: "Rejected",
};

const SEVERITY_EMOJI: Record<"blocker" | "major" | "minor" | "nit", string> = {
  blocker: "🛑",
  major: "⚠️",
  minor: "🔹",
  nit: "💬",
};

/**
 * Humanize our internal `category` strings into a label a non-developer
 * can read. Unknown categories pass through as-is so domain-specific
 * tags don't get rewritten.
 */
const CATEGORY_LABEL: Record<string, string> = {
  "workflow-security": "CI workflow security",
  "secrets-exposure": "Possible secret leak",
  "supply-chain": "Supply-chain risk",
  security: "Security",
  "type-error": "Type mismatch",
  "missing-test": "Missing test coverage",
  regression: "Possible regression",
  accessibility: "Accessibility",
  contrast: "Colour contrast",
  performance: "Performance",
  "dead-code": "Unused code",
  "api-misuse": "API misuse",
  "schema-drift": "Schema drift",
  "agent-failure": "Agent runtime error",
  other: "Other",
};

function humanCategory(cat: string): string {
  return CATEGORY_LABEL[cat] ?? cat;
}

/** Telegram HTML mode allows <b>, <i>, <code>, <pre>, <a href>. Escape &, <, >. */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function severityOrder(s: Blocker["severity"]): number {
  return { blocker: 0, major: 1, minor: 2, nit: 3 }[s];
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

interface MergedBlocker {
  severity: Blocker["severity"];
  category: string;
  message: string;
  file?: string;
  line?: number;
  agreeingAgents: string[];
}

/**
 * Merge blockers across agents that point at the same file:line.
 * Keeps the highest severity, the longest message (usually most
 * informative), and the list of agents that flagged it — so the
 * summary can show "Claude + OpenAI agree" as a consensus cue.
 */
function mergeBlockers(results: readonly ReviewResult[]): MergedBlocker[] {
  const byKey = new Map<string, MergedBlocker>();
  const unkeyed: MergedBlocker[] = [];

  for (const r of results) {
    for (const b of r.blockers) {
      const key = b.file ? `${b.file}:${b.line ?? ""}` : null;
      if (!key) {
        unkeyed.push({
          severity: b.severity,
          category: b.category,
          message: b.message,
          agreeingAgents: [r.agent],
        });
        continue;
      }
      const existing = byKey.get(key);
      if (!existing) {
        const merged: MergedBlocker = {
          severity: b.severity,
          category: b.category,
          message: b.message,
          agreeingAgents: [r.agent],
        };
        if (b.file) merged.file = b.file;
        if (b.line !== undefined) merged.line = b.line;
        byKey.set(key, merged);
        continue;
      }
      // Higher severity wins (lower enum index).
      if (severityOrder(b.severity) < severityOrder(existing.severity)) {
        existing.severity = b.severity;
        existing.category = b.category;
      }
      // Keep the longer message — typically more informative.
      if (b.message.length > existing.message.length) existing.message = b.message;
      if (!existing.agreeingAgents.includes(r.agent)) existing.agreeingAgents.push(r.agent);
    }
  }

  return [...byKey.values(), ...unkeyed].sort(
    (a, b) => severityOrder(a.severity) - severityOrder(b.severity),
  );
}

/**
 * Render a NotifyReviewInput into a Telegram HTML-mode message body.
 *
 * Designed for non-developer readability:
 *   - Verdict + repo link on one header line
 *   - Cross-agent deduplication: same file:line → single entry with
 *     "agreeing agents" footer (e.g. "Claude + OpenAI agree")
 *   - Top 3 DISTINCT blockers (highest severity first)
 *   - Humanized category labels (workflow-security → "CI workflow security")
 *   - Compact footer: cost + agent count, episodic id on its own line
 *
 * Max 4096 chars per Telegram; truncates with ellipsis.
 */
export function formatReviewForTelegram(input: NotifyReviewInput): string {
  const { outcome, ctx, totalCostUsd, prUrl, episodicId } = input;
  const lines: string[] = [];

  const repoLabel = `${ctx.repo}${ctx.pullNumber ? ` #${ctx.pullNumber}` : ""}`;
  const repoDisplay = prUrl ? `<a href="${esc(prUrl)}">${esc(repoLabel)}</a>` : `<b>${esc(repoLabel)}</b>`;
  const verdictLine = `${VERDICT_EMOJI[outcome.verdict]} <b>${VERDICT_LABEL[outcome.verdict]}</b>`;
  const consensusTag = outcome.consensusReached ? "" : " · <i>no consensus</i>";
  lines.push(`🏛️ Conclave AI — ${repoDisplay}`);
  lines.push(verdictLine + consensusTag);
  lines.push("");

  if (outcome.verdict === "approve") {
    lines.push("<i>All agents agreed the change is ready to ship.</i>");
  } else {
    const merged = mergeBlockers(outcome.results);
    const top = merged.slice(0, 3);
    const rest = merged.length - top.length;

    if (top.length === 0) {
      lines.push("<i>No specific blockers named, but agents did not approve.</i>");
    } else {
      lines.push(`<b>Top issues to fix</b> (${merged.length} total)`);
      lines.push("");
      top.forEach((b, i) => {
        const head = `${i + 1}. ${SEVERITY_EMOJI[b.severity]} <b>${esc(humanCategory(b.category))}</b>`;
        lines.push(head);
        lines.push(`   ${esc(truncate(b.message, 220))}`);
        if (b.file) {
          const where = `${esc(b.file)}${b.line ? `:${b.line}` : ""}`;
          lines.push(`   <code>${where}</code>`);
        }
        if (b.agreeingAgents.length > 1) {
          const joined = b.agreeingAgents.map((a) => a[0]?.toUpperCase() + a.slice(1)).join(" + ");
          lines.push(`   <i>${joined} agree</i>`);
        }
        lines.push("");
      });
      if (rest > 0) lines.push(`<i>+ ${rest} more issue${rest === 1 ? "" : "s"}</i>`);
    }
  }

  lines.push("");
  lines.push(
    `<i>💰 $${totalCostUsd.toFixed(2)} · agents: ${outcome.results.length}</i>`,
  );
  lines.push(`<i>ref: <code>${esc(episodicId)}</code></i>`);

  const message = lines.join("\n");
  return message.length <= 4090 ? message : message.slice(0, 4085) + "\n…";
}

/**
 * v0.6.1 — plain-language body for non-dev Telegram users. Uses the
 * three prose paragraphs produced by `generatePlainSummary`, adds a
 * compact header (repo + PR link), and appends the full-report link.
 * Intentionally no emoji, no severity tags, no category chips — this
 * is the message a non-developer actually wants.
 */
export function formatPlainSummaryForTelegram(input: NotifyReviewInput): string {
  const plain: PlainSummary | undefined = input.plainSummary;
  if (!plain) return formatReviewForTelegram(input);

  const { ctx, prUrl, episodicId } = input;
  const lines: string[] = [];

  const repoLabel = `${ctx.repo}${ctx.pullNumber ? ` #${ctx.pullNumber}` : ""}`;
  const header = prUrl
    ? `<a href="${esc(prUrl)}">${esc(repoLabel)}</a>`
    : `<b>${esc(repoLabel)}</b>`;
  lines.push(`🏛️ Conclave — ${header}`);
  lines.push("");

  if (plain.whatChanged) {
    lines.push(esc(plain.whatChanged));
    lines.push("");
  }
  if (plain.verdictInPlain) {
    lines.push(esc(plain.verdictInPlain));
    lines.push("");
  }
  if (plain.nextAction) {
    lines.push(esc(plain.nextAction));
    lines.push("");
  }

  if (prUrl) {
    const fullLabel = plain.locale === "ko" ? "전체 리포트" : "Full report";
    lines.push(`<a href="${esc(prUrl)}">${fullLabel}</a>`);
  }
  lines.push(`<i>ref: <code>${esc(episodicId)}</code></i>`);

  const message = lines.join("\n");
  return message.length <= 4090 ? message : message.slice(0, 4085) + "\n…";
}
