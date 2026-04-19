import { test } from "node:test";
import assert from "node:assert/strict";
import { actualCost, estimateCallCost, PRICING } from "../dist/index.js";

test("PRICING: default llama3.3 entry has zero rates", () => {
  const p = PRICING["llama3.3"];
  assert.ok(p);
  assert.equal(p.inputPerMTok, 0);
  assert.equal(p.outputPerMTok, 0);
});

test("actualCost: always 0 regardless of usage", () => {
  assert.equal(actualCost("llama3.3", { inputTokens: 1_000_000, outputTokens: 500_000 }), 0);
  assert.equal(actualCost("anything", { inputTokens: 0, outputTokens: 0 }), 0);
});

test("actualCost: zero even with cached tokens (free is free)", () => {
  assert.equal(
    actualCost("llama3.3", { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 500_000 }),
    0,
  );
});

test("estimateCallCost: always 0", () => {
  assert.equal(estimateCallCost("llama3.3", 100_000, 50_000), 0);
  assert.equal(estimateCallCost("anything", 0, 0), 0);
});
