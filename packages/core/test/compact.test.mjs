import { test } from "node:test";
import assert from "node:assert/strict";
import { compact } from "../dist/index.js";

function msg(role, content, tokens, pin = false) {
  return { role, content, tokens, pin };
}

test("compact: all messages fit under budget → no drops", async () => {
  const messages = [
    msg("system", "you are a reviewer", 10, true),
    msg("user", "here is the diff", 20),
    msg("assistant", "looks fine", 15),
  ];
  const out = await compact(messages, { targetTokens: 100 });
  assert.equal(out.droppedCount, 0);
  assert.equal(out.summarizedCount, 0);
  assert.equal(out.messages.length, 3);
});

test("compact: pinned messages are always kept", async () => {
  const messages = [
    msg("system", "pinned system", 80, true),
    msg("user", "ancient user msg", 50),
    msg("user", "recent user msg", 10),
  ];
  const out = await compact(messages, { targetTokens: 100 });
  assert.ok(out.messages.some((m) => m.content === "pinned system"));
});

test("compact: newest-first fits under budget, older dropped", async () => {
  const messages = [
    msg("user", "oldest", 40),
    msg("user", "middle", 40),
    msg("user", "newest", 40),
  ];
  const out = await compact(messages, { targetTokens: 80 });
  assert.equal(out.droppedCount, 1);
  const kept = out.messages.map((m) => m.content);
  assert.deepEqual(kept, ["middle", "newest"]);
});

test("compact: summarizer collapses dropped tail", async () => {
  const messages = [
    msg("user", "oldest", 40),
    msg("user", "middle", 40),
    msg("user", "newest", 40),
  ];
  // Budget 50 fits only the newest message (40) + small summary (~few tokens).
  // Both `oldest` and `middle` get dropped → summarized count = 2.
  const out = await compact(messages, {
    targetTokens: 50,
    summarize: async (dropped) => `summary of ${dropped.length}`,
  });
  assert.equal(out.summarizedCount, 2);
  assert.ok(out.messages[0].content.startsWith("[compacted summary of 2 earlier messages]"));
});

test("compact: returns only pinned when pinned already consume budget", async () => {
  const messages = [
    msg("system", "huge pinned prompt", 1_000, true),
    msg("user", "will not fit", 50),
  ];
  const out = await compact(messages, { targetTokens: 500 });
  assert.equal(out.messages.length, 1);
  assert.equal(out.droppedCount, 1);
});
