import { test } from "node:test";
import assert from "node:assert/strict";
import { Council } from "../dist/index.js";

function fakeAgent(id, verdict) {
  return {
    id,
    displayName: id,
    review: async () => ({
      agent: id,
      verdict,
      blockers: [],
      summary: `${id} says ${verdict}`,
    }),
  };
}

const ctx = { diff: "", repo: "acme/x", pullNumber: 1, newSha: "HEAD" };

test("Council: empty agents throws", () => {
  assert.throws(() => new Council({ agents: [] }));
});

test("Council: single approve → approve + consensus", async () => {
  const council = new Council({ agents: [fakeAgent("claude", "approve")] });
  const outcome = await council.deliberate(ctx);
  assert.equal(outcome.verdict, "approve");
  assert.equal(outcome.consensusReached, true);
  assert.equal(outcome.results.length, 1);
});

test("Council: all approve → approve", async () => {
  const council = new Council({
    agents: [fakeAgent("claude", "approve"), fakeAgent("openai", "approve")],
  });
  const outcome = await council.deliberate(ctx);
  assert.equal(outcome.verdict, "approve");
  assert.equal(outcome.consensusReached, true);
});

test("Council: any reject → reject (consensus)", async () => {
  const council = new Council({
    agents: [fakeAgent("claude", "approve"), fakeAgent("openai", "reject")],
  });
  const outcome = await council.deliberate(ctx);
  assert.equal(outcome.verdict, "reject");
  assert.equal(outcome.consensusReached, true);
});

test("Council: mixed approve + rework → rework (no consensus)", async () => {
  const council = new Council({
    agents: [fakeAgent("claude", "approve"), fakeAgent("openai", "rework")],
  });
  const outcome = await council.deliberate(ctx);
  assert.equal(outcome.verdict, "rework");
  assert.equal(outcome.consensusReached, false);
});

test("Council: exposes config", async () => {
  const council = new Council({
    agents: [fakeAgent("a", "approve"), fakeAgent("b", "approve")],
    maxRounds: 5,
  });
  assert.equal(council.agentCount, 2);
  assert.equal(council.roundLimit, 5);
});
