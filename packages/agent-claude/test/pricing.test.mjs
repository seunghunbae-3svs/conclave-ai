import { test } from "node:test";
import assert from "node:assert/strict";
import { actualCost, estimateCallCost, PRICING } from "../dist/index.js";

test("PRICING table has all three Claude tiers", () => {
  assert.ok(PRICING["claude-sonnet-4-6"]);
  assert.ok(PRICING["claude-haiku-4-5"]);
  assert.ok(PRICING["claude-opus-4-7"]);
});

test("actualCost: Sonnet baseline — 1000 in, 500 out, no cache", () => {
  const cost = actualCost("claude-sonnet-4-6", { inputTokens: 1_000, outputTokens: 500 });
  // 1000 * 3 + 500 * 15 = 3000 + 7500 = 10_500 / 1_000_000 = 0.0105
  assert.equal(cost.toFixed(4), "0.0105");
});

test("actualCost: cache read discount applied", () => {
  const noCache = actualCost("claude-sonnet-4-6", { inputTokens: 10_000, outputTokens: 200 });
  const cached = actualCost("claude-sonnet-4-6", {
    inputTokens: 10_000,
    outputTokens: 200,
    cacheReadTokens: 9_000,
  });
  // 9k cache read at 0.3/MTok instead of 3.0/MTok = 0.0027 vs 0.027 → $0.0243 savings
  assert.ok(cached < noCache, "cached call must cost less");
  assert.equal((noCache - cached).toFixed(4), "0.0243");
});

test("actualCost: cache write premium applied", () => {
  const noCache = actualCost("claude-sonnet-4-6", { inputTokens: 5_000, outputTokens: 100 });
  const cacheWrite = actualCost("claude-sonnet-4-6", {
    inputTokens: 5_000,
    outputTokens: 100,
    cacheCreationTokens: 5_000,
  });
  // cache write is 1.25× input cost
  assert.ok(cacheWrite > noCache);
});

test("actualCost: Haiku is ~12× cheaper than Sonnet per input token", () => {
  const sonnet = actualCost("claude-sonnet-4-6", { inputTokens: 100_000, outputTokens: 0 });
  const haiku = actualCost("claude-haiku-4-5", { inputTokens: 100_000, outputTokens: 0 });
  const ratio = sonnet / haiku;
  assert.ok(ratio >= 11 && ratio <= 13, `expected ratio ~12, got ${ratio}`);
});

test("actualCost: throws on unknown model", () => {
  assert.throws(() => actualCost("claude-does-not-exist", { inputTokens: 1, outputTokens: 1 }));
});

test("estimateCallCost: pessimistic pre-flight matches reserve-before-call flow", () => {
  const est = estimateCallCost("claude-sonnet-4-6", 5_000, 1_000);
  // 5k * 3/M + 1k * 15/M = 15e-3 + 15e-3 = 0.03
  assert.equal(est.toFixed(3), "0.030");
});
