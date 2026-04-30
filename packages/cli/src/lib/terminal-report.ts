/**
 * UX-4 — synthesize a non-developer-language terminal report from the
 * autofix iteration history + remaining blockers.
 *
 * Emitted as the `review-finished` ProgressStage payload at the end of
 * the autonomy loop. The renderer in integration-telegram + central-
 * plane writes a Korean (default) summary card with action buttons.
 *
 * Why a separate helper: the synthesizer translates technical category
 * names ("regression" / "contrast" / "missing-state" / "runtime-safety")
 * into user-language phrases ("디버그 코드", "글자 가독성", "포커스
 * 표시", "앱 시작 안전성"). Keep the mapping dense + updatable here
 * rather than scattered across notifier renderers.
 */
import type { AutofixIteration, AutofixResultStatus, Blocker, BlockerFix, ReviewResult } from "@conclave-ai/core";

export type DeployOutcome = "success" | "failure" | "pending" | "unknown";
export type Recommendation = "approve" | "hold" | "reject";

export interface TerminalReportInput {
  status: AutofixResultStatus;
  iterations: readonly AutofixIteration[];
  remainingBlockers: readonly Blocker[];
  totalCostUsd: number;
  cyclesRun: number;
  deployOutcome: DeployOutcome;
}

export interface TerminalReportPayload {
  bailStatus: string;
  iterationsAttempted: number;
  totalCostUsd: number;
  remainingBlockerCount: number;
  cyclesRun: number;
  totalBlockersFound: number;
  blockersAutofixed: number;
  blockersOutstanding: number;
  fixedItems: string[];
  outstandingItems: string[];
  deployOutcome: DeployOutcome;
  recommendation: Recommendation;
}

/**
 * Translate a blocker into a single-sentence non-developer phrase.
 * Falls back to the blocker's message head when the category isn't
 * recognised — better to surface the worker's own words than render a
 * vague placeholder.
 */
export function describeBlockerForUser(b: Blocker): string {
  const cat = (b.category ?? "").toLowerCase();
  const file = b.file ? ` (${b.file})` : "";
  const tail = b.message ? ` — ${b.message.slice(0, 80)}` : "";
  // Category → Korean user-language mapping. Keep entries SHORT (≤ 30
  // chars before the file/message tail) so the rendered list stays
  // scannable on a phone screen.
  const KOREAN: Record<string, string> = {
    contrast: "글자 가독성 (대비) 개선",
    accessibility: "접근성 개선",
    "style-drift": "디자인 시스템 일관성",
    "missing-state": "포커스/호버 상태 표시",
    "design-drift": "디자인 변경 검토",
    "design-spec": "디자인 명세 부합",
    "ui-": "UI 일관성",
    "visual-": "비주얼 회귀",
    "layout-regression": "레이아웃 회귀",
    "cropped-text": "텍스트 잘림 수정",
    overflow: "오버플로 수정",
    regression: "회귀 (이전 동작 깨짐)",
    "debug-code": "디버그 코드 제거",
    logging: "디버그 로그 제거",
    "dead-code": "사용하지 않는 코드 제거",
    security: "보안 개선",
    sec: "보안 개선",
    "secrets-leak": "비밀 키 노출 방지",
    perf: "성능 개선",
    performance: "성능 개선",
    "type-error": "타입 오류 수정",
    "runtime-safety": "앱 시작 안전성",
    stability: "앱 안정성",
    "regression-risk": "회귀 위험",
    process: "검토 프로세스",
    a11y: "접근성 개선",
  };
  // First try exact category, then prefix-match for design/ui/visual
  // namespaces.
  if (KOREAN[cat]) return `${KOREAN[cat]}${file}${tail}`;
  for (const k of Object.keys(KOREAN)) {
    if (k.endsWith("-") && cat.startsWith(k)) return `${KOREAN[k]}${file}${tail}`;
  }
  // Unknown category — surface a generic phrase + file + message head.
  return `${cat || "기타"}${file}${tail}`;
}

/**
 * Pick a verdict recommendation based on terminal status + deploy +
 * outstanding count. Conservative — defaults to "hold" when in doubt.
 */
export function pickRecommendation(input: {
  status: AutofixResultStatus;
  deployOutcome: DeployOutcome;
  outstandingCount: number;
}): Recommendation {
  if (input.status === "approved" || input.status === "awaiting-approval") {
    if (input.deployOutcome === "success" && input.outstandingCount === 0) return "approve";
    if (input.deployOutcome === "failure") return "hold";
    return "hold";
  }
  if (input.status === "deferred-to-next-review") return "hold";
  if (input.status.startsWith("bailed-")) {
    if (input.outstandingCount > 5 || input.deployOutcome === "failure") return "hold";
    return "hold";
  }
  return "hold";
}

/**
 * Build the review-finished payload from autofix's terminal state.
 * Pure — no I/O. Caller emits via emitProgress.
 */
export function buildTerminalReport(input: TerminalReportInput): TerminalReportPayload {
  const allFixes: BlockerFix[] = input.iterations.flatMap((it) => it.fixes);
  const verifiedIters = input.iterations.filter((it) => it.verified);
  // Counted as "autofixed" when the iteration that contained the fix
  // verified end-to-end (build + tests passed AND committed).
  const verifiedReadyFixes: BlockerFix[] = [];
  for (const it of verifiedIters) {
    for (const f of it.fixes) {
      if (f.status === "ready") verifiedReadyFixes.push(f);
    }
  }
  // UX-12 — dedup outstanding blockers BEFORE counting + describing.
  // Multiple agents (claude + design + openai) flag the same underlying
  // bug under different category labels — pre-UX-12 the report showed
  // "9 사람 검토 필요" when in reality there were 4 distinct issues.
  // Bae on PR #47: "사람 검토가 필요한것도 너무 많아 진짜 그걸 다
  // 사람이 봐야해?". Key on (file + first 60 chars of message) so the
  // user sees the real count of distinct issues.
  const dedupeKey = (b: Blocker): string =>
    `${b.file ?? "<unscoped>"}::${(b.message ?? "").slice(0, 60).toLowerCase().trim()}`;
  const seenOutstanding = new Set<string>();
  const dedupedOutstanding: Blocker[] = [];
  for (const b of input.remainingBlockers) {
    const k = dedupeKey(b);
    if (seenOutstanding.has(k)) continue;
    seenOutstanding.add(k);
    dedupedOutstanding.push(b);
  }
  const seenFixed = new Set<string>();
  const dedupedFixed: BlockerFix[] = [];
  for (const f of verifiedReadyFixes) {
    const k = dedupeKey(f.blocker);
    if (seenFixed.has(k)) continue;
    seenFixed.add(k);
    dedupedFixed.push(f);
  }
  const totalBlockersFound = dedupedFixed.length + dedupedOutstanding.length;
  const blockersAutofixed = dedupedFixed.length;
  const blockersOutstanding = dedupedOutstanding.length;
  const fixedItems = dedupedFixed.map((f) => describeBlockerForUser(f.blocker));
  const outstandingItems = dedupedOutstanding.map(describeBlockerForUser);
  const recommendation = pickRecommendation({
    status: input.status,
    deployOutcome: input.deployOutcome,
    outstandingCount: blockersOutstanding,
  });
  return {
    bailStatus: input.status,
    iterationsAttempted: input.iterations.length,
    totalCostUsd: input.totalCostUsd,
    remainingBlockerCount: blockersOutstanding,
    cyclesRun: input.cyclesRun,
    totalBlockersFound,
    blockersAutofixed,
    blockersOutstanding,
    fixedItems,
    outstandingItems,
    deployOutcome: input.deployOutcome,
    recommendation,
  };
}

/**
 * Decide whether the autonomy loop is GENUINELY terminating (no further
 * cycle expected) so review-finished should fire. Pre-this gate, every
 * autofix bail would emit review-finished — including ones that would
 * trigger another cycle via the next push, producing duplicate terminal
 * reports.
 *
 * Rules:
 *   - approved / awaiting-approval → terminal (always)
 *   - deferred-to-next-review → next review.yml will fire on the new
 *     push; THIS run is NOT terminal
 *   - any bailed-* with no push this run → next cycle won't fire (no
 *     commit to trigger review.yml on); terminal
 *   - any bailed-* with push → next cycle will fire; not terminal
 *   - reworkCycle reached maxCycles → terminal regardless
 */
export function isAutonomyTerminal(input: {
  status: AutofixResultStatus;
  pushedThisRun: boolean;
  reworkCycle: number;
  maxCycles: number;
}): boolean {
  if (input.status === "approved") return true;
  if (input.status === "awaiting-approval") return true;
  if (input.status === "deferred-to-next-review") return false;
  // Fence-post: max=3 → cycles 1, 2, 3 all valid. THIS cycle is terminal
  // only when reworkCycle >= maxCycles (i.e., we're AT the last valid
  // cycle right now and there's no cycle+1 to dispatch). Pre-fix used
  // `reworkCycle + 1 >= maxCycles` which fired terminal at cycle 2 of 3
  // — premature, because AF-2 was about to dispatch cycle 3 with the
  // post-fence-post-fix rework.yml. LIVE-caught on PR #53: review-finished
  // arrived BEFORE the cycle 3 message, then cycle 3 ran anyway and the
  // user saw the terminal report sandwiched mid-flow.
  if (input.reworkCycle >= input.maxCycles) return true;
  // Bail at non-final cycle: AF-2 will dispatch the next cycle. Not
  // terminal yet — the next cycle's autofix (or its cycle-ceiling
  // skip step) is responsible for the eventual review-finished emit.
  if (input.status.startsWith("bailed-")) {
    return false;
  }
  return false;
}
