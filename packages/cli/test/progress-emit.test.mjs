import { test } from "node:test";
import assert from "node:assert/strict";
import { emitProgress } from "../dist/lib/progress-emit.js";

/**
 * v0.11 — emitProgress unit tests.
 *
 * The helper has two contracts: (1) skip notifiers without notifyProgress
 * (forward-compat — Discord/Slack/Email pre-v0.11), and (2) NEVER throw,
 * even when a notifier's notifyProgress fails — failures are logged and
 * swallowed so a 429 / network blip can't break a review.
 */

function makeNotifier(id, opts = {}) {
  const calls = [];
  const n = {
    id,
    displayName: id,
    async notifyReview() {},
  };
  if (!opts.skipProgress) {
    n.notifyProgress = async (input) => {
      calls.push(input);
      if (opts.throwOnProgress) throw new Error("simulated network blip");
    };
  }
  n.calls = calls;
  return n;
}

test("emitProgress: empty notifier list is a no-op", async () => {
  await emitProgress([], { episodicId: "ep", stage: "review-started" });
  // No throw, no side effects to assert beyond the absence of one.
});

test("emitProgress: forwards to every notifier that implements notifyProgress", async () => {
  const a = makeNotifier("a");
  const b = makeNotifier("b");
  await emitProgress([a, b], { episodicId: "ep-1", stage: "tier1-done", payload: { blockerCount: 2 } });
  assert.equal(a.calls.length, 1);
  assert.equal(b.calls.length, 1);
  assert.equal(a.calls[0].stage, "tier1-done");
});

test("emitProgress: skips notifiers without notifyProgress (pre-v0.11 surfaces)", async () => {
  const ok = makeNotifier("tg");
  const legacy = makeNotifier("email", { skipProgress: true });
  await emitProgress([ok, legacy], { episodicId: "ep", stage: "review-started" });
  assert.equal(ok.calls.length, 1);
  // Legacy notifier has no notifyProgress method — calls array stays empty.
  assert.equal(legacy.calls.length, 0);
  assert.equal(legacy.notifyProgress, undefined);
});

test("emitProgress: a throwing notifier does NOT crash the review", async () => {
  const ok = makeNotifier("tg");
  const broken = makeNotifier("discord", { throwOnProgress: true });
  let stderr = "";
  const origWrite = process.stderr.write;
  process.stderr.write = (s) => {
    stderr += s;
    return true;
  };
  try {
    await emitProgress([ok, broken], { episodicId: "ep-x", stage: "tier1-done" });
  } finally {
    process.stderr.write = origWrite;
  }
  assert.equal(ok.calls.length, 1);
  assert.match(stderr, /discord notifyProgress failed/);
  assert.match(stderr, /simulated network blip/);
});

test("emitProgress: emits to all notifiers in parallel (Promise.all semantics)", async () => {
  const order = [];
  const make = (id, delay) => ({
    id,
    displayName: id,
    async notifyReview() {},
    async notifyProgress() {
      await new Promise((r) => setTimeout(r, delay));
      order.push(id);
    },
  });
  await emitProgress(
    [make("a", 30), make("b", 10), make("c", 20)],
    { episodicId: "ep", stage: "review-started" },
  );
  // If serial, completion order would be a→b→c (~60ms total). Parallel
  // completion order is by delay: b→c→a (~30ms total).
  assert.deepEqual(order, ["b", "c", "a"]);
});
