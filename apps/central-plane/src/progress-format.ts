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
  | "autofix-iter-done"
  // UX-2 / UX-3 — added in cli@0.14.2 to mirror the integration-telegram
  // package. Drift caused HTTP 400 on every emit (eventbadge PR #40).
  | "autofix-cycle-ended"
  | "autofix-blocker-started"
  | "autofix-blocker-done"
  // UX-4 — terminal user-facing report. Sent as a SEPARATE Telegram
  // message (new sendMessage, not editMessageText) at the end of the
  // autonomy loop, AFTER deploy status has settled.
  | "review-finished"
  // UX-13 — fresh Telegram message per rework cycle.
  | "rework-cycle-started";

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
  // UX-2 — terminal status fields.
  bailStatus?: string;
  iterationsAttempted?: number;
  totalCostUsd?: number;
  remainingBlockerCount?: number;
  // UX-3 — per-blocker fields.
  blockerIndex?: number;
  blockerTotal?: number;
  blockerLabel?: string;
  blockerOutcome?: string;
  // UX-4 — terminal report fields (mirrors @conclave-ai/core).
  cyclesRun?: number;
  totalBlockersFound?: number;
  blockersAutofixed?: number;
  blockersOutstanding?: number;
  fixedItems?: string[];
  outstandingItems?: string[];
  deployOutcome?: string;
  recommendation?: string;
  // UX-15 — preview / PR links surfaced on the terminal card.
  previewUrl?: string;
  prUrl?: string;
}

export interface ProgressLine {
  stage: ProgressStage;
  text: string;
  // UX-2 — preserve bailStatus across re-renders so stageEmoji can
  // pick the right terminal glyph.
  bailStatus?: string;
}

const IN_PROGRESS_STAGES: readonly ProgressStage[] = [
  "review-started",
  "rework-cycle-started",
  "visual-capture-started",
  "escalating-to-tier2",
  "autofix-iter-started",
  "autofix-blocker-started",
];

const TERMINAL_BAIL_PREFIXES = ["bailed-", "loop-guard-trip"];

function stageEmoji(stage: ProgressStage, payload?: { bailStatus?: string }): string {
  // UX-2 — terminal cycle ended emoji selection.
  if (stage === "autofix-cycle-ended") {
    const bs = payload?.bailStatus ?? "";
    if (bs === "approved" || bs === "awaiting-approval") return "✅";
    if (bs === "deferred-to-next-review") return "⏭";
    if (TERMINAL_BAIL_PREFIXES.some((p) => bs === p || bs.startsWith(p))) return "🛑";
    return "ℹ️";
  }
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
    // UX-13 — fresh Telegram message per rework cycle. Same wording as
    // the integration-telegram side (drift-checked by stage-drift-invariant).
    case "rework-cycle-started": {
      const it = typeof p.iteration === "number" ? p.iteration : 0;
      const max = typeof p.iterationsAttempted === "number" ? p.iterationsAttempted : null;
      const counter = max ? `${it}/${max}` : `${it}`;
      const head = target ? ` on ${target}` : "";
      return { stage, text: `🔄 Conclave is auto-fixing (${counter})${head}` };
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
    // UX-3 — per-blocker progress.
    case "autofix-blocker-started": {
      const idx = typeof p.blockerIndex === "number" ? p.blockerIndex : 0;
      const tot = typeof p.blockerTotal === "number" ? p.blockerTotal : 0;
      const label = p.blockerLabel ? escapeHtml(p.blockerLabel) : "";
      return { stage, text: `  → fixing blocker ${idx}/${tot}${label ? ` — ${label}` : ""}` };
    }
    case "autofix-blocker-done": {
      const idx = typeof p.blockerIndex === "number" ? p.blockerIndex : 0;
      const tot = typeof p.blockerTotal === "number" ? p.blockerTotal : 0;
      const out = p.blockerOutcome ?? "";
      const outGlyph = out === "ready" ? "✓" : out === "skipped" ? "⊘" : out === "conflict" ? "✗" : out === "secret-block" ? "🔒" : out === "worker-error" ? "⚠" : "·";
      return { stage, text: `  ${outGlyph} blocker ${idx}/${tot}${out ? ` — ${escapeHtml(out)}` : ""}` };
    }
    // UX-2 — terminal cycle status.
    case "autofix-cycle-ended": {
      const status = p.bailStatus ?? "ended";
      const iters = typeof p.iterationsAttempted === "number" ? p.iterationsAttempted : 0;
      const cost = typeof p.totalCostUsd === "number" ? `, $${p.totalCostUsd.toFixed(4)}` : "";
      const remaining = typeof p.remainingBlockerCount === "number" && p.remainingBlockerCount > 0
        ? `, ${p.remainingBlockerCount} blocker${p.remainingBlockerCount === 1 ? "" : "s"} remain`
        : "";
      const reason = p.reason ? ` — ${escapeHtml(p.reason).slice(0, 120)}` : "";
      return {
        stage,
        text: `Cycle ended: ${escapeHtml(status)} (${iters} iter${iters === 1 ? "" : "s"}${cost}${remaining})${reason}`,
        bailStatus: status,
      };
    }
    // UX-4 — terminal user-facing report (non-dev language). Note:
    // this case returns only the rendered text; the actual SEND uses
    // sendMessage (not editMessageText) so it lands as a separate
    // Telegram message. Caller in routes/review.ts detects this stage
    // and routes to renderTerminalReport instead of the chain editor.
    case "review-finished": {
      const cycles = typeof p.cyclesRun === "number" ? p.cyclesRun : 1;
      const found = typeof p.totalBlockersFound === "number" ? p.totalBlockersFound : 0;
      const fixed = typeof p.blockersAutofixed === "number" ? p.blockersAutofixed : 0;
      const outstanding = typeof p.blockersOutstanding === "number" ? p.blockersOutstanding : 0;
      const cost = typeof p.totalCostUsd === "number" ? p.totalCostUsd.toFixed(4) : "0.00";
      const deploy = p.deployOutcome ?? "unknown";
      const rec = p.recommendation ?? "hold";
      const fixedList = (p.fixedItems ?? []).slice(0, 8).map((s) => `  • ${escapeHtml(s)}`).join("\n");
      const outstandingList = (p.outstandingItems ?? []).slice(0, 8).map((s) => `  • ${escapeHtml(s)}`).join("\n");
      const deployGlyph = deploy === "success" ? "✅" : deploy === "failure" ? "❌" : deploy === "pending" ? "⏳" : "❔";
      const recHeadline = rec === "approve" ? "✅ <b>승인 권장</b>" : rec === "reject" ? "❌ <b>거부 권장</b>" : "⏸ <b>보류 권장</b>";
      const lines = [
        `<b>🤖 Conclave 검토 완료</b>`,
        ``,
        `${cycles}회의 검토 사이클을 거쳐 총 ${found}건의 문제를 발견했습니다.`,
        `자동 수정: ${fixed}건 · 사람 손 필요: ${outstanding}건 · 비용: $${cost}`,
        `배포 상태: ${deployGlyph} ${escapeHtml(deploy)}`,
      ];
      // UX-15 — preview + PR links so non-devs can click + see, not read code.
      const links: string[] = [];
      if (typeof p.previewUrl === "string" && p.previewUrl.length > 0) {
        links.push(`<a href="${escapeHtml(p.previewUrl)}">미리보기 화면</a>`);
      }
      if (typeof p.prUrl === "string" && p.prUrl.length > 0) {
        links.push(`<a href="${escapeHtml(p.prUrl)}">PR 페이지</a>`);
      }
      if (links.length > 0) {
        lines.push(``, links.join(" · "));
      }
      lines.push(``);
      if (fixedList) lines.push(`<b>고친 내용</b>`, fixedList, ``);
      if (outstandingList) lines.push(`<b>남은 항목 (사람 검토 필요)</b>`, outstandingList, ``);
      lines.push(recHeadline);
      return { stage, text: lines.join("\n") };
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
  const body = lines.map((l) => `${stageEmoji(l.stage, { bailStatus: l.bailStatus })} ${l.text}`).join("\n");
  return body.length > 0 ? `${header}\n${body}` : header;
}

/**
 * v0.11 — TelegramClient.editMessageText needs a chat_id + message_id.
 * Truncate the persisted line array so a long-running review doesn't
 * blow past Telegram's 4096-char message cap. 24 stages fits well
 * within budget at typical line widths (~80 chars/line).
 */
export const TELEGRAM_TEXT_LIMIT_LINES = 24;
