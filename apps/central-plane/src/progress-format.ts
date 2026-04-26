/**
 * v0.11 — Telegram progress-stage renderer for the central plane.
 *
 * Mirrors `@conclave-ai/integration-telegram/src/progress-format.ts` —
 * the format MUST stay in sync so direct-path and central-path messages
 * look identical in a chat. We don't import the integration-telegram
 * package here because that package targets Node + bundles a different
 * TelegramClient; central-plane runs on Cloudflare Workers with its own
 * client. The duplicated code is small (~70 lines) and the contract is
 * trivially testable per side.
 *
 * Drift policy: any change here MUST land in the same PR as the change
 * to packages/integration-telegram/src/progress-format.ts. The shared
 * test fixture in test/progress-format.test.mjs cross-checks both
 * renderers against the same inputs.
 */

import { escapeHtml } from "./telegram.js";

export type ProgressStage =
  | "review-started"
  | "visual-capture-started"
  | "visual-capture-done"
  | "tier1-done"
  | "escalating-to-tier2"
  | "tier2-done"
  | "autofix-iter-started"
  | "autofix-iter-done";

export interface ProgressPayload {
  repo?: string;
  pullNumber?: number;
  agentIds?: string[];
  blockerCount?: number;
  rounds?: number;
  artifactCount?: number;
  routes?: string[];
  totalMs?: number;
  iteration?: number;
  fixesVerified?: number;
  reason?: string;
}

export interface ProgressLine {
  stage: ProgressStage;
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

function formatMs(ms?: number): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function renderProgressLine(stage: ProgressStage, payload: ProgressPayload | undefined): ProgressLine {
  const p = payload ?? {};
  const repo = p.repo ? escapeHtml(p.repo) : "";
  const pr = typeof p.pullNumber === "number" ? `#${p.pullNumber}` : "";
  const target = [pr, repo].filter(Boolean).join(" ");
  switch (stage) {
    case "review-started": {
      const agents = p.agentIds && p.agentIds.length > 0 ? p.agentIds.join(", ") : "";
      const tail = agents ? ` — agents: ${escapeHtml(agents)}` : "";
      const head = target ? ` on ${target}` : "";
      return { stage, text: `Review starting${head}${tail}` };
    }
    case "visual-capture-started": {
      const routes = p.routes && p.routes.length > 0
        ? `${p.routes.length} route${p.routes.length === 1 ? "" : "s"}`
        : "auto-detect routes";
      return { stage, text: `Visual capture starting (${routes})` };
    }
    case "visual-capture-done": {
      const n = typeof p.artifactCount === "number" ? p.artifactCount : 0;
      const ms = formatMs(p.totalMs);
      const tail = ms ? `, ${ms}` : "";
      const noun = `${n} pair${n === 1 ? "" : "s"}`;
      return { stage, text: `Visual capture done (${noun}${tail})` };
    }
    case "tier1-done": {
      const blockers = typeof p.blockerCount === "number" ? p.blockerCount : 0;
      const rounds = typeof p.rounds === "number" ? `, ${p.rounds} round${p.rounds === 1 ? "" : "s"}` : "";
      const noun = `${blockers} blocker${blockers === 1 ? "" : "s"}`;
      return { stage, text: `Tier-1 done (${noun}${rounds})` };
    }
    case "escalating-to-tier2": {
      const reason = p.reason ? ` — ${escapeHtml(p.reason)}` : "";
      return { stage, text: `Escalating to tier-2${reason}` };
    }
    case "tier2-done": {
      const blockers = typeof p.blockerCount === "number" ? p.blockerCount : 0;
      const rounds = typeof p.rounds === "number" ? `, ${p.rounds} round${p.rounds === 1 ? "" : "s"}` : "";
      const noun = `${blockers} blocker${blockers === 1 ? "" : "s"}`;
      return { stage, text: `Tier-2 done (${noun}${rounds})` };
    }
    case "autofix-iter-started": {
      const n = typeof p.iteration === "number" ? p.iteration : 1;
      return { stage, text: `Autofix iteration ${n} starting` };
    }
    case "autofix-iter-done": {
      const n = typeof p.iteration === "number" ? p.iteration : 1;
      const fixed = typeof p.fixesVerified === "number"
        ? `, ${p.fixesVerified} fix${p.fixesVerified === 1 ? "" : "es"} verified`
        : "";
      return { stage, text: `Autofix iteration ${n} done${fixed}` };
    }
  }
}

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

/**
 * v0.11 — TelegramClient.editMessageText needs a chat_id + message_id.
 * Truncate the persisted line array so a long-running review doesn't
 * blow past Telegram's 4096-char message cap. 24 stages fits well
 * within budget at typical line widths (~80 chars/line).
 */
export const TELEGRAM_TEXT_LIMIT_LINES = 24;
