import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AUTONOMY_DEFAULT_MAX_CYCLES,
  AUTONOMY_HARD_CEILING_CYCLES,
  autonomyCallbackData,
  buttonsToInlineKeyboard,
  clampMaxCycles,
  decideAutonomyState,
  formatCycleMarker,
  parseCycleFromCommitMessage,
  renderAutonomyMessage,
} from "../dist/autonomy.js";

// --- pure helpers ---------------------------------------------------------

test("clampMaxCycles: hard ceiling at 5", () => {
  assert.equal(clampMaxCycles(999), AUTONOMY_HARD_CEILING_CYCLES);
  assert.equal(clampMaxCycles(5), 5);
  assert.equal(clampMaxCycles(3), 3);
  assert.equal(clampMaxCycles(1), 1);
  // Zero/negative coerce to 1 — cycle 0 doesn't make sense as a "max"
  assert.equal(clampMaxCycles(0), 1);
  assert.equal(clampMaxCycles(-2), 1);
  // Undefined → default
  assert.equal(clampMaxCycles(undefined), AUTONOMY_DEFAULT_MAX_CYCLES);
  // Non-integer floored
  assert.equal(clampMaxCycles(3.7), 3);
});

test("decideAutonomyState: approve → approved", () => {
  assert.equal(decideAutonomyState({ verdict: "approve", cycle: 0, maxCycles: 3 }), "approved");
  assert.equal(decideAutonomyState({ verdict: "approve", cycle: 3, maxCycles: 3 }), "approved");
});

test("decideAutonomyState: reject → rejected", () => {
  assert.equal(decideAutonomyState({ verdict: "reject", cycle: 0, maxCycles: 3 }), "rejected");
});

test("decideAutonomyState: rework+cycle<max → reworking", () => {
  assert.equal(decideAutonomyState({ verdict: "rework", cycle: 0, maxCycles: 3 }), "reworking");
  assert.equal(decideAutonomyState({ verdict: "rework", cycle: 2, maxCycles: 3 }), "reworking");
});

test("decideAutonomyState: rework+cycle>=max → max-cycles-reached", () => {
  assert.equal(decideAutonomyState({ verdict: "rework", cycle: 3, maxCycles: 3 }), "max-cycles-reached");
  assert.equal(decideAutonomyState({ verdict: "rework", cycle: 5, maxCycles: 3 }), "max-cycles-reached");
});

test("decideAutonomyState: respects hard ceiling", () => {
  // Even if user asks for 999, ceiling clamps to 5
  assert.equal(decideAutonomyState({ verdict: "rework", cycle: 4, maxCycles: 999 }), "reworking");
  assert.equal(decideAutonomyState({ verdict: "rework", cycle: 5, maxCycles: 999 }), "max-cycles-reached");
});

test("autonomyCallbackData shape", () => {
  assert.equal(autonomyCallbackData("ep-abc123", "merge"), "ep:ep-abc123:merge");
  assert.equal(autonomyCallbackData("ep-xyz", "merge-unsafe"), "ep:ep-xyz:merge-unsafe");
});

// --- renderAutonomyMessage ------------------------------------------------

const baseCtx = {
  state: "approved",
  cycle: 0,
  maxCycles: 3,
  prNumber: 42,
  prUrl: "https://github.com/acme/app/pull/42",
};

test("renderAutonomyMessage: approved (en) → 2 callback buttons, 'Merge & Push' + 'Close'", () => {
  const r = renderAutonomyMessage({ ...baseCtx, state: "approved" }, "en", "ep-1");
  assert.match(r.text, /Ready to merge/);
  assert.match(r.text, /#42/);
  assert.equal(r.buttons.length, 2);
  assert.equal(r.buttons[0].kind, "callback");
  assert.equal(r.buttons[0].callbackData, "ep:ep-1:merge");
  assert.equal(r.buttons[1].callbackData, "ep:ep-1:reject");
  assert.match(r.buttons[0].text, /Merge/);
});

test("renderAutonomyMessage: approved (ko) → 평어, 병합 준비 완료", () => {
  const r = renderAutonomyMessage({ ...baseCtx, state: "approved" }, "ko", "ep-1");
  assert.match(r.text, /병합 준비 완료/);
  assert.equal(r.buttons[0].callbackData, "ep:ep-1:merge");
  assert.match(r.buttons[0].text, /병합/);
});

test("renderAutonomyMessage: reworking → no buttons + cycle/max prose (1-based display)", () => {
  // v0.13.15 — internal cycle is 0-based (0 = first attempt, just
  // before autofix runs). Display is 1-based to match human counting:
  // ctx.cycle=2 (the 3rd attempt internally) → "3/3" on screen.
  const r = renderAutonomyMessage(
    { ...baseCtx, state: "reworking", cycle: 2, maxCycles: 3, blockerCountBefore: 4 },
    "en",
    "ep-1",
  );
  assert.match(r.text, /auto-fixing/i);
  assert.match(r.text, /3\/3/, "ctx.cycle=2 should render as '3/3' for the user (1-based)");
  assert.match(r.text, /4 issues/);
  assert.equal(r.buttons.length, 0);
});

test("renderAutonomyMessage: reworking (ko) — 자동 수정 중 (1-based display)", () => {
  const r = renderAutonomyMessage(
    { ...baseCtx, state: "reworking", cycle: 1, maxCycles: 3 },
    "ko",
    "ep-1",
  );
  assert.match(r.text, /자동 수정 중/);
  assert.match(r.text, /2\/3/, "ctx.cycle=1 should render as '2/3' (1-based)");
  assert.equal(r.buttons.length, 0);
});

test("renderAutonomyMessage: reworking — first attempt (cycle=0) renders as 1/3 not 0/3", () => {
  // Live RC: PR #32 first review-after-push showed "Cycle 0/3" which
  // Bae read as "the cycle counter is broken". The math is right
  // (first attempt is index 0); the display needs to be 1-based.
  const r = renderAutonomyMessage(
    { ...baseCtx, state: "reworking", cycle: 0, maxCycles: 3 },
    "en",
    "ep-1",
  );
  assert.match(r.text, /1\/3/, "first attempt (cycle=0) must render as '1/3'");
  assert.doesNotMatch(r.text, /0\/3/, "must NOT render as '0/3' — that's the pre-fix bug");
});

test("renderAutonomyMessage: max-cycles-reached → 3 buttons (unsafe + close + open PR)", () => {
  const r = renderAutonomyMessage(
    { ...baseCtx, state: "max-cycles-reached", cycle: 3, maxCycles: 3, blockerCountAfter: 2 },
    "en",
    "ep-1",
  );
  assert.match(r.text, /Auto-fix limit reached/i);
  assert.match(r.text, /2 issues/);
  assert.equal(r.buttons.length, 3);
  assert.equal(r.buttons[0].callbackData, "ep:ep-1:merge-unsafe");
  assert.equal(r.buttons[1].callbackData, "ep:ep-1:reject");
  assert.equal(r.buttons[2].kind, "url");
  assert.equal(r.buttons[2].url, baseCtx.prUrl);
});

test("renderAutonomyMessage: rejected → Close + Open PR only", () => {
  const r = renderAutonomyMessage({ ...baseCtx, state: "rejected" }, "en", "ep-1");
  assert.match(r.text, /discard/i);
  assert.equal(r.buttons.length, 2);
  assert.equal(r.buttons[0].callbackData, "ep:ep-1:reject");
  assert.equal(r.buttons[1].kind, "url");
});

test("renderAutonomyMessage: plain summary quoted when present", () => {
  const r = renderAutonomyMessage(
    {
      ...baseCtx,
      state: "approved",
      plainSummary: {
        whatChanged: "x",
        verdictInPlain: "This change is ready to ship.",
        nextAction: "y",
        raw: "full",
        locale: "en",
      },
    },
    "en",
    "ep-1",
  );
  assert.match(r.text, /This change is ready to ship\./);
});

test("renderAutonomyMessage: plain summary is HTML-escaped", () => {
  const r = renderAutonomyMessage(
    {
      ...baseCtx,
      state: "rejected",
      plainSummary: {
        whatChanged: "x",
        verdictInPlain: "<script>alert(1)</script>",
        nextAction: "y",
        raw: "full",
        locale: "en",
      },
    },
    "en",
    "ep-1",
  );
  assert.match(r.text, /&lt;script&gt;/);
  assert.doesNotMatch(r.text, /<script>/);
});

// --- buttonsToInlineKeyboard ---------------------------------------------

test("buttonsToInlineKeyboard: callback + url buttons serialize correctly", () => {
  const kb = buttonsToInlineKeyboard([
    { kind: "callback", text: "Merge", callbackData: "ep:1:merge" },
    { kind: "url", text: "PR", url: "https://example.com/pr/1" },
  ]);
  assert.equal(kb.inline_keyboard.length, 1);
  assert.equal(kb.inline_keyboard[0].length, 2);
  assert.deepEqual(kb.inline_keyboard[0][0], { text: "Merge", callback_data: "ep:1:merge" });
  assert.deepEqual(kb.inline_keyboard[0][1], { text: "PR", url: "https://example.com/pr/1" });
});

test("buttonsToInlineKeyboard: empty input → empty keyboard (no row)", () => {
  const kb = buttonsToInlineKeyboard([]);
  assert.equal(kb.inline_keyboard.length, 0);
});

// --- commit marker round-trip --------------------------------------------

test("formatCycleMarker + parseCycleFromCommitMessage round-trip", () => {
  for (const n of [0, 1, 2, 3, 5]) {
    const marker = formatCycleMarker(n);
    assert.equal(marker, `[conclave-rework-cycle:${n}]`);
    const msg = `fix: handle null input\n\n${marker}`;
    assert.equal(parseCycleFromCommitMessage(msg), n);
  }
});

test("parseCycleFromCommitMessage: absent marker → 0", () => {
  assert.equal(parseCycleFromCommitMessage("fix: something"), 0);
  assert.equal(parseCycleFromCommitMessage(""), 0);
  assert.equal(parseCycleFromCommitMessage(null), 0);
  assert.equal(parseCycleFromCommitMessage(undefined), 0);
});

test("parseCycleFromCommitMessage: hard-ceiling clamp even from commit", () => {
  // A malicious or mis-configured commit message claiming cycle 999
  // must still be clamped to the ceiling so the Worker can't be
  // tricked into "oh, we're at 999 — halt" or "oh, cycle = -1 — loop
  // forever". Defence in depth alongside the CI's own clamp.
  assert.equal(parseCycleFromCommitMessage("[conclave-rework-cycle:999]"), AUTONOMY_HARD_CEILING_CYCLES);
});

test("parseCycleFromCommitMessage: picks first marker (stable ordering)", () => {
  const msg = "fix\n\n[conclave-rework-cycle:2]\n\n[conclave-rework-cycle:3]";
  assert.equal(parseCycleFromCommitMessage(msg), 2);
});

test("parseCycleFromCommitMessage: case-insensitive match", () => {
  assert.equal(parseCycleFromCommitMessage("[CONCLAVE-REWORK-CYCLE:2]"), 2);
});
