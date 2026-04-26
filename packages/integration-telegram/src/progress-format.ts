import type { NotifyProgressInput, ProgressStage } from "@conclave-ai/core";

/**
 * v0.11 — Telegram-side rendering for progress streams.
 *
 * Each stage emission produces ONE line. The notifier accumulates lines
 * (in memory for direct path, in D1 for central path) and re-renders the
 * full message before each `editMessageText` call.
 *
 * Format choice: HTML parse_mode (matches the rest of the integration).
 * Each line is prefixed with a single emoji so a glance tells the user
 * whether the phase is in progress (🔵) or done (✅) or has a warning
 * (⚠️). No markdown bullets — Telegram renders them inconsistently
 * across clients.
 */

export interface ProgressLine {
  stage: ProgressStage;
  /** Plain (HTML-escaped) one-line text. No leading emoji — the renderer
   * prepends one based on the stage kind. */
  text: string;
}

const IN_PROGRESS_STAGES: readonly ProgressStage[] = [
  "review-started",
  "visual-capture-started",
  "escalating-to-tier2",
  "autofix-iter-started",
];

function stageEmoji(stage: ProgressStage): string {
  return IN_PROGRESS_STAGES.includes(stage) ? "🔵" : "✅";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatMs(ms?: number): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function joinAgents(ids?: string[]): string {
  if (!ids || ids.length === 0) return "";
  return ids.join(", ");
}

/**
 * Render a single progress stage into a one-line ProgressLine. Pure —
 * test-friendly. The line is HTML-escaped where it interpolates user
 * data (repo slug, agent ids); fixed prose stays as-is.
 */
export function renderProgressLine(input: NotifyProgressInput): ProgressLine {
  const p = input.payload ?? {};
  const repo = p.repo ? escapeHtml(p.repo) : "";
  const pr = typeof p.pullNumber === "number" ? `#${p.pullNumber}` : "";
  const target = [pr, repo].filter(Boolean).join(" ");

  switch (input.stage) {
    case "review-started": {
      const agents = joinAgents(p.agentIds);
      const tail = agents ? ` — agents: ${escapeHtml(agents)}` : "";
      const head = target ? ` on ${target}` : "";
      return { stage: input.stage, text: `Review starting${head}${tail}` };
    }
    case "visual-capture-started": {
      const routes = p.routes && p.routes.length > 0
        ? `${p.routes.length} route${p.routes.length === 1 ? "" : "s"}`
        : "auto-detect routes";
      return { stage: input.stage, text: `Visual capture starting (${routes})` };
    }
    case "visual-capture-done": {
      const n = typeof p.artifactCount === "number" ? p.artifactCount : 0;
      const ms = formatMs(p.totalMs);
      const tail = ms ? `, ${ms}` : "";
      const noun = `${n} pair${n === 1 ? "" : "s"}`;
      return { stage: input.stage, text: `Visual capture done (${noun}${tail})` };
    }
    case "tier1-done": {
      const blockers = typeof p.blockerCount === "number" ? p.blockerCount : 0;
      const rounds = typeof p.rounds === "number" ? `, ${p.rounds} round${p.rounds === 1 ? "" : "s"}` : "";
      const noun = `${blockers} blocker${blockers === 1 ? "" : "s"}`;
      return { stage: input.stage, text: `Tier-1 done (${noun}${rounds})` };
    }
    case "escalating-to-tier2": {
      const reason = p.reason ? ` — ${escapeHtml(p.reason)}` : "";
      return { stage: input.stage, text: `Escalating to tier-2${reason}` };
    }
    case "tier2-done": {
      const blockers = typeof p.blockerCount === "number" ? p.blockerCount : 0;
      const rounds = typeof p.rounds === "number" ? `, ${p.rounds} round${p.rounds === 1 ? "" : "s"}` : "";
      const noun = `${blockers} blocker${blockers === 1 ? "" : "s"}`;
      return { stage: input.stage, text: `Tier-2 done (${noun}${rounds})` };
    }
    case "autofix-iter-started": {
      const n = typeof p.iteration === "number" ? p.iteration : 1;
      return { stage: input.stage, text: `Autofix iteration ${n} starting` };
    }
    case "autofix-iter-done": {
      const n = typeof p.iteration === "number" ? p.iteration : 1;
      const fixed = typeof p.fixesVerified === "number" ? `, ${p.fixesVerified} fix${p.fixesVerified === 1 ? "" : "es"} verified` : "";
      return { stage: input.stage, text: `Autofix iteration ${n} done${fixed}` };
    }
  }
}

/**
 * Render the FULL message (all accumulated lines so far). The notifier
 * passes the running array; each line gets its emoji + text, joined with
 * newlines. A header line tags the chain with the episodic id (truncated)
 * + PR number so a user scrolling past can tell which review they're
 * watching. The header itself is rendered as bold via Telegram's HTML
 * parse_mode so it visually anchors the timeline.
 */
export function renderProgressMessage(
  lines: ProgressLine[],
  meta: { repo?: string; pullNumber?: number; episodicId: string },
): string {
  const repo = meta.repo ? escapeHtml(meta.repo) : "";
  const pr = typeof meta.pullNumber === "number" ? `#${meta.pullNumber}` : "";
  const target = [pr, repo].filter(Boolean).join(" ");
  const epShort = meta.episodicId.length > 8 ? meta.episodicId.slice(0, 8) : meta.episodicId;
  const header = target
    ? `<b>🤖 Conclave review</b> — ${target} <i>(${escapeHtml(epShort)})</i>`
    : `<b>🤖 Conclave review</b> <i>(${escapeHtml(epShort)})</i>`;
  const body = lines.map((l) => `${stageEmoji(l.stage)} ${l.text}`).join("\n");
  return body.length > 0 ? `${header}\n${body}` : header;
}
