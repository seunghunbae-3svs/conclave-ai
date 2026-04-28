import { test } from "node:test";
import assert from "node:assert/strict";
import { autoPushOutcome } from "../dist/lib/federated-auto-push.js";

class FakeTransport {
  constructor() {
    this.id = "fake";
    this.pushedBatches = [];
    this.pulledSinceCalls = [];
    this.failNext = false;
  }
  async push(batch) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("boom");
    }
    this.pushedBatches.push(batch);
    return { accepted: batch.length };
  }
  async pull(since) {
    this.pulledSinceCalls.push(since);
    return [];
  }
}

const sampleAnswerKey = {
  id: "ak-1",
  createdAt: new Date().toISOString(),
  domain: "code",
  pattern: "by-repo/acme/app",
  lesson: "merged",
  tags: ["debug-noise"],
  removedBlockers: [],
};
const sampleFailure = {
  id: "fc-1",
  createdAt: new Date().toISOString(),
  domain: "code",
  category: "regression",
  severity: "major",
  title: "x",
  body: "x",
  tags: ["regression"],
};

test("autoPushOutcome: federation disabled → no attempt, no error noise", async () => {
  const out = await autoPushOutcome({
    config: { federated: { enabled: false } },
    written: { answerKeys: [sampleAnswerKey], failures: [sampleFailure] },
  });
  assert.equal(out.attempted, false);
  assert.equal(out.pushed, 0);
  assert.match(out.skipReason, /federation disabled/);
});

test("autoPushOutcome: federation block absent (legacy config) → no attempt", async () => {
  const out = await autoPushOutcome({
    config: {},
    written: { answerKeys: [sampleAnswerKey], failures: [] },
  });
  assert.equal(out.attempted, false);
  assert.match(out.skipReason, /federation disabled/);
});

test("autoPushOutcome: enabled but autoPush=false → skip with reason", async () => {
  const out = await autoPushOutcome({
    config: {
      federated: { enabled: true, endpoint: "https://example.com/sync", autoPush: false },
    },
    written: { answerKeys: [sampleAnswerKey], failures: [] },
  });
  assert.equal(out.attempted, false);
  assert.match(out.skipReason, /autoPush is false/);
});

test("autoPushOutcome: enabled + autoPush but no endpoint → skip", async () => {
  const out = await autoPushOutcome({
    config: { federated: { enabled: true, autoPush: true } },
    written: { answerKeys: [sampleAnswerKey], failures: [] },
  });
  assert.equal(out.attempted, false);
  assert.match(out.skipReason, /endpoint not configured/);
});

test("autoPushOutcome: enabled + autoPush + endpoint + 0 deltas → skip", async () => {
  const transport = new FakeTransport();
  const out = await autoPushOutcome({
    config: {
      federated: { enabled: true, endpoint: "https://example.com/sync", autoPush: true },
    },
    written: { answerKeys: [], failures: [] },
    transport,
  });
  assert.equal(out.attempted, false);
  assert.match(out.skipReason, /no entries written/);
  assert.equal(transport.pushedBatches.length, 0);
});

test("autoPushOutcome: full path → pushes deltas, returns acked count", async () => {
  const transport = new FakeTransport();
  const out = await autoPushOutcome({
    config: {
      federated: { enabled: true, endpoint: "https://example.com/sync", autoPush: true },
    },
    written: { answerKeys: [sampleAnswerKey], failures: [sampleFailure] },
    transport,
  });
  assert.equal(out.attempted, true);
  assert.equal(out.pushed, 2); // 1 ak + 1 failure → 2 baselines
  assert.equal(transport.pushedBatches.length, 1);
  // pullDisabled — no pull call should fire on auto-push.
  assert.equal(transport.pulledSinceCalls.length, 0);
});

test("autoPushOutcome: transport.push throws → returns error string, no propagation", async () => {
  const transport = new FakeTransport();
  transport.failNext = true;
  const out = await autoPushOutcome({
    config: {
      federated: { enabled: true, endpoint: "https://example.com/sync", autoPush: true },
    },
    written: { answerKeys: [sampleAnswerKey], failures: [] },
    transport,
  });
  assert.equal(out.attempted, true);
  assert.equal(out.pushed, 0);
  assert.match(out.error, /boom/);
});

test("autoPushOutcome: only failures (no answer-keys) → still pushes", async () => {
  const transport = new FakeTransport();
  const out = await autoPushOutcome({
    config: {
      federated: { enabled: true, endpoint: "https://example.com/sync", autoPush: true },
    },
    written: { answerKeys: [], failures: [sampleFailure] },
    transport,
  });
  assert.equal(out.attempted, true);
  assert.equal(out.pushed, 1);
});
