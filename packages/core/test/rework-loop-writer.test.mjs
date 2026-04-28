import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileSystemMemoryStore, writeReworkLoopFailure } from "../dist/index.js";

function freshFs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aic-rwloop-"));
  return { store: new FileSystemMemoryStore({ root }), root };
}
function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

const sampleBlocker = {
  severity: "major",
  category: "debug-noise",
  message: "console.log debug call left in compressImage",
  file: "src/utils/imageCompressor.js",
  line: 18,
};

test("writeReworkLoopFailure: writes a FailureEntry tagged 'rework-loop-failure'", async () => {
  const { store, root } = freshFs();
  try {
    const out = await writeReworkLoopFailure(store, {
      repo: "acme/app",
      bailStatus: "bailed-no-patches",
      iterationsAttempted: 3,
      totalCostUsd: 0.6,
      remainingBlockers: [sampleBlocker],
    });
    assert.ok(out.written, "expected written entry");
    assert.equal(out.written.severity, "major");
    assert.ok(out.written.tags.includes("rework-loop-failure"));
    assert.ok(out.written.tags.includes("bailed-no-patches"));
    assert.ok(out.written.tags.includes("debug-noise"));
    assert.match(out.written.title, /bailed-no-patches/);
    assert.match(out.written.body, /3 iteration/);
    assert.match(out.written.body, /\$0\.60/);
    assert.equal(out.written.seedBlocker.message, sampleBlocker.message);

    const failures = await store.listFailures("code");
    assert.equal(failures.length, 1);
  } finally {
    cleanup(root);
  }
});

test("writeReworkLoopFailure: empty remainingBlockers → no entry, returns reason", async () => {
  const { store, root } = freshFs();
  try {
    const out = await writeReworkLoopFailure(store, {
      repo: "acme/app",
      bailStatus: "bailed-budget",
      iterationsAttempted: 1,
      totalCostUsd: 1,
      remainingBlockers: [],
    });
    assert.equal(out.written, null);
    assert.match(out.reason, /no remaining blockers/);
    const failures = await store.listFailures("code");
    assert.equal(failures.length, 0);
  } finally {
    cleanup(root);
  }
});

test("writeReworkLoopFailure: deterministic id — re-running with same shape doesn't dup", async () => {
  const { store, root } = freshFs();
  try {
    const input = {
      repo: "acme/app",
      bailStatus: "bailed-build-failed",
      iterationsAttempted: 2,
      totalCostUsd: 0.4,
      remainingBlockers: [sampleBlocker],
    };
    const a = await writeReworkLoopFailure(store, input);
    const b = await writeReworkLoopFailure(store, input);
    assert.equal(a.written.id, b.written.id);
    // FS store uses one file per id, so a 2nd write to the same id
    // overwrites — listFailures returns one entry.
    const failures = await store.listFailures("code");
    assert.equal(failures.length, 1);
  } finally {
    cleanup(root);
  }
});

test("writeReworkLoopFailure: different bail statuses produce distinct entries", async () => {
  const { store, root } = freshFs();
  try {
    await writeReworkLoopFailure(store, {
      repo: "acme/app",
      bailStatus: "bailed-no-patches",
      iterationsAttempted: 1,
      totalCostUsd: 0.2,
      remainingBlockers: [sampleBlocker],
    });
    await writeReworkLoopFailure(store, {
      repo: "acme/app",
      bailStatus: "bailed-build-failed",
      iterationsAttempted: 2,
      totalCostUsd: 0.4,
      remainingBlockers: [sampleBlocker],
    });
    const failures = await store.listFailures("code");
    assert.equal(failures.length, 2);
    const statuses = failures.map((f) => f.tags.find((t) => t.startsWith("bailed-"))).sort();
    assert.deepEqual(statuses, ["bailed-build-failed", "bailed-no-patches"]);
  } finally {
    cleanup(root);
  }
});

test("writeReworkLoopFailure: tags carry every distinct blocker category", async () => {
  const { store, root } = freshFs();
  try {
    const out = await writeReworkLoopFailure(store, {
      repo: "acme/app",
      bailStatus: "bailed-tests-failed",
      iterationsAttempted: 2,
      totalCostUsd: 0.5,
      remainingBlockers: [
        sampleBlocker,
        { severity: "major", category: "missing-test", message: "no test for new branch" },
        { severity: "minor", category: "missing-test", message: "duplicate cat — should not dup tag" },
      ],
    });
    assert.ok(out.written);
    const seen = new Set(out.written.tags);
    assert.ok(seen.has("debug-noise"));
    assert.ok(seen.has("missing-test"));
    // Tag is added once per distinct category, but the array itself
    // may have duplicates if seedBlocker.category === otherCategory.
    // Test exposure: dedup depth is "by Set" not "no dups in array".
    assert.equal(out.written.tags.filter((t) => t === "missing-test").length, 1);
  } finally {
    cleanup(root);
  }
});

test("writeReworkLoopFailure: category falls back to mapCategory for free-form blockers", async () => {
  const { store, root } = freshFs();
  try {
    const out = await writeReworkLoopFailure(store, {
      repo: "acme/app",
      bailStatus: "bailed-no-patches",
      iterationsAttempted: 1,
      totalCostUsd: 0.2,
      remainingBlockers: [
        { severity: "major", category: "weird-custom", message: "x" }, // → "other"
      ],
    });
    assert.equal(out.written.category, "other");
  } finally {
    cleanup(root);
  }
});

test("writeReworkLoopFailure: episodicId round-trips when supplied", async () => {
  const { store, root } = freshFs();
  try {
    const out = await writeReworkLoopFailure(store, {
      repo: "acme/app",
      bailStatus: "bailed-no-patches",
      iterationsAttempted: 1,
      totalCostUsd: 0.2,
      remainingBlockers: [sampleBlocker],
      episodicId: "ep-test-123",
    });
    assert.equal(out.written.episodicId, "ep-test-123");
  } finally {
    cleanup(root);
  }
});
