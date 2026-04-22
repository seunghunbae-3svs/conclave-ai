/**
 * Autonomous pipeline messages — v0.8.
 *
 * Renders the 4-state Telegram message copy (approved / reworking /
 * max-cycles-reached / rejected) with locale-aware prose.
 *
 * Why a separate module:
 *   plain-summary.ts routes ALL council output through a cheap LLM call
 *   (claude-haiku-4-5). Autonomy messages are operational ("Conclave is
 *   auto-fixing cycle 2/3...") not narrative — no LLM needed, must be
 *   deterministic so users learn the shape of each state at a glance.
 *
 * The "rework" word is deliberately replaced with user-facing equivalents
 * ("auto-fixing" / "자동 수정 중") per FORBIDDEN_WORDS_* in plain-summary —
 * non-dev audience, same jargon policy.
 */

import type { PlainSummary, PlainSummaryLocale } from "./plain-summary.js";

/**
 * Hard ceiling on how many auto-rework cycles the pipeline will run,
 * regardless of what the user configures in `.conclaverc.json`. Even if
 * `autonomy.maxReworkCycles: 999`, the central plane + CI workflow must
 * stop at 5. This is a safety rail, not a preference.
 */
export const AUTONOMY_HARD_CEILING_CYCLES = 5;

/** Default `autonomy.maxReworkCycles` when the user omits it. */
export const AUTONOMY_DEFAULT_MAX_CYCLES = 3;

export type AutonomyState =
  | "approved"
  | "reworking"
  | "max-cycles-reached"
  | "rejected";

export type AutonomyMergeStrategy = "squash" | "merge" | "rebase";

export interface AutonomyContext {
  state: AutonomyState;
  /** Current rework cycle that just completed (0 = first review). */
  cycle?: number;
  /** Max cycles the user configured (already clamped to hard ceiling). */
  maxCycles?: number;
  /** Number of blockers the PREVIOUS cycle flagged. */
  blockerCountBefore?: number;
  /** Number of blockers AFTER the most-recent rework attempt. */
  blockerCountAfter?: number;
  prNumber: number;
  prUrl: string;
  /** Optional plain summary to quote verbatim in the message. */
  plainSummary?: PlainSummary;
}

export interface RenderedAutonomyMessage {
  /** Final Telegram text (HTML-safe, ready to hand to sendMessage). */
  text: string;
  /**
   * Inline keyboard the caller should attach. The Telegram client
   * serializes this to `reply_markup`. Buttons use callback_data of the
   * form `ep:<episodicId>:<action>` or a `url` for external links.
   * Actions emitted here:
   *   - `merge` / `reject` / `merge-unsafe`
   * Central-plane routes these in `routes/telegram.ts`.
   */
  buttons: AutonomyButton[];
}

export type AutonomyButton =
  | { kind: "callback"; text: string; callbackData: string }
  | { kind: "url"; text: string; url: string };

/**
 * Clamp a user-requested `maxReworkCycles` to the hard ceiling. Exported
 * so the CLI + central-plane can both enforce it without drift.
 */
export function clampMaxCycles(requested: number | undefined): number {
  const n = typeof requested === "number" && Number.isFinite(requested)
    ? Math.floor(requested)
    : AUTONOMY_DEFAULT_MAX_CYCLES;
  if (n <= 0) return 1;
  if (n > AUTONOMY_HARD_CEILING_CYCLES) return AUTONOMY_HARD_CEILING_CYCLES;
  return n;
}

/**
 * Decide the next autonomy state given the latest verdict + cycle count.
 * Pure helper — used by the central plane to branch message rendering,
 * and by tests to assert state transitions.
 */
export function decideAutonomyState(input: {
  verdict: "approve" | "rework" | "reject";
  cycle: number;
  maxCycles: number;
}): AutonomyState {
  const max = clampMaxCycles(input.maxCycles);
  const cycle = Math.max(0, Math.floor(input.cycle));
  if (input.verdict === "approve") return "approved";
  if (input.verdict === "reject") return "rejected";
  // rework
  if (cycle >= max) return "max-cycles-reached";
  return "reworking";
}

/**
 * Build an `ep:<id>:<action>` callback_data string with the 64-byte
 * Telegram cap in mind. The episodic id is ~40 chars so there's headroom
 * for `merge-unsafe` / `merge-confirmed` (17 chars) — total 60 chars.
 */
export function autonomyCallbackData(episodicId: string, action: string): string {
  return `ep:${episodicId}:${action}`;
}

// --- copy tables ----------------------------------------------------------
//
// Kept as objects (not template literals inline) so translations stay
// grep-able and the unit tests can assert exact substrings.

const COPY = {
  approved: {
    en: (ctx: AutonomyContext) =>
      [
        "<b>✅ Ready to merge</b>",
        "",
        `PR #${ctx.prNumber} cleared review.`,
        ...(ctx.plainSummary?.verdictInPlain
          ? ["", `<i>${escapeHtml(ctx.plainSummary.verdictInPlain)}</i>`]
          : []),
      ].join("\n"),
    ko: (ctx: AutonomyContext) =>
      [
        "<b>✅ 병합 준비 완료</b>",
        "",
        `PR #${ctx.prNumber}가 리뷰를 통과했다.`,
        ...(ctx.plainSummary?.verdictInPlain
          ? ["", `<i>${escapeHtml(ctx.plainSummary.verdictInPlain)}</i>`]
          : []),
      ].join("\n"),
  },
  reworking: {
    en: (ctx: AutonomyContext) =>
      [
        "<b>🔄 Conclave is auto-fixing…</b>",
        "",
        `Cycle ${ctx.cycle ?? 0}/${ctx.maxCycles ?? AUTONOMY_DEFAULT_MAX_CYCLES} — worker generates a patch, pushes it back to the PR branch, and the next review runs automatically.`,
        ...(typeof ctx.blockerCountBefore === "number"
          ? [
              "",
              `Previous cycle flagged ${ctx.blockerCountBefore} issue${
                ctx.blockerCountBefore === 1 ? "" : "s"
              }. Sit tight — no action needed yet.`,
            ]
          : ["", "Sit tight — no action needed yet."]),
      ].join("\n"),
    ko: (ctx: AutonomyContext) =>
      [
        "<b>🔄 Conclave가 자동 수정 중…</b>",
        "",
        `${ctx.cycle ?? 0}/${ctx.maxCycles ?? AUTONOMY_DEFAULT_MAX_CYCLES} 사이클 — 워커가 패치를 생성해 PR 브랜치에 푸시하고, 다음 리뷰가 자동으로 돌아간다.`,
        ...(typeof ctx.blockerCountBefore === "number"
          ? [
              "",
              `이전 사이클에서 ${ctx.blockerCountBefore}건의 문제를 발견했다. 아직 조작할 게 없다. 기다린다.`,
            ]
          : ["", "아직 조작할 게 없다. 기다린다."]),
      ].join("\n"),
  },
  "max-cycles-reached": {
    en: (ctx: AutonomyContext) =>
      [
        "<b>⚠️ Auto-fix limit reached</b>",
        "",
        `After ${ctx.maxCycles ?? AUTONOMY_DEFAULT_MAX_CYCLES} cycles, Conclave still sees unresolved issues on PR #${ctx.prNumber}. Manual review recommended.`,
        ...(typeof ctx.blockerCountAfter === "number"
          ? [
              "",
              `Current cycle still flags ${ctx.blockerCountAfter} issue${
                ctx.blockerCountAfter === 1 ? "" : "s"
              }.`,
            ]
          : []),
        "",
        "Choose below. The <i>Merge &amp; Push (unsafe)</i> button bypasses the review gate — use only if you've read the diff.",
      ].join("\n"),
    ko: (ctx: AutonomyContext) =>
      [
        "<b>⚠️ 자동 해결 한계 도달</b>",
        "",
        `${ctx.maxCycles ?? AUTONOMY_DEFAULT_MAX_CYCLES} 사이클 뒤에도 PR #${ctx.prNumber}에 해결되지 않은 문제가 남아 있다. 수동 검토가 필요하다.`,
        ...(typeof ctx.blockerCountAfter === "number"
          ? ["", `현재 사이클에서 ${ctx.blockerCountAfter}건이 남아 있다.`]
          : []),
        "",
        "아래에서 선택한다. <i>병합 & 푸시 (위험)</i> 버튼은 리뷰 게이트를 우회한다. diff를 직접 읽은 경우에만 사용한다.",
      ].join("\n"),
  },
  rejected: {
    en: (ctx: AutonomyContext) =>
      [
        "<b>🔴 Recommended: discard this PR</b>",
        "",
        `Conclave's review suggests PR #${ctx.prNumber} is not salvageable in its current form.`,
        ...(ctx.plainSummary?.verdictInPlain
          ? ["", `<i>${escapeHtml(ctx.plainSummary.verdictInPlain)}</i>`]
          : []),
        "",
        "Close it below, or open it on GitHub for manual review.",
      ].join("\n"),
    ko: (ctx: AutonomyContext) =>
      [
        "<b>🔴 이 PR은 폐기 권장</b>",
        "",
        `Conclave의 리뷰는 PR #${ctx.prNumber}가 현재 형태로는 살리기 어렵다고 판단했다.`,
        ...(ctx.plainSummary?.verdictInPlain
          ? ["", `<i>${escapeHtml(ctx.plainSummary.verdictInPlain)}</i>`]
          : []),
        "",
        "아래에서 닫거나, GitHub에서 수동 리뷰를 연다.",
      ].join("\n"),
  },
} as const;

const BUTTON_LABELS = {
  en: {
    merge: "✅ Merge & Push",
    close: "❌ Close",
    mergeUnsafe: "⚠️ Merge & Push (unsafe)",
    openPr: "🔗 Open PR",
  },
  ko: {
    merge: "✅ 병합 & 푸시",
    close: "❌ 닫기",
    mergeUnsafe: "⚠️ 병합 & 푸시 (위험)",
    openPr: "🔗 PR 열기",
  },
} as const;

/**
 * Render the Telegram message + inline buttons for an autonomy state.
 *
 * Contract:
 *   - `approved` → [Merge & Push] [Close]
 *   - `reworking` → no buttons (user is told to wait, auto-loop running)
 *   - `max-cycles-reached` → [Merge & Push (unsafe)] [Close] [Open PR]
 *       The unsafe button is omitted by the central plane when
 *       `autonomy.allowUnsafeMerge === false`, but this renderer always
 *       emits the button spec — the caller filters.
 *   - `rejected` → [Close] [Open PR]
 */
export function renderAutonomyMessage(
  ctx: AutonomyContext,
  locale: PlainSummaryLocale,
  episodicId: string,
): RenderedAutonomyMessage {
  const body = COPY[ctx.state][locale](ctx);
  const labels = BUTTON_LABELS[locale];
  const buttons: AutonomyButton[] = [];

  switch (ctx.state) {
    case "approved":
      buttons.push(
        { kind: "callback", text: labels.merge, callbackData: autonomyCallbackData(episodicId, "merge") },
        { kind: "callback", text: labels.close, callbackData: autonomyCallbackData(episodicId, "reject") },
      );
      break;
    case "reworking":
      // Deliberately none — the user is told "sit tight".
      break;
    case "max-cycles-reached":
      buttons.push(
        {
          kind: "callback",
          text: labels.mergeUnsafe,
          callbackData: autonomyCallbackData(episodicId, "merge-unsafe"),
        },
        { kind: "callback", text: labels.close, callbackData: autonomyCallbackData(episodicId, "reject") },
        { kind: "url", text: labels.openPr, url: ctx.prUrl },
      );
      break;
    case "rejected":
      buttons.push(
        { kind: "callback", text: labels.close, callbackData: autonomyCallbackData(episodicId, "reject") },
        { kind: "url", text: labels.openPr, url: ctx.prUrl },
      );
      break;
  }

  return { text: body, buttons };
}

/**
 * Build the Telegram inline_keyboard structure from the rendered buttons.
 * Single row; Telegram auto-wraps if it overflows the width. Separated
 * from renderAutonomyMessage so the central plane can drop specific
 * buttons (e.g. merge-unsafe when allowUnsafeMerge is false) before
 * serializing.
 */
export function buttonsToInlineKeyboard(
  buttons: readonly AutonomyButton[],
): { inline_keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>> } {
  const row = buttons.map((b) =>
    b.kind === "callback"
      ? { text: b.text, callback_data: b.callbackData }
      : { text: b.text, url: b.url },
  );
  return { inline_keyboard: row.length > 0 ? [row] : [] };
}

// HTML-escape user-supplied prose before concatenating into the message
// body. The body itself uses hand-audited tags (<b>, <i>) only.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// --- commit-message marker parsing ----------------------------------------
//
// Rework commits embed `[conclave-rework-cycle:N]` in their message so
// the review workflow can extract N without a separate state store.
// Keeping the pattern + parser in core means CLI + central-plane share
// the exact same regex (and the tests lock it in).

const CYCLE_MARKER_RE = /\[conclave-rework-cycle:(\d+)\]/i;

/**
 * Extract the cycle counter from a commit message (or from the full
 * trailer block on HEAD^). Returns `0` when no marker is present — first
 * human-authored commit never carries the marker.
 */
export function parseCycleFromCommitMessage(message: string | null | undefined): number {
  if (!message) return 0;
  const m = CYCLE_MARKER_RE.exec(message);
  if (!m || !m[1]) return 0;
  const n = Number.parseInt(m[1], 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, AUTONOMY_HARD_CEILING_CYCLES);
}

/** Format the marker for inclusion in a rework commit message. */
export function formatCycleMarker(cycle: number): string {
  return `[conclave-rework-cycle:${Math.max(0, Math.floor(cycle))}]`;
}
