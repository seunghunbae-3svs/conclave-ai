import { test } from "node:test";
import assert from "node:assert/strict";
import { actualCost, estimateCallCost, PRICING } from "../dist/index.js";

test("PRICING table has long-context + flash + next-gen tiers", () => {
  assert.ok(PRICING["gemini-2.5-pro"]);
  assert.ok(PRICING["gemini-2.5-flash"]);
  assert.ok(PRICING["gemini-3.0-flash"]);
});

test("actualCost: gemini-2.5-pro baseline", () => {
  // 1000 * 1.25 / M + 500 * 10 / M = 0.00125 + 0.005 = 0.00625
  const cost = actualCost("gemini-2.5-pro", { inputTokens: 1_000, outputTokens: 500 });
  assert.equal(cost.toFixed(5), "0.00625");
});

test("actualCost: cached input discount is 75% for gemini-2.5", () => {
  // 2.5-pro: 1.25 normal, 0.3125 cached → 75% off on the cached portion.
  const cost = actualCost("gemini-2.5-pro", {
    inputTokens: 10_000,
    outputTokens: 0,
    cachedInputTokens: 10_000,
  });
  const noCache = actualCost("gemini-2.5-pro", { inputTokens: 10_000, outputTokens: 0 });
  assert.equal((cost / noCache).toFixed(2), "0.25");
});

test("actualCost: flash is ~8× cheaper than pro on input", () => {
  const pro = actualCost("gemini-2.5-pro", { inputTokens: 100_000, outputTokens: 0 });
  const flash = actualCost("gemini-2.5-flash", { inputTokens: 100_000, outputTokens: 0 });
  const ratio = pro / flash;
  assert.ok(ratio >= 7 && ratio <= 9, `expected ~8, got ${ratio}`);
});

test("actualCost: throws on unknown model", () => {
  assert.throws(() => actualCost("gemini-nope", { inputTokens: 1, outputTokens: 1 }));
});

test("estimateCallCost: pessimistic pre-flight matches reserve-before-call", () => {
  // 2.5-pro: 5000 * 1.25 / M + 1000 * 10 / M = 0.00625 + 0.01 = 0.01625
  const est = estimateCallCost("gemini-2.5-pro", 5_000, 1_000);
  assert.equal(est.toFixed(5), "0.01625");
});

test("PRICING: maxContextTokens populated for long-context routing", () => {
  assert.equal(PRICING["gemini-2.5-pro"].maxContextTokens, 1_048_576);
  assert.equal(PRICING["gemini-3.0-flash"].maxContextTokens, 2_097_152);
});
