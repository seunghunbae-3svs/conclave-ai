/**
 * UX-4 — terminal user-facing report synthesizer.
 *
 * The report is what Bae sees in Telegram at the END of the autonomy
 * loop: "Conclave가 N번의 사이클을 돌려 X건 발견, Y건 자동 수정,
 * Z건 사람 검토 필요. 배포: ✅/❌. 승인 권장 / 보류 권장." plus
 * action buttons. This file tests the pure synthesizer that builds
 * the payload + the gating helper that decides whether the loop has
 * actually terminated.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTerminalReport,
  describeBlockerForUser,
  isAutonomyTerminal,
  pickRecommendation,
} from "../dist/lib/terminal-report.js";

const blocker = (overrides = {}) => ({
  severity: "blocker",
  category: "type-error",
  message: "Bad type",
  file: "src/x.ts",
  ...overrides,
});

test("UX-4 describeBlockerForUser: maps known categories to Korean phrases", () => {
  assert.match(
    describeBlockerForUser(blocker({ category: "contrast", message: "low contrast" })),
    /글자 가독성/,
  );
  assert.match(
    describeBlockerForUser(blocker({ category: "logging", message: "stray console.log" })),
    /디버그 로그 제거/,
  );
  assert.match(
    describeBlockerForUser(blocker({ category: "runtime-safety", message: "unconditional init" })),
    /앱 시작 안전성/,
  );
  assert.match(
    describeBlockerForUser(blocker({ category: "style-drift" })),
    /디자인 시스템 일관성/,
  );
});

test("UX-4 describeBlockerForUser: prefix categories (design-*/ui-*/visual-*) map", () => {
  assert.match(describeBlockerForUser(blocker({ category: "ui-button" })), /UI 일관성/);
  assert.match(describeBlockerForUser(blocker({ category: "visual-regression" })), /비주얼 회귀/);
});

test("UX-4 describeBlockerForUser: unknown category falls back to surface message", () => {
  const out = describeBlockerForUser(blocker({ category: "esoteric-cat", message: "weird thing" }));
  assert.match(out, /esoteric-cat/);
  assert.match(out, /weird thing/);
});

test("UX-4 pickRecommendation: clean approved + deploy success → approve", () => {
  const r = pickRecommendation({ status: "awaiting-approval", deployOutcome: "success", outstandingCount: 0 });
  assert.equal(r, "approve");
});

test("UX-4 pickRecommendation: bailed-build-failed → hold", () => {
  const r = pickRecommendation({ status: "bailed-build-failed", deployOutcome: "failure", outstandingCount: 5 });
  assert.equal(r, "hold");
});

test("UX-4 pickRecommendation: deferred-to-next-review → hold (waiting for next cycle)", () => {
  const r = pickRecommendation({ status: "deferred-to-next-review", deployOutcome: "pending", outstandingCount: 2 });
  assert.equal(r, "hold");
});

test("UX-4 isAutonomyTerminal: approved → true (always terminal)", () => {
  assert.equal(isAutonomyTerminal({ status: "approved", pushedThisRun: true, reworkCycle: 0, maxCycles: 3 }), true);
});

test("UX-4 isAutonomyTerminal: deferred-to-next-review → false (next cycle expected)", () => {
  assert.equal(isAutonomyTerminal({ status: "deferred-to-next-review", pushedThisRun: true, reworkCycle: 0, maxCycles: 3 }), false);
});

test("UX-4 isAutonomyTerminal: bail at cycle 0 with no push → false (AF-2 next-cycle dispatch will fire)", () => {
  // AF-2 follow-on changed semantics — even with no push, the rework
  // workflow fires the next cycle dispatch directly, so bail-with-no-push
  // is NO LONGER terminal until cycle == max.
  assert.equal(isAutonomyTerminal({ status: "bailed-build-failed", pushedThisRun: false, reworkCycle: 0, maxCycles: 3 }), false);
});

test("UX-4 isAutonomyTerminal: bail with push mid-cycle → false (next cycle will fire on the push)", () => {
  assert.equal(isAutonomyTerminal({ status: "bailed-no-patches", pushedThisRun: true, reworkCycle: 0, maxCycles: 3 }), false);
});

test("UX-4 isAutonomyTerminal: bail at cycle == max-1 → true (last possible cycle)", () => {
  assert.equal(isAutonomyTerminal({ status: "bailed-build-failed", pushedThisRun: true, reworkCycle: 2, maxCycles: 3 }), true);
});

test("UX-4 buildTerminalReport: synthesizes payload from iterations + remaining", () => {
  const fixedIter = {
    index: 0,
    fixes: [
      { agent: "claude", blocker: blocker({ category: "logging", message: "Stray console.log", file: "src/util.ts" }), status: "ready" },
      { agent: "design", blocker: blocker({ category: "contrast", message: "Low contrast button", file: "src/Button.jsx" }), status: "ready" },
      { agent: "openai", blocker: blocker({ category: "type-error", message: "Bad TS type", file: "src/types.ts" }), status: "conflict" },
    ],
    appliedCount: 2,
    verified: true,
    costUsd: 0.5,
    notes: [],
  };
  const remaining = [
    blocker({ category: "runtime-safety", file: "src/main.jsx", message: "Init may throw" }),
    blocker({ category: "process", file: "src/y.ts", message: "tripwire flagged" }),
  ];
  const report = buildTerminalReport({
    status: "awaiting-approval",
    iterations: [fixedIter],
    remainingBlockers: remaining,
    totalCostUsd: 0.5,
    cyclesRun: 1,
    deployOutcome: "success",
  });
  assert.equal(report.bailStatus, "awaiting-approval");
  assert.equal(report.cyclesRun, 1);
  // UX-12 — 2 ready fixes (deduped by file+message), 2 remaining (deduped),
  // total = 4 distinct issues. The conflict fix doesn't count as autofixed.
  assert.equal(report.totalBlockersFound, 4);
  assert.equal(report.blockersAutofixed, 2);
  assert.equal(report.blockersOutstanding, 2);
  assert.equal(report.deployOutcome, "success");
  // Fixed items use Korean.
  assert.ok(report.fixedItems.some((s) => /디버그 로그/.test(s)));
  assert.ok(report.fixedItems.some((s) => /글자 가독성/.test(s)));
  // Outstanding items use Korean.
  assert.ok(report.outstandingItems.some((s) => /앱 시작 안전성/.test(s)));
  // Recommendation: bail-free + outstanding > 0 + deploy=success → still hold
  // (per pickRecommendation rules — outstanding > 0 prevents approve).
  assert.equal(report.recommendation, "hold");
});

test("UX-4 buildTerminalReport: zero outstanding + deploy success + approved → recommend approve", () => {
  const fixedIter = {
    index: 0,
    fixes: [
      { agent: "claude", blocker: blocker({ category: "logging" }), status: "ready" },
    ],
    appliedCount: 1,
    verified: true,
    costUsd: 0.05,
    notes: [],
  };
  const report = buildTerminalReport({
    status: "awaiting-approval",
    iterations: [fixedIter],
    remainingBlockers: [],
    totalCostUsd: 0.05,
    cyclesRun: 2,
    deployOutcome: "success",
  });
  assert.equal(report.recommendation, "approve");
  assert.equal(report.blockersOutstanding, 0);
  assert.equal(report.totalBlockersFound, 1);
});

test("UX-4 buildTerminalReport: unverified iteration's fixes don't count as autofixed", () => {
  // bailed-build-failed iteration: 3 ready fixes were applied but build
  // failed → revert. None should count as "autofixed".
  const failedIter = {
    index: 0,
    fixes: [
      { agent: "claude", blocker: blocker({ category: "logging", message: "msg-a", file: "a.ts" }), status: "ready" },
      { agent: "design", blocker: blocker({ category: "contrast", message: "msg-b", file: "b.ts" }), status: "ready" },
      { agent: "openai", blocker: blocker({ category: "type-error", message: "msg-c", file: "c.ts" }), status: "ready" },
    ],
    appliedCount: 3,
    verified: false, // revert happened
    costUsd: 0.2,
    notes: ["failure: build broke"],
    buildOk: false,
  };
  const remaining = [
    blocker({ category: "logging", message: "msg-a", file: "a.ts" }),
    blocker({ category: "contrast", message: "msg-b", file: "b.ts" }),
    blocker({ category: "type-error", message: "msg-c", file: "c.ts" }),
  ];
  const report = buildTerminalReport({
    status: "bailed-build-failed",
    iterations: [failedIter],
    remainingBlockers: remaining,
    totalCostUsd: 0.2,
    cyclesRun: 1,
    deployOutcome: "failure",
  });
  assert.equal(report.blockersAutofixed, 0, "unverified iteration's fixes do NOT count");
  assert.equal(report.blockersOutstanding, 3);
  assert.equal(report.recommendation, "hold");
  assert.equal(report.fixedItems.length, 0);
});
