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
  /** UX-2 — carries bailStatus so stageEmoji can pick the right terminal
   * glyph (✅/⏭/🛑/ℹ️) when re-rendering. Other stages leave it undefined. */
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
  // UX-2 — terminal cycle: choose emoji by bailStatus.
  //   approved / awaiting-approval         → ✅
  //   deferred-to-next-review              → ⏭
  //   bailed-* / loop-guard-trip           → 🛑
  if (stage === "autofix-cycle-ended") {
    const bs = payload?.bailStatus ?? "";
    if (bs === "approved" || bs === "awaiting-approval") return "✅";
    if (bs === "deferred-to-next-review") return "⏭";
    if (TERMINAL_BAIL_PREFIXES.some((p) => bs === p || bs.startsWith(p))) return "🛑";
    return "ℹ️";
  }
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
    // UX-13 — fresh Telegram message per rework cycle. Wording matches
    // the per-cycle counter Bae sees ("auto-fixing 1/3, 2/3, 3/3") so
    // every dispatch reads the same way.
    case "rework-cycle-started": {
      const it = typeof p.iteration === "number" ? p.iteration : 0;
      const max = typeof p.iterationsAttempted === "number" ? p.iterationsAttempted : null;
      const counter = max ? `${it}/${max}` : `${it}`;
      const head = target ? ` on ${target}` : "";
      return { stage: input.stage, text: `🔄 Conclave is auto-fixing (${counter})${head}` };
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
    // UX-3 — per-blocker progress so 9-blocker iterations show concrete work.
    case "autofix-blocker-started": {
      const idx = typeof p.blockerIndex === "number" ? p.blockerIndex : 0;
      const tot = typeof p.blockerTotal === "number" ? p.blockerTotal : 0;
      const label = p.blockerLabel ? escapeHtml(p.blockerLabel) : "";
      return { stage: input.stage, text: `  → fixing blocker ${idx}/${tot}${label ? ` — ${label}` : ""}` };
    }
    case "autofix-blocker-done": {
      const idx = typeof p.blockerIndex === "number" ? p.blockerIndex : 0;
      const tot = typeof p.blockerTotal === "number" ? p.blockerTotal : 0;
      const out = p.blockerOutcome ?? "";
      // Per-outcome glyph so the user sees readiness at a glance
      // without parsing the word.
      const outGlyph = out === "ready" ? "✓" : out === "skipped" ? "⊘" : out === "conflict" ? "✗" : out === "secret-block" ? "🔒" : out === "worker-error" ? "⚠" : "·";
      return { stage: input.stage, text: `  ${outGlyph} blocker ${idx}/${tot}${out ? ` — ${escapeHtml(out)}` : ""}` };
    }
    // UX-2 — terminal cycle status. Lines render with status-specific emoji
    // (see stageEmoji) plus a one-line headline matching the PR-comment
    // body's headline so the user sees the same verdict on both surfaces.
    case "autofix-cycle-ended": {
      const status = p.bailStatus ?? "ended";
      const iters = typeof p.iterationsAttempted === "number" ? p.iterationsAttempted : 0;
      const cost = typeof p.totalCostUsd === "number" ? `, $${p.totalCostUsd.toFixed(4)}` : "";
      const remaining = typeof p.remainingBlockerCount === "number" && p.remainingBlockerCount > 0
        ? `, ${p.remainingBlockerCount} blocker${p.remainingBlockerCount === 1 ? "" : "s"} remain`
        : "";
      const reason = p.reason ? ` — ${escapeHtml(p.reason).slice(0, 120)}` : "";
      return {
        stage: input.stage,
        text: `Cycle ended: ${escapeHtml(status)} (${iters} iter${iters === 1 ? "" : "s"}${cost}${remaining})${reason}`,
        bailStatus: status,
      };
    }
    // UX-4 — terminal user-facing report. Multi-line, non-dev language,
    // emitted as a SEPARATE Telegram message (not appended to the
    // progress chain). The renderer here returns plain text; the
    // notifier sends it as a fresh message with action buttons.
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
      // UX-15 — clickable preview + PR links.
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
      lines.push(`${recHeadline}`);
      return { stage: input.stage, text: lines.join("\n") };
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
  const body = lines.map((l) => `${stageEmoji(l.stage, { bailStatus: l.bailStatus })} ${l.text}`).join("\n");
  return body.length > 0 ? `${header}\n${body}` : header;
}
