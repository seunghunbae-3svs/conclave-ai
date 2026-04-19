import { test } from "node:test";
import assert from "node:assert/strict";
import { actualCost, estimateCallCost, PRICING } from "../dist/index.js";

test("PRICING: table covers the four supported Grok tiers", () => {
  assert.ok(PRICING["grok-4"]);
  assert.ok(PRICING["grok-3"]);
  assert.ok(PRICING["grok-3-mini"]);
  assert.ok(PRICING["grok-code-fast-1"]);
});

test("actualCost: grok-code-fast-1 baseline", () => {
  // 1000 * 0.20 + 500 * 1.50 = 200 + 750 = 950 / 1M = 0.00095
  const cost = actualCost("grok-code-fast-1", { inputTokens: 1_000, outputTokens: 500 });
  assert.equal(cost.toFixed(5), "0.00095");
});

test("actualCost: grok-4 flagship 5× more expensive than grok-3-mini", () => {
  const grok4 = actualCost("grok-4", { inputTokens: 10_000, outputTokens: 1_000 });
  const grokMini = actualCost("grok-3-mini", { inputTokens: 10_000, outputTokens: 1_000 });
  assert.ok(grok4 > grokMini * 5);
});

test("actualCost: cached input applies 75% discount on grok-4", () => {
  const noCache = actualCost("grok-4", { inputTokens: 10_000, outputTokens: 0 });
  const cached = actualCost("grok-4", {
    inputTokens: 10_000,
    outputTokens: 0,
    cachedInputTokens: 10_000,
  });
  assert.ok(cached < noCache);
  const ratio = cached / noCache;
  assert.ok(ratio > 0.24 && ratio < 0.26, `expected cache ratio ~0.25, got ${ratio.toFixed(3)}`);
});

test("actualCost: throws on unknown model", () => {
  assert.throws(() => actualCost("grok-99", { inputTokens: 1, outputTokens: 1 }));
});

test("estimateCallCost: grok-code-fast-1 deterministic", () => {
  // 5_000 * 0.20/M + 1_000 * 1.50/M = 0.001 + 0.0015 = 0.0025
  const est = estimateCallCost("grok-code-fast-1", 5_000, 1_000);
  assert.equal(est.toFixed(4), "0.0025");
});

test("estimateCallCost: throws on unknown model", () => {
  assert.throws(() => estimateCallCost("grok-99", 1, 1));
});
