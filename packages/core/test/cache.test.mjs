import { test } from "node:test";
import assert from "node:assert/strict";
import { PromptCache, ANTHROPIC_PROMPT_CACHE_TTL_MS } from "../dist/index.js";

test("PromptCache: mark then isLive reports hit", () => {
  const c = new PromptCache();
  assert.equal(c.isLive("prefix-A", "claude-sonnet-4-6"), false);
  c.mark("prefix-A", "claude-sonnet-4-6");
  assert.equal(c.isLive("prefix-A", "claude-sonnet-4-6"), true);
});

test("PromptCache: keys are model-scoped", () => {
  const c = new PromptCache();
  c.mark("same-prefix", "claude-sonnet-4-6");
  assert.equal(c.isLive("same-prefix", "claude-haiku-4-5"), false);
});

test("PromptCache: expires after TTL", () => {
  const c = new PromptCache({ ttlMs: 100 });
  c.mark("p", "m", 1_000);
  assert.equal(c.isLive("p", "m", 1_050), true);
  assert.equal(c.isLive("p", "m", 1_101), false);
});

test("PromptCache: hitRate reflects hits + misses", () => {
  const c = new PromptCache();
  c.isLive("x", "m"); // miss
  c.mark("x", "m");
  c.isLive("x", "m"); // hit
  c.isLive("y", "m"); // miss
  assert.equal(c.hitRate().toFixed(3), "0.333");
});

test("PromptCache: maxEntries evicts oldest", () => {
  const c = new PromptCache({ maxEntries: 2 });
  c.mark("a", "m", 1);
  c.mark("b", "m", 2);
  c.mark("c", "m", 3); // evicts "a"
  assert.equal(c.isLive("a", "m", 4), false);
  assert.equal(c.isLive("b", "m", 4), true);
  assert.equal(c.isLive("c", "m", 4), true);
});

test("PromptCache: default TTL matches Anthropic 5-minute window", () => {
  assert.equal(ANTHROPIC_PROMPT_CACHE_TTL_MS, 300_000);
});
