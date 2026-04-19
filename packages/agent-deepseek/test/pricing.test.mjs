import { test } from "node:test";
import assert from "node:assert/strict";
import { actualCost, estimateCallCost, PRICING } from "../dist/index.js";

test("PRICING: table has both review models", () => {
  assert.ok(PRICING["deepseek-chat"]);
  assert.ok(PRICING["deepseek-reasoner"]);
});

test("actualCost: deepseek-chat baseline no cache", () => {
  // 1000 * 0.27 + 500 * 1.10 = 270 + 550 = 820 / 1M = 0.00082
  const cost = actualCost("deepseek-chat", { inputTokens: 1_000, outputTokens: 500 });
  assert.equal(cost.toFixed(4), "0.0008");
});

test("actualCost: cached input gets Deepseek's deep discount", () => {
  const noCache = actualCost("deepseek-chat", { inputTokens: 10_000, outputTokens: 0 });
  const cached = actualCost("deepseek-chat", {
    inputTokens: 10_000,
    outputTokens: 0,
    cachedInputTokens: 10_000,
  });
  assert.ok(cached < noCache);
  // deepseek-chat cache hit is 0.07 vs 0.27 standard — ~26% of normal
  const ratio = cached / noCache;
  assert.ok(ratio > 0.25 && ratio < 0.27, `expected cache ratio ~0.26, got ${ratio.toFixed(3)}`);
});

test("actualCost: reasoner cache ratio also ~0.25", () => {
  // deepseek-reasoner: 0.14 / 0.55 ≈ 0.2545
  const noCache = actualCost("deepseek-reasoner", { inputTokens: 1_000_000, outputTokens: 0 });
  const cached = actualCost("deepseek-reasoner", {
    inputTokens: 1_000_000,
    outputTokens: 0,
    cachedInputTokens: 1_000_000,
  });
  const ratio = cached / noCache;
  assert.ok(ratio > 0.25 && ratio < 0.26, `expected cache ratio ~0.25, got ${ratio.toFixed(3)}`);
});

test("actualCost: mixed cached + base input adds up correctly", () => {
  // 50% of 1M tokens cached on deepseek-chat:
  //   cached half: 500_000 * 0.07 / 1M = 0.035
  //   base half:   500_000 * 0.27 / 1M = 0.135
  //   total input: 0.17, no output
  const cost = actualCost("deepseek-chat", {
    inputTokens: 1_000_000,
    outputTokens: 0,
    cachedInputTokens: 500_000,
  });
  assert.equal(cost.toFixed(4), "0.1700");
});

test("actualCost: throws on unknown model", () => {
  assert.throws(() => actualCost("gpt-nope", { inputTokens: 1, outputTokens: 1 }));
});

test("estimateCallCost: deterministic pre-flight on deepseek-chat", () => {
  // deepseek-chat: 5_000 * 0.27/M + 1_000 * 1.10/M = 0.00135 + 0.00110 = 0.00245
  const est = estimateCallCost("deepseek-chat", 5_000, 1_000);
  assert.equal(est.toFixed(5), "0.00245");
});

test("estimateCallCost: throws on unknown model", () => {
  assert.throws(() => estimateCallCost("gpt-nope", 1, 1));
});
