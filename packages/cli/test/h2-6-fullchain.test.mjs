/**
 * H2 #6 fullchain audit — answer-keys live retrieval.
 *
 * Round-trips the FULL intended chain on a real on-disk FileSystemMemoryStore:
 *
 *   1. PR-A cycle1 review with blocker → writeReview persists episodic A1
 *      with cycleNumber=1.
 *   2. PR-A cycle2 review (clean) → CLI computes priorEpisodicId via
 *      findPriorEpisodicId, passes to writeReview → episodic A2 with
 *      priorEpisodicId=A1.
 *   3. PR-A merge → recordOutcome("merged") → classifier walks chain
 *      → AnswerKey persisted with removedBlockers populated.
 *   4. PR-B (separate PR) review → store.retrieve() with diff tokens →
 *      AnswerKey surfaces in answerKeys[].
 *   5. formatAnswerKeyForPrompt produces the "Resolved before merge"
 *      string that lands in agent prompts.
 *
 * Anything not round-tripping correctly = real production bug.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FileSystemMemoryStore,
  OutcomeWriter,
  formatAnswerKeyForPrompt,
} from "@conclave-ai/core";
import { findPriorEpisodicId } from "../dist/lib/episodic-chain.js";

function freshFs() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aic-h2-6-fc-"));
}
function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

const REPO = "acme/app";
const PR_A = 42;
const PR_B = 43;

test("H2 #6 fullchain: PR-A rework→merge produces an AnswerKey that surfaces on PR-B's diff", async () => {
  const root = freshFs();
  try {
    const store = new FileSystemMemoryStore({ root });
    const writer = new OutcomeWriter({ store });

    // === Stage 1: PR-A cycle 1 — review finds a blocker. ===
    const ctxA1 = {
      diff: [
        "diff --git a/frontend/src/utils/imageCompressor.js b/frontend/src/utils/imageCompressor.js",
        "--- a/frontend/src/utils/imageCompressor.js",
        "+++ b/frontend/src/utils/imageCompressor.js",
        "@@ -1,3 +1,4 @@",
        " function compressImage(file) {",
        "+  console.log('debug compressImage called');",
        "   return file;",
        " }",
      ].join("\n"),
      repo: REPO,
      pullNumber: PR_A,
      newSha: "sha-A1",
    };
    const c1Cycle = (0 ?? 0) + 1; // mirrors review.ts: (args.reworkCycle ?? 0) + 1, default 1
    const c1Prior = c1Cycle > 1 && PR_A
      ? await findPriorEpisodicId(store, REPO, PR_A, c1Cycle)
      : undefined;
    assert.equal(c1Prior, undefined, "first cycle should have no prior");
    const epA1 = await writer.writeReview({
      ctx: ctxA1,
      reviews: [
        {
          agent: "claude",
          verdict: "rework",
          blockers: [
            {
              severity: "major",
              category: "debug-noise",
              message: "console.log debug call left in compressImage",
              file: "frontend/src/utils/imageCompressor.js",
              line: 18,
            },
          ],
          summary: "1 major blocker",
        },
      ],
      councilVerdict: "rework",
      costUsd: 0.05,
      cycleNumber: c1Cycle,
    });
    assert.equal(epA1.cycleNumber, 1);
    assert.equal(epA1.priorEpisodicId, undefined);
    // Cycle 1 outcome is "reworked" until the cycle 2 reviews confirm it.
    await writer.recordOutcome({ episodicId: epA1.id, outcome: "reworked" });

    // === Stage 2: PR-A cycle 2 — autofix removed the console.log; review approves. ===
    const ctxA2 = {
      diff: [
        "diff --git a/frontend/src/utils/imageCompressor.js b/frontend/src/utils/imageCompressor.js",
        "--- a/frontend/src/utils/imageCompressor.js",
        "+++ b/frontend/src/utils/imageCompressor.js",
        "@@ -1,4 +1,3 @@",
        " function compressImage(file) {",
        "-  console.log('debug compressImage called');",
        "   return file;",
        " }",
      ].join("\n"),
      repo: REPO,
      pullNumber: PR_A,
      newSha: "sha-A2",
    };
    // Mirror review.ts logic exactly:
    const c2ReworkCycle = 1; // --rework-cycle 1 means "this is the second cycle"
    const c2Cycle = c2ReworkCycle + 1;
    const c2Prior = c2Cycle > 1 && PR_A
      ? await findPriorEpisodicId(store, REPO, PR_A, c2Cycle)
      : undefined;
    assert.equal(c2Prior, epA1.id, "cycle-2 prior should resolve to cycle-1 episodic");
    const epA2 = await writer.writeReview({
      ctx: ctxA2,
      reviews: [
        { agent: "claude", verdict: "approve", blockers: [], summary: "LGTM after rework" },
      ],
      councilVerdict: "approve",
      costUsd: 0.02,
      cycleNumber: c2Cycle,
      ...(c2Prior ? { priorEpisodicId: c2Prior } : {}),
    });
    assert.equal(epA2.cycleNumber, 2);
    assert.equal(epA2.priorEpisodicId, epA1.id);

    // === Stage 3: PR-A merge — recordOutcome walks chain, writes AnswerKey. ===
    const merged = await writer.recordOutcome({ episodicId: epA2.id, outcome: "merged" });
    assert.equal(merged.answerKeys.length, 1, "merge should produce exactly one aggregate AnswerKey");
    const ak = merged.answerKeys[0];
    assert.equal(ak.removedBlockers.length, 1, "removedBlockers should carry the cycle-1 blocker");
    assert.equal(ak.removedBlockers[0].category, "debug-noise");
    assert.match(ak.removedBlockers[0].message, /console\.log/);
    assert.match(ak.lesson, /Resolved before merge/, "lesson should advertise the resolved-before-merge signal");
    assert.ok(ak.tags.includes("debug-noise"), "tags should pick up the removed-blocker category");

    // Persisted to disk?
    const onDisk = await store.listAnswerKeys("code");
    assert.equal(onDisk.length, 1);
    assert.equal(onDisk[0].id, ak.id);
    assert.equal(onDisk[0].removedBlockers.length, 1);

    // === Stage 4: PR-B — entirely different PR with similar diff tokens. ===
    // Real review.ts builds queryText = `${repo} ${diff.slice(0, 4_000)}`.
    const ctxB = {
      diff: [
        "diff --git a/frontend/src/components/UploadButton.tsx b/frontend/src/components/UploadButton.tsx",
        "--- a/frontend/src/components/UploadButton.tsx",
        "+++ b/frontend/src/components/UploadButton.tsx",
        "@@ -1,5 +1,7 @@",
        " export function UploadButton() {",
        "+  console.log('debug UploadButton render');",
        "+  return <button>Upload</button>;",
        " }",
      ].join("\n"),
      repo: REPO,
      pullNumber: PR_B,
      newSha: "sha-B1",
    };
    const queryText = `${ctxB.repo} ${ctxB.diff.slice(0, 4_000)}`;
    const retrieval = await store.retrieve({
      query: queryText,
      repo: ctxB.repo,
      k: 8,
    });
    assert.ok(
      retrieval.answerKeys.length >= 1,
      `expected the cycle-1→cycle-2 AnswerKey to surface for PR-B; got ${retrieval.answerKeys.length} answerKeys`,
    );
    const surfaced = retrieval.answerKeys.find((k) => k.id === ak.id);
    assert.ok(surfaced, "the seeded AnswerKey should be in PR-B's retrieval");

    // === Stage 5: prompt rendering — agents must SEE the resolved-before-merge note. ===
    const promptLine = formatAnswerKeyForPrompt(surfaced);
    assert.match(promptLine, /Resolved before merge/);
    assert.match(promptLine, /debug-noise/);
    assert.match(promptLine, /console\.log/, "prompt must include the verbatim blocker message tokens");
  } finally {
    cleanup(root);
  }
});

test("H2 #6 fullchain: 3-cycle PR — chain walks all the way back", async () => {
  const root = freshFs();
  try {
    const store = new FileSystemMemoryStore({ root });
    const writer = new OutcomeWriter({ store });

    const ctxBase = {
      diff: "diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@ -1,1 +1,2 @@\n+x\n",
      repo: REPO,
      pullNumber: 99,
      newSha: "sha",
    };

    // Cycle 1: blocker A
    const ep1 = await writer.writeReview({
      ctx: { ...ctxBase, newSha: "sha-1" },
      reviews: [
        {
          agent: "claude",
          verdict: "rework",
          blockers: [{ severity: "major", category: "type-error", message: "ts2345 mismatch on line 3" }],
          summary: "",
        },
      ],
      councilVerdict: "rework",
      costUsd: 0.01,
      cycleNumber: 1,
    });

    // Cycle 2: blocker A removed, but blocker B introduced
    const c2Prior = await findPriorEpisodicId(store, REPO, 99, 2);
    assert.equal(c2Prior, ep1.id);
    const ep2 = await writer.writeReview({
      ctx: { ...ctxBase, newSha: "sha-2" },
      reviews: [
        {
          agent: "claude",
          verdict: "rework",
          blockers: [{ severity: "major", category: "missing-test", message: "no test for new branch" }],
          summary: "",
        },
      ],
      councilVerdict: "rework",
      costUsd: 0.01,
      cycleNumber: 2,
      priorEpisodicId: c2Prior,
    });

    // Cycle 3: clean approve
    const c3Prior = await findPriorEpisodicId(store, REPO, 99, 3);
    assert.equal(c3Prior, ep2.id);
    const ep3 = await writer.writeReview({
      ctx: { ...ctxBase, newSha: "sha-3" },
      reviews: [{ agent: "claude", verdict: "approve", blockers: [], summary: "LGTM" }],
      councilVerdict: "approve",
      costUsd: 0.01,
      cycleNumber: 3,
      priorEpisodicId: c3Prior,
    });

    const out = await writer.recordOutcome({ episodicId: ep3.id, outcome: "merged" });
    const ak = out.answerKeys[0];
    const removedCats = ak.removedBlockers.map((b) => b.category).sort();
    assert.deepEqual(
      removedCats,
      ["missing-test", "type-error"],
      "BOTH cycle-1 and cycle-2 blockers should land in removedBlockers (chain walked end-to-end)",
    );
  } finally {
    cleanup(root);
  }
});

test("H2 #6 fullchain: distinct PRs of the same repo do NOT cross-contaminate priorEpisodicId", async () => {
  const root = freshFs();
  try {
    const store = new FileSystemMemoryStore({ root });
    const writer = new OutcomeWriter({ store });

    // PR 100 cycle 1
    await writer.writeReview({
      ctx: { diff: "diff --git a/x b/x\n", repo: REPO, pullNumber: 100, newSha: "p100" },
      reviews: [
        {
          agent: "claude",
          verdict: "rework",
          blockers: [{ severity: "major", category: "x", message: "x" }],
          summary: "",
        },
      ],
      councilVerdict: "rework",
      costUsd: 0.01,
      cycleNumber: 1,
    });

    // PR 200 cycle 2 lookup must NOT find PR 100's cycle 1.
    const found = await findPriorEpisodicId(store, REPO, 200, 2);
    assert.equal(found, undefined, "different PR's cycle-1 must not leak into another PR's chain");
  } finally {
    cleanup(root);
  }
});
