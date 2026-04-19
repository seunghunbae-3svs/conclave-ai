import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileSystemMemoryStore, OutcomeWriter } from "../dist/index.js";

function freshFs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aic-outcome-"));
  return { store: new FileSystemMemoryStore({ root }), root };
}
function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

const baseCtx = { diff: "diff --git a/x b/x\n+added", repo: "acme/app", pullNumber: 42, newSha: "sha-head" };
const approveReview = { agent: "claude", verdict: "approve", blockers: [], summary: "LGTM" };
const rejectReview = {
  agent: "claude",
  verdict: "reject",
  blockers: [{ severity: "blocker", category: "security", message: "hardcoded key" }],
  summary: "blocker",
};

test("writeReview: persists an episodic entry with outcome=pending", async () => {
  const { store, root } = freshFs();
  try {
    const writer = new OutcomeWriter({ store });
    const entry = await writer.writeReview({
      ctx: baseCtx,
      reviews: [approveReview],
      councilVerdict: "approve",
      costUsd: 0.02,
    });
    assert.equal(entry.outcome, "pending");
    assert.equal(entry.reviews.length, 1);
    // Round-trip: the file exists and is findable.
    const found = await store.findEpisodic(entry.id);
    assert.ok(found);
    assert.equal(found.id, entry.id);
  } finally {
    cleanup(root);
  }
});

test("recordOutcome merged: writes one answer-key", async () => {
  const { store, root } = freshFs();
  try {
    const writer = new OutcomeWriter({ store });
    const ep = await writer.writeReview({
      ctx: baseCtx,
      reviews: [approveReview],
      councilVerdict: "approve",
      costUsd: 0.01,
    });
    const out = await writer.recordOutcome({ episodicId: ep.id, outcome: "merged" });
    assert.equal(out.answerKeys.length, 1);
    assert.equal(out.failures.length, 0);
    const aks = await store.listAnswerKeys();
    assert.equal(aks.length, 1);
  } finally {
    cleanup(root);
  }
});

test("recordOutcome rejected: writes failures from each blocker", async () => {
  const { store, root } = freshFs();
  try {
    const writer = new OutcomeWriter({ store });
    const ep = await writer.writeReview({
      ctx: baseCtx,
      reviews: [rejectReview],
      councilVerdict: "reject",
      costUsd: 0.03,
    });
    const out = await writer.recordOutcome({ episodicId: ep.id, outcome: "rejected" });
    assert.equal(out.failures.length, 1);
    const failures = await store.listFailures();
    assert.equal(failures.length, 1);
    assert.equal(failures[0].category, "security");
  } finally {
    cleanup(root);
  }
});

test("recordOutcome: updates episodic outcome field from pending → merged/rejected/reworked", async () => {
  const { store, root } = freshFs();
  try {
    const writer = new OutcomeWriter({ store });
    const ep = await writer.writeReview({
      ctx: baseCtx,
      reviews: [approveReview],
      councilVerdict: "approve",
      costUsd: 0.01,
    });
    await writer.recordOutcome({ episodicId: ep.id, outcome: "merged" });
    const after = await store.findEpisodic(ep.id);
    assert.equal(after.outcome, "merged");
  } finally {
    cleanup(root);
  }
});

test("recordOutcome: reconstructs episodic from disk if in-memory index is cold", async () => {
  const { store, root } = freshFs();
  try {
    const writerA = new OutcomeWriter({ store });
    const ep = await writerA.writeReview({
      ctx: baseCtx,
      reviews: [rejectReview],
      councilVerdict: "reject",
      costUsd: 0.01,
    });
    // Simulate a fresh process: new OutcomeWriter without the id in its index.
    const writerB = new OutcomeWriter({ store });
    const out = await writerB.recordOutcome({ episodicId: ep.id, outcome: "rejected" });
    assert.equal(out.failures.length, 1);
  } finally {
    cleanup(root);
  }
});

test("recordOutcome: unknown episodic id throws actionable error", async () => {
  const { store, root } = freshFs();
  try {
    const writer = new OutcomeWriter({ store });
    await assert.rejects(
      () => writer.recordOutcome({ episodicId: "ep-does-not-exist", outcome: "merged" }),
      /no episodic entry found/,
    );
  } finally {
    cleanup(root);
  }
});

test("writeReview: caller-provided episodicId makes the write idempotent", async () => {
  const { store, root } = freshFs();
  try {
    const writer = new OutcomeWriter({ store });
    const id = "ep-stable-1";
    await writer.writeReview({
      ctx: baseCtx,
      reviews: [approveReview],
      councilVerdict: "approve",
      costUsd: 0.01,
      episodicId: id,
    });
    await writer.writeReview({
      ctx: { ...baseCtx, newSha: "sha-newer" },
      reviews: [approveReview],
      councilVerdict: "approve",
      costUsd: 0.02,
      episodicId: id,
    });
    const found = await store.findEpisodic(id);
    assert.equal(found.sha, "sha-newer"); // latest write wins
  } finally {
    cleanup(root);
  }
});
