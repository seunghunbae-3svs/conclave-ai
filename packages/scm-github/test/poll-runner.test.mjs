import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileSystemMemoryStore, OutcomeWriter } from "@ai-conclave/core";
import { pollOutcomes, listPendingEpisodics } from "../dist/index.js";

function freshFs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aic-poll-"));
  return { store: new FileSystemMemoryStore({ root }), root };
}
function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

const approveCtx = {
  diff: "+change",
  repo: "acme/app",
  pullNumber: 42,
  newSha: "head-sha",
};
const approveReview = { agent: "claude", verdict: "approve", blockers: [], summary: "LGTM" };
const rejectReview = {
  agent: "claude",
  verdict: "reject",
  blockers: [{ severity: "blocker", category: "security", message: "leak" }],
  summary: "blocker",
};

function runner(responses) {
  let i = 0;
  return async (_bin, _args) => {
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (typeof r === "function") return { stdout: r() };
    return { stdout: JSON.stringify(r) };
  };
}

test("pollOutcomes: empty store → scanned 0", async () => {
  const { store, root } = freshFs();
  try {
    const writer = new OutcomeWriter({ store });
    const summary = await pollOutcomes({ store, writer, run: runner([]) });
    assert.equal(summary.scanned, 0);
  } finally {
    cleanup(root);
  }
});

test("pollOutcomes: merged PR writes AnswerKey", async () => {
  const { store, root } = freshFs();
  try {
    const writer = new OutcomeWriter({ store });
    await writer.writeReview({
      ctx: approveCtx,
      reviews: [approveReview],
      councilVerdict: "approve",
      costUsd: 0.01,
    });
    const summary = await pollOutcomes({
      store,
      writer,
      run: runner([{ state: "MERGED", headRefOid: "head-sha", mergeCommit: { oid: "m" }, updatedAt: "2026-04-19T00:00:00Z" }]),
    });
    assert.equal(summary.merged, 1);
    assert.equal(summary.scanned, 1);
    assert.equal(summary.results[0].wrote, true);
    assert.equal((await store.listAnswerKeys()).length, 1);
  } finally {
    cleanup(root);
  }
});

test("pollOutcomes: closed PR → rejected + FailureEntry", async () => {
  const { store, root } = freshFs();
  try {
    const writer = new OutcomeWriter({ store });
    await writer.writeReview({
      ctx: approveCtx,
      reviews: [rejectReview],
      councilVerdict: "reject",
      costUsd: 0.01,
    });
    const summary = await pollOutcomes({
      store,
      writer,
      run: runner([{ state: "CLOSED", headRefOid: "head-sha", updatedAt: "2026-04-19T00:00:00Z" }]),
    });
    assert.equal(summary.rejected, 1);
    assert.equal((await store.listFailures()).length, 1);
  } finally {
    cleanup(root);
  }
});

test("pollOutcomes: open with advanced head → reworked + FailureEntry", async () => {
  const { store, root } = freshFs();
  try {
    const writer = new OutcomeWriter({ store });
    await writer.writeReview({
      ctx: approveCtx,
      reviews: [rejectReview],
      councilVerdict: "reject",
      costUsd: 0.01,
    });
    const summary = await pollOutcomes({
      store,
      writer,
      run: runner([{ state: "OPEN", headRefOid: "different-sha", updatedAt: "2026-04-19T00:00:00Z" }]),
    });
    assert.equal(summary.reworked, 1);
    assert.equal((await store.listFailures()).length, 1);
  } finally {
    cleanup(root);
  }
});

test("pollOutcomes: open with same head → pending (no write)", async () => {
  const { store, root } = freshFs();
  try {
    const writer = new OutcomeWriter({ store });
    await writer.writeReview({
      ctx: approveCtx,
      reviews: [approveReview],
      councilVerdict: "approve",
      costUsd: 0.01,
    });
    const summary = await pollOutcomes({
      store,
      writer,
      run: runner([{ state: "OPEN", headRefOid: "head-sha", updatedAt: "2026-04-19T00:00:00Z" }]),
    });
    assert.equal(summary.merged + summary.rejected + summary.reworked, 0);
    assert.equal(summary.pending, 1);
    assert.equal((await store.listAnswerKeys()).length, 0);
  } finally {
    cleanup(root);
  }
});

test("pollOutcomes: pullNumber=0 (local review) → pending, no gh call", async () => {
  const { store, root } = freshFs();
  try {
    const writer = new OutcomeWriter({ store });
    await writer.writeReview({
      ctx: { ...approveCtx, pullNumber: 0 },
      reviews: [approveReview],
      councilVerdict: "approve",
      costUsd: 0.01,
    });
    let called = false;
    const run = async () => {
      called = true;
      return { stdout: "{}" };
    };
    const summary = await pollOutcomes({ store, writer, run });
    assert.equal(called, false);
    assert.equal(summary.pending, 1);
  } finally {
    cleanup(root);
  }
});

test("pollOutcomes: gh errors counted, scan continues", async () => {
  const { store, root } = freshFs();
  try {
    const writer = new OutcomeWriter({ store });
    await writer.writeReview({
      ctx: { ...approveCtx, pullNumber: 1 },
      reviews: [approveReview],
      councilVerdict: "approve",
      costUsd: 0.01,
    });
    await writer.writeReview({
      ctx: { ...approveCtx, pullNumber: 2 },
      reviews: [approveReview],
      councilVerdict: "approve",
      costUsd: 0.01,
    });
    let call = 0;
    const run = async () => {
      call += 1;
      if (call === 1) throw new Error("gh boom");
      return { stdout: JSON.stringify({ state: "MERGED", headRefOid: "head-sha", mergeCommit: { oid: "m" }, updatedAt: "2026-04-19T00:00:00Z" }) };
    };
    const summary = await pollOutcomes({ store, writer, run });
    assert.equal(summary.errors, 1);
    assert.equal(summary.merged, 1);
  } finally {
    cleanup(root);
  }
});

test("pollOutcomes: only pending entries polled (merged ones skipped)", async () => {
  const { store, root } = freshFs();
  try {
    const writer = new OutcomeWriter({ store });
    const ep1 = await writer.writeReview({ ctx: approveCtx, reviews: [approveReview], councilVerdict: "approve", costUsd: 0.01 });
    // Already resolved earlier — should not be re-polled.
    await writer.recordOutcome({ episodicId: ep1.id, outcome: "merged" });
    await writer.writeReview({
      ctx: { ...approveCtx, pullNumber: 99 },
      reviews: [approveReview],
      councilVerdict: "approve",
      costUsd: 0.01,
    });
    let callCount = 0;
    const run = async () => {
      callCount += 1;
      return { stdout: JSON.stringify({ state: "OPEN", headRefOid: "head-sha", updatedAt: "2026-04-19T00:00:00Z" }) };
    };
    const summary = await pollOutcomes({ store, writer, run });
    assert.equal(summary.scanned, 1);
    assert.equal(callCount, 1);
  } finally {
    cleanup(root);
  }
});

test("listPendingEpisodics: returns only pending entries", async () => {
  const { store, root } = freshFs();
  try {
    const writer = new OutcomeWriter({ store });
    const epA = await writer.writeReview({ ctx: approveCtx, reviews: [approveReview], councilVerdict: "approve", costUsd: 0.01 });
    await writer.recordOutcome({ episodicId: epA.id, outcome: "merged" });
    await writer.writeReview({
      ctx: { ...approveCtx, pullNumber: 77 },
      reviews: [approveReview],
      councilVerdict: "approve",
      costUsd: 0.01,
    });
    const pending = await listPendingEpisodics(store);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].pullNumber, 77);
  } finally {
    cleanup(root);
  }
});
