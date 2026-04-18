import { test } from "node:test";
import assert from "node:assert/strict";
import { selectModel, estimateTokens, DEFAULT_MODELS } from "../dist/index.js";

test("selectModel: small input → haiku", () => {
  const choice = selectModel(5_000);
  assert.equal(choice.class, "haiku");
  assert.equal(choice.model, DEFAULT_MODELS.haiku);
});

test("selectModel: medium input → sonnet", () => {
  const choice = selectModel(20_000);
  assert.equal(choice.class, "sonnet");
  assert.equal(choice.model, DEFAULT_MODELS.sonnet);
});

test("selectModel: large input → long-context (gemini)", () => {
  const choice = selectModel(100_000);
  assert.equal(choice.class, "long-context");
  assert.equal(choice.model, DEFAULT_MODELS["long-context"]);
});

test("selectModel: boundary at haikuMax is inclusive of haiku", () => {
  const choice = selectModel(8_000);
  assert.equal(choice.class, "haiku");
});

test("selectModel: custom thresholds honored", () => {
  const choice = selectModel(2_000, { haikuMax: 1_000, sonnetMax: 5_000 });
  assert.equal(choice.class, "sonnet");
});

test("selectModel: model override via opts.models", () => {
  const choice = selectModel(5_000, { models: { haiku: "custom-haiku" } });
  assert.equal(choice.model, "custom-haiku");
});

test("estimateTokens: ~4 chars per token heuristic", () => {
  assert.equal(estimateTokens("a".repeat(40)), 10);
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abc"), 1);
});
