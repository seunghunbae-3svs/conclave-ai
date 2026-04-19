import { test } from "node:test";
import assert from "node:assert/strict";
import { runFederatedSync } from "../dist/index.js";

const KEY = {
  id: "ak-1",
  createdAt: "2026-04-19T10:00:00.000Z",
  domain: "code",
  pattern: "by-pattern/auth",
  lesson: "check JWT",
  tags: ["auth"],
};

const FAILURE = {
  id: "fc-1",
  createdAt: "2026-04-19T11:00:00.000Z",
  domain: "code",
  category: "type-error",
  severity: "major",
  title: "bad cast",
  body: "type assertion without runtime validation",
  tags: ["types"],
};

class RecordingTransport {
  id = "record";
  pushCalls = [];
  pullCalls = [];
  pulled = [];
  acceptedOverride = null;
  async push(baselines) {
    this.pushCalls.push([...baselines]);
    return { accepted: this.acceptedOverride ?? baselines.length };
  }
  async pull(since) {
    this.pullCalls.push(since);
    return this.pulled;
  }
}

test("runFederatedSync: happy path pushes redacted + returns pulled", async () => {
  const t = new RecordingTransport();
  t.pulled = [
    {
      version: 1,
      kind: "failure",
      contentHash: "b".repeat(64),
      domain: "code",
      category: "security",
      severity: "blocker",
      tags: ["remote-pulled"],
      dayBucket: "2026-04-18",
    },
  ];
  const result = await runFederatedSync({ transport: t, answerKeys: [KEY], failures: [FAILURE] });
  assert.equal(result.pushed.length, 2);
  assert.equal(result.accepted, 2);
  assert.equal(result.pulled.length, 1);
  assert.equal(result.dryRun, false);
  assert.equal(result.transportId, "record");
  // The transport should see only redacted baselines, never raw AnswerKey/FailureEntry
  const sent = t.pushCalls[0];
  assert.ok(sent.every((b) => "contentHash" in b && !("lesson" in b) && !("title" in b)));
});

test("runFederatedSync: dryRun = true performs zero network I/O", async () => {
  const t = new RecordingTransport();
  t.pulled = [{ version: 1, kind: "failure", contentHash: "c".repeat(64), domain: "code", category: "type-error", severity: "minor", tags: [], dayBucket: "2026-04-18" }];
  const result = await runFederatedSync({
    transport: t,
    answerKeys: [KEY],
    failures: [FAILURE],
    dryRun: true,
  });
  assert.equal(t.pushCalls.length, 0);
  assert.equal(t.pullCalls.length, 0);
  assert.equal(result.pushed.length, 2);
  assert.equal(result.accepted, 0);
  assert.deepEqual(result.pulled, []);
  assert.equal(result.dryRun, true);
});

test("runFederatedSync: pushDisabled skips push but still pulls", async () => {
  const t = new RecordingTransport();
  await runFederatedSync({
    transport: t,
    answerKeys: [KEY],
    failures: [],
    pushDisabled: true,
  });
  assert.equal(t.pushCalls.length, 0);
  assert.equal(t.pullCalls.length, 1);
});

test("runFederatedSync: pullDisabled skips pull but still pushes", async () => {
  const t = new RecordingTransport();
  const result = await runFederatedSync({
    transport: t,
    answerKeys: [KEY],
    failures: [],
    pullDisabled: true,
  });
  assert.equal(t.pushCalls.length, 1);
  assert.equal(t.pullCalls.length, 0);
  assert.deepEqual(result.pulled, []);
});

test("runFederatedSync: empty inputs skip push network call, still pulls", async () => {
  const t = new RecordingTransport();
  const result = await runFederatedSync({ transport: t, answerKeys: [], failures: [] });
  assert.equal(t.pushCalls.length, 0); // we skip push when there's nothing to send
  assert.equal(t.pullCalls.length, 1);
  assert.equal(result.pushed.length, 0);
  assert.equal(result.accepted, 0);
});

test("runFederatedSync: since timestamp forwarded to transport.pull", async () => {
  const t = new RecordingTransport();
  await runFederatedSync({
    transport: t,
    answerKeys: [],
    failures: [],
    since: "2026-04-18T00:00:00Z",
  });
  assert.equal(t.pullCalls[0], "2026-04-18T00:00:00Z");
});

test("runFederatedSync: server accepted count (may be < sent) surfaced as-is", async () => {
  const t = new RecordingTransport();
  t.acceptedOverride = 1; // server dedupes: we sent 2, it accepted 1
  const result = await runFederatedSync({
    transport: t,
    answerKeys: [KEY],
    failures: [FAILURE],
  });
  assert.equal(result.pushed.length, 2);
  assert.equal(result.accepted, 1);
});
