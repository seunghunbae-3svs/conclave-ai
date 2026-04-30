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
 * Translate a blocker into a non-developer-readable description with an
 * actionable hint. Format: "{한국어 카테고리}: {어디} — {뭘 해야 하나}"
 *
 * Pre-fix the message tail dumped raw English jargon
 * ("initFeatureFlagsRuntime() runs before React renders…") which is
 * unreadable for non-developers. Now: identifier-shaped tokens are
 * normalized to "한 부분" / "한 함수", file paths get plain-language
 * locations ("주소 검색 컴포넌트"), and a short user-action sentence
 * is added ("개발자에게 임포트 누락 확인 요청해주세요").
 */
export function describeBlockerForUser(b: Blocker): string {
  const cat = (b.category ?? "").toLowerCase();
  const KOREAN: Record<string, string> = {
    contrast: "글자 가독성 (대비)",
    accessibility: "접근성",
    "style-drift": "디자인 시스템 일관성",
    "missing-state": "포커스/호버 상태",
    "design-drift": "디자인 변경 검토",
    "design-spec": "디자인 명세 부합",
    "ui-": "UI 일관성",
    "visual-": "비주얼 회귀",
    "layout-regression": "레이아웃 회귀",
    "cropped-text": "텍스트 잘림",
    overflow: "오버플로",
    regression: "이전 동작 깨짐",
    "debug-code": "디버그 코드 잔여",
    logging: "디버그 로그 잔여",
    "dead-code": "사용하지 않는 코드",
    security: "보안",
    sec: "보안",
    "secrets-leak": "비밀 키 노출",
    perf: "성능",
    performance: "성능",
    "type-error": "타입 오류",
    "runtime-safety": "앱 시작 안전성",
    stability: "앱 안정성",
    "regression-risk": "회귀 위험",
    "missing-import": "임포트 누락",
    "import-error": "임포트 오류",
    process: "검토 프로세스",
    a11y: "접근성",
  };
  // Action hint per category — what a non-developer should do.
  const ACTION: Record<string, string> = {
    contrast: "글자 색이 잘 보이도록 디자이너 검토 필요",
    accessibility: "장애가 있는 사용자에게도 보이도록 디자이너/개발자 확인 필요",
    "style-drift": "디자인 시스템 색을 다시 맞추도록 디자이너에게 요청",
    "missing-state": "포커스/호버 표시를 더해야 함 (디자이너 검토)",
    "missing-import": "개발자에게 임포트 누락 확인 요청",
    "import-error": "개발자에게 임포트 경로 확인 요청",
    regression: "이전과 비교해 동작이 바뀐 부분 — 개발자 확인 필요",
    "debug-code": "릴리스 전에 개발자가 디버그 코드 제거",
    logging: "릴리스 전에 개발자가 로그 코드 제거",
    "dead-code": "개발자가 사용하지 않는 코드 정리",
    security: "보안 검토 필수 — 개발자/보안 담당자 확인",
    "secrets-leak": "보안 위험 — 즉시 키 폐기 + 개발자 확인",
    perf: "성능 영향 — 개발자 검토",
    performance: "성능 영향 — 개발자 검토",
    "type-error": "타입 오류 — 개발자 수정 필요",
    "runtime-safety": "앱이 시작 못 할 수 있음 — 개발자 확인 필요",
    stability: "앱이 죽을 수 있음 — 개발자 확인 필요",
    "regression-risk": "회귀 가능성 — 개발자 확인 필요",
    "design-drift": "디자인 의도와 다름 — 디자이너 검토",
    a11y: "접근성 검토 — 디자이너/개발자",
    "layout-regression": "레이아웃 깨짐 — 디자이너 검토",
    "cropped-text": "텍스트가 잘림 — 디자이너 검토",
    overflow: "콘텐츠가 넘침 — 디자이너 검토",
    process: "검토 프로세스 관련 — 팀 리드 확인",
  };
  // Plain-language file location.
  const where = b.file ? plainFileLocation(b.file, b.line) : "";
  // Look up category — exact, then prefix-match for design-/ui-/visual-.
  let label = "";
  let action = "";
  if (KOREAN[cat]) {
    label = KOREAN[cat];
    action = ACTION[cat] ?? "";
  } else {
    for (const k of Object.keys(KOREAN)) {
      if (k.endsWith("-") && cat.startsWith(k)) {
        label = KOREAN[k]!;
        action = ACTION[k] ?? "";
        break;
      }
    }
  }
  if (!label) {
    label = "기타";
    action = "개발자 확인 필요";
  }
  // Build: "[label]: [where] — [action]"
  const parts: string[] = [label];
  if (where) parts.push(`: ${where}`);
  if (action) parts.push(` — ${action}`);
  return parts.join("");
}

/**
 * Translate a repo-relative file path into a non-developer-friendly
 * location. Maps common conventions:
 *   frontend/src/components/Foo.jsx → "Foo 컴포넌트"
 *   frontend/src/pages/Home.jsx     → "Home 페이지"
 *   frontend/src/main.jsx           → "앱 시작 파일"
 *   frontend/src/utils/x.js         → "x 유틸리티"
 *   else                            → 파일 이름만
 */
function plainFileLocation(file: string, line?: number): string {
  const base = file.split("/").pop() ?? file;
  const stem = base.replace(/\.(jsx|tsx|ts|js|mjs|cjs|css|scss)$/i, "");
  const where = file.toLowerCase();
  let loc = stem;
  if (where.includes("/components/")) loc = `${stem} 화면 부분`;
  else if (where.includes("/pages/") || where.includes("/routes/")) loc = `${stem} 페이지`;
  else if (where.endsWith("main.jsx") || where.endsWith("main.tsx") || where.endsWith("main.js")) loc = "앱 시작 파일";
  else if (where.endsWith("app.jsx") || where.endsWith("app.tsx")) loc = "앱 루트";
  else if (where.includes("/utils/") || where.includes("/lib/")) loc = `${stem} 도구`;
  else if (where.includes("/api/") || where.includes("/services/")) loc = `${stem} 서버 통신`;
  else if (where.endsWith(".css") || where.endsWith(".scss")) loc = `${stem} 스타일`;
  if (typeof line === "number" && line > 0) loc += ` ${line}번 줄`;
  return loc;
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
