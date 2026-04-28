/**
 * H3 #14 fullchain audit — federation auto-push on record-outcome.
 *
 * Round-trips:
 *   1. recordOutcome("merged") → OutcomeWriter writes answer-keys/failures
 *      to disk.
 *   2. autoPushOutcome called with the deltas + opt-in config + endpoint.
 *   3. HTTP transport's push() called with k-anonymous redacted baselines.
 *   4. PRIVACY INVARIANT: no diff text, repo name, lesson, body, title,
 *      snippet, seedBlocker, episodicId, user. Only normalized
 *      kind/domain/(category/severity)/tags/dayBucket/contentHash.
 *   5. PULL DISABLED: transport.pull() must never be called by autoPush.
 *   6. ERROR ISOLATION: transport.push() throws → user's record-outcome
 *      doesn't fail.
 *
 * Privacy invariant 4 is the contract Bae signed up for in decision #21
 * — any leak there is a hard regression.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FileSystemMemoryStore,
  OutcomeWriter,
} from "@conclave-ai/core";
import { autoPushOutcome } from "../dist/lib/federated-auto-push.js";

function freshFs() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aic-h3-14-fc-"));
}
function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

class CapturingTransport {
  constructor() {
    this.id = "capturing";
    this.pushBatches = [];
    this.pullCalls = [];
    this.failNext = false;
  }
  async push(batch) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("network error simulated");
    }
    this.pushBatches.push(batch);
    return { accepted: batch.length };
  }
  async pull(since) {
    this.pullCalls.push(since);
    return [];
  }
}

const REPO = "acme/secret-internal-app";
const SECRET_USER = "internal-engineer-23";
const SECRET_LESSON = "merged the new authentication middleware that was failing on edge case X";
const SECRET_TITLE = "JWT logged in full when audit log handler was misconfigured";
const SECRET_BODY = "The handler at src/auth/audit.ts:42 was logging req.headers including Authorization";

const config = {
  federated: {
    enabled: true,
    endpoint: "https://federation.example.com/sync",
    autoPush: true,
  },
};

test("H3 #14 fullchain: full chain — record-outcome merge → auto-push only deltas (redacted)", async () => {
  const root = freshFs();
  try {
    const store = new FileSystemMemoryStore({ root });
    const writer = new OutcomeWriter({ store });

    // Stage 1: Write a review + reject so the outcome generates a
    // failure entry full of secret content.
    const ep = await writer.writeReview({
      ctx: {
        diff: `[secret diff with internal paths] ${SECRET_BODY}`,
        repo: REPO,
        pullNumber: 7,
        newSha: "secret-sha",
      },
      reviews: [
        {
          agent: "claude",
          verdict: "reject",
          blockers: [
            {
              severity: "blocker",
              category: "security",
              message: SECRET_TITLE,
              file: "src/auth/audit.ts",
              line: 42,
            },
          ],
          summary: SECRET_LESSON,
        },
      ],
      councilVerdict: "reject",
      costUsd: 0.05,
      cycleNumber: 1,
    });
    const recorded = await writer.recordOutcome({ episodicId: ep.id, outcome: "rejected" });
    assert.equal(recorded.failures.length, 1);

    // Stage 2: autoPushOutcome with the deltas, capturing transport.
    const transport = new CapturingTransport();
    const result = await autoPushOutcome({
      config,
      written: { answerKeys: recorded.answerKeys, failures: recorded.failures },
      transport,
    });

    assert.equal(result.attempted, true);
    assert.equal(result.pushed, 1);
    assert.equal(transport.pushBatches.length, 1);
    assert.equal(transport.pullCalls.length, 0, "pull must NEVER be called by auto-push");

    // Stage 3: PRIVACY INVARIANT — verify what actually went over the wire.
    const sentBatch = transport.pushBatches[0];
    const flat = JSON.stringify(sentBatch);

    assert.doesNotMatch(flat, /JWT logged in full/, "leaked failure title!");
    assert.doesNotMatch(flat, /audit log handler/, "leaked failure title fragment!");
    assert.doesNotMatch(flat, /req\.headers/, "leaked failure body!");
    assert.doesNotMatch(flat, /merged the new authentication/, "leaked summary/lesson!");
    assert.doesNotMatch(flat, /secret-internal-app/, "leaked repo name!");
    assert.doesNotMatch(flat, /secret-sha/, "leaked sha!");
    assert.doesNotMatch(flat, /src\/auth\/audit\.ts/, "leaked file path from seedBlocker!");
    assert.doesNotMatch(flat, /internal-engineer/, "leaked user identifier!");
    assert.doesNotMatch(flat, /\[secret diff/, "leaked diff!");

    // Positive shape — only allowed fields appear.
    for (const baseline of sentBatch) {
      assert.equal(baseline.version, 1);
      assert.ok(["answer-key", "failure"].includes(baseline.kind));
      assert.equal(baseline.contentHash.length, 64);
      assert.match(baseline.dayBucket, /^\d{4}-\d{2}-\d{2}$/);
      // Allowed fields only.
      const allowed = new Set([
        "version",
        "kind",
        "contentHash",
        "domain",
        "category",
        "severity",
        "tags",
        "dayBucket",
      ]);
      for (const k of Object.keys(baseline)) {
        assert.ok(allowed.has(k), `unexpected field "${k}" in federated baseline`);
      }
    }
  } finally {
    cleanup(root);
  }
});

test("H3 #14 fullchain: empty deltas → transport not invoked", async () => {
  const transport = new CapturingTransport();
  const result = await autoPushOutcome({
    config,
    written: { answerKeys: [], failures: [] },
    transport,
  });
  assert.equal(result.attempted, false);
  assert.match(result.skipReason, /no entries written/);
  assert.equal(transport.pushBatches.length, 0);
});

test("H3 #14 fullchain: transport throw → caller sees error string, no exception escapes", async () => {
  const transport = new CapturingTransport();
  transport.failNext = true;
  const result = await autoPushOutcome({
    config,
    written: {
      answerKeys: [
        {
          id: "ak-1",
          createdAt: new Date().toISOString(),
          domain: "code",
          pattern: "by-repo/x",
          lesson: "x",
          tags: ["x"],
          removedBlockers: [],
        },
      ],
      failures: [],
    },
    transport,
  });
  assert.equal(result.attempted, true);
  assert.equal(result.pushed, 0);
  assert.match(result.error, /network error/);
});

test("H3 #14 fullchain: federation disabled in config → no transport call (silent skip)", async () => {
  const transport = new CapturingTransport();
  const result = await autoPushOutcome({
    config: { federated: { enabled: false, endpoint: "https://x", autoPush: true } },
    written: {
      answerKeys: [
        {
          id: "ak-1",
          createdAt: new Date().toISOString(),
          domain: "code",
          pattern: "x",
          lesson: "x",
          tags: ["x"],
          removedBlockers: [],
        },
      ],
      failures: [],
    },
    transport,
  });
  assert.equal(result.attempted, false);
  assert.match(result.skipReason, /disabled/);
  assert.equal(transport.pushBatches.length, 0);
});

test("H3 #14 fullchain: autoPush=false → no transport call", async () => {
  const transport = new CapturingTransport();
  const result = await autoPushOutcome({
    config: { federated: { enabled: true, endpoint: "https://x", autoPush: false } },
    written: {
      answerKeys: [
        {
          id: "ak-1",
          createdAt: new Date().toISOString(),
          domain: "code",
          pattern: "x",
          lesson: "x",
          tags: ["x"],
          removedBlockers: [],
        },
      ],
      failures: [],
    },
    transport,
  });
  assert.equal(result.attempted, false);
  assert.match(result.skipReason, /autoPush is false/);
  assert.equal(transport.pushBatches.length, 0);
});

test("H3 #14 fullchain: contentHash is deterministic across users (same inputs → same hash)", async () => {
  // Stability invariant: two installs producing baselines from
  // structurally-identical answer-keys must yield the same
  // contentHash so the server can aggregate frequency without
  // identifying the user.
  const transport = new CapturingTransport();
  const sharedAnswerKey = {
    id: "ak-A",
    createdAt: "2026-04-28T12:00:00.000Z",
    domain: "code",
    pattern: "by-pattern/auth",
    lesson: "different per install",
    tags: ["auth", "middleware"],
    removedBlockers: [],
  };
  await autoPushOutcome({
    config,
    written: { answerKeys: [sharedAnswerKey], failures: [] },
    transport,
  });
  // Same shape, different lesson + repo (different user simulating).
  await autoPushOutcome({
    config,
    written: {
      answerKeys: [{ ...sharedAnswerKey, id: "ak-B-different-id", lesson: "totally different prose" }],
      failures: [],
    },
    transport,
  });
  assert.equal(transport.pushBatches.length, 2);
  const h1 = transport.pushBatches[0][0].contentHash;
  const h2 = transport.pushBatches[1][0].contentHash;
  assert.equal(h1, h2, "contentHash must be deterministic across users for same (domain, tags) shape");
});
