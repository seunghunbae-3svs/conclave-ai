import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileSystemMemoryStore, FileSystemCalibrationStore, OutcomeWriter } from "../dist/index.js";

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

// H2 #6 — chain walk + removed-blocker landing in answer-key

test("writeReview: persists cycleNumber + priorEpisodicId fields", async () => {
  const { store, root } = freshFs();
  try {
    const writer = new OutcomeWriter({ store });
    const c1 = await writer.writeReview({
      ctx: baseCtx,
      reviews: [rejectReview],
      councilVerdict: "rework",
      costUsd: 0.01,
      cycleNumber: 1,
    });
    const c2 = await writer.writeReview({
      ctx: { ...baseCtx, newSha: "sha-c2" },
      reviews: [approveReview],
      councilVerdict: "approve",
      costUsd: 0.01,
      cycleNumber: 2,
      priorEpisodicId: c1.id,
    });
    const found = await store.findEpisodic(c2.id);
    assert.equal(found.cycleNumber, 2);
    assert.equal(found.priorEpisodicId, c1.id);
  } finally {
    cleanup(root);
  }
});

test("recordOutcome merged: walks priorEpisodicId chain + records removed-blockers", async () => {
  const { store, root } = freshFs();
  try {
    const writer = new OutcomeWriter({ store });
    const cycle1 = await writer.writeReview({
      ctx: baseCtx,
      reviews: [
        {
          agent: "claude",
          verdict: "rework",
          blockers: [
            { severity: "major", category: "debug-noise", message: "console.log debug call left in compressImage" },
          ],
          summary: "1 blocker",
        },
      ],
      councilVerdict: "rework",
      costUsd: 0.01,
      cycleNumber: 1,
    });
    // First record cycle 1 as reworked (it ships failure-catalog; orthogonal to the merge path).
    await writer.recordOutcome({ episodicId: cycle1.id, outcome: "reworked" });

    const cycle2 = await writer.writeReview({
      ctx: { ...baseCtx, newSha: "sha-c2" },
      reviews: [approveReview],
      councilVerdict: "approve",
      costUsd: 0.01,
      cycleNumber: 2,
      priorEpisodicId: cycle1.id,
    });
    const out = await writer.recordOutcome({ episodicId: cycle2.id, outcome: "merged" });
    assert.equal(out.answerKeys.length, 1);
    const ak = out.answerKeys[0];
    assert.equal(ak.removedBlockers.length, 1);
    assert.equal(ak.removedBlockers[0].category, "debug-noise");
    assert.match(ak.removedBlockers[0].message, /console\.log/);
    assert.match(ak.lesson, /Resolved before merge/);
  } finally {
    cleanup(root);
  }
});

test("recordOutcome merged: missing prior in chain is treated as 'no further history' (no throw)", async () => {
  const { store, root } = freshFs();
  try {
    const writer = new OutcomeWriter({ store });
    const cycle2 = await writer.writeReview({
      ctx: baseCtx,
      reviews: [approveReview],
      councilVerdict: "approve",
      costUsd: 0.01,
      cycleNumber: 2,
      priorEpisodicId: "ep-does-not-exist",
    });
    const out = await writer.recordOutcome({ episodicId: cycle2.id, outcome: "merged" });
    assert.equal(out.answerKeys.length, 1);
    assert.equal(out.answerKeys[0].removedBlockers.length, 0);
  } finally {
    cleanup(root);
  }
});

// H2 #8 — calibration auto-recording on merge that overrides a rework/reject verdict

test("recordOutcome merged on rework verdict: writes calibration override per blocker category", async () => {
  const { store, root } = freshFs();
  try {
    const calibration = new FileSystemCalibrationStore({ root });
    const writer = new OutcomeWriter({ store, calibration });
    const ep = await writer.writeReview({
      ctx: baseCtx,
      reviews: [
        {
          agent: "claude",
          verdict: "rework",
          blockers: [
            { severity: "major", category: "debug-noise", message: "console.log left in" },
            { severity: "major", category: "missing-test", message: "no test for new branch" },
            { severity: "nit", category: "style", message: "trailing whitespace" }, // should be skipped
          ],
          summary: "2 majors + 1 nit",
        },
      ],
      councilVerdict: "rework",
      costUsd: 0.01,
    });
    await writer.recordOutcome({ episodicId: ep.id, outcome: "merged" });

    const cal = await calibration.load(baseCtx.repo, "code");
    assert.equal(cal.size, 2); // nit excluded
    assert.equal(cal.get("debug-noise").overrideCount, 1);
    assert.equal(cal.get("missing-test").overrideCount, 1);
    assert.equal(cal.get("debug-noise").lastSampleEpisodicId, ep.id);
  } finally {
    cleanup(root);
  }
});

test("recordOutcome merged on approve verdict: NO calibration recorded", async () => {
  const { store, root } = freshFs();
  try {
    const calibration = new FileSystemCalibrationStore({ root });
    const writer = new OutcomeWriter({ store, calibration });
    const ep = await writer.writeReview({
      ctx: baseCtx,
      reviews: [approveReview],
      councilVerdict: "approve",
      costUsd: 0.01,
    });
    await writer.recordOutcome({ episodicId: ep.id, outcome: "merged" });
    const cal = await calibration.load(baseCtx.repo, "code");
    assert.equal(cal.size, 0);
  } finally {
    cleanup(root);
  }
});

test("recordOutcome rejected: NO calibration written even with rework verdict", async () => {
  const { store, root } = freshFs();
  try {
    const calibration = new FileSystemCalibrationStore({ root });
    const writer = new OutcomeWriter({ store, calibration });
    const ep = await writer.writeReview({
      ctx: baseCtx,
      reviews: [rejectReview],
      councilVerdict: "reject",
      costUsd: 0.01,
    });
    await writer.recordOutcome({ episodicId: ep.id, outcome: "rejected" });
    const cal = await calibration.load(baseCtx.repo, "code");
    assert.equal(cal.size, 0);
  } finally {
    cleanup(root);
  }
});

test("recordOutcome merged: dedupes the same category across agents in the same merge", async () => {
  const { store, root } = freshFs();
  try {
    const calibration = new FileSystemCalibrationStore({ root });
    const writer = new OutcomeWriter({ store, calibration });
    const ep = await writer.writeReview({
      ctx: baseCtx,
      reviews: [
        {
          agent: "claude",
          verdict: "rework",
          blockers: [{ severity: "major", category: "debug-noise", message: "a" }],
          summary: "",
        },
        {
          agent: "openai",
          verdict: "rework",
          blockers: [{ severity: "major", category: "debug-noise", message: "b" }],
          summary: "",
        },
      ],
      councilVerdict: "rework",
      costUsd: 0.01,
    });
    await writer.recordOutcome({ episodicId: ep.id, outcome: "merged" });
    const cal = await calibration.load(baseCtx.repo, "code");
    assert.equal(cal.get("debug-noise").overrideCount, 1); // not 2
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
