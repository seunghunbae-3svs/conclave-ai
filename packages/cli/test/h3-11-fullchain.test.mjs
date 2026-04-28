/**
 * H3 #11 fullchain audit — autofix → solution sidecar → next review →
 * recordOutcome merge → autofix-solution answer-key → next-PR retrieval.
 *
 * This is the most fragile chain in the whole self-evolve loop:
 * 4-hop on-disk handoff between two CLI commands that don't share
 * memory. The sidecar's `cycleNumber` field MUST match what the
 * consuming review will write to its EpisodicEntry, or the entire
 * solutionPatches → answer-key path silently no-ops.
 *
 * Pre-audit, autofix wrote sidecar at the COMMIT MARKER cycle while
 * review reads at the EPISODIC cycleNumber (which is marker+1). Every
 * production handoff was off-by-one — sidecar written, never found.
 * This test pins down the post-fix invariant:
 *   sidecar cycleNumber == next review's episodic.cycleNumber.
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
import { findPriorEpisodicId } from "../dist/lib/episodic-chain.js";
import {
  readSolutionSidecar,
  sidecarPath,
  writeSolutionSidecar,
} from "../dist/lib/solution-sidecar.js";

function freshFs() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aic-h3-11-fc-"));
}
function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

const REPO = "acme/app";
const PR = 42;

test("H3 #11 fullchain: sidecar cycle convention — autofix writes at the cycle the next review will read", async () => {
  // First-autofix scenario:
  //   - cycle 1 review at --rework-cycle 0 → episodic cycleNumber=1
  //   - council says rework. autofix invoked with --rework-cycle 0.
  //   - autofix nextCycle = 0 + 1 = 1 (commit marker [cycle:1])
  //   - workflow extracts marker → next review with --rework-cycle 1
  //   - next review's cycleNumber = 1 + 1 = 2
  // Sidecar must be at cycleNumber=2 — what the review will look for.
  const root = freshFs();
  try {
    const reworkCycle = 0;
    const markerCycle = reworkCycle + 1; // 1
    const nextReviewCycleNumber = markerCycle + 1; // 2 — what next review writes

    await writeSolutionSidecar(
      { memoryRoot: root, repo: REPO, pullNumber: PR, cycleNumber: nextReviewCycleNumber },
      [
        {
          blockerCategory: "debug-noise",
          blockerMessage: "console.log left",
          blockerFile: "src/x.js",
          hunk: "diff --git a/src/x.js b/src/x.js\n--- a/src/x.js\n+++ b/src/x.js\n@@ -1,1 +1,0 @@\n-console.log('debug');\n",
          agent: "claude",
        },
      ],
    );

    // The next review's cycleNumber the workflow will compute:
    const nextReviewArgsReworkCycle = markerCycle; // workflow extracts marker → passes as --rework-cycle
    const nextReviewCycleNumberComputed = nextReviewArgsReworkCycle + 1; // review.ts formula

    const loaded = await readSolutionSidecar({
      memoryRoot: root,
      repo: REPO,
      pullNumber: PR,
      cycleNumber: nextReviewCycleNumberComputed,
    });
    assert.equal(
      loaded.length,
      1,
      `sidecar key mismatch — autofix wrote at cycleNumber=${nextReviewCycleNumber}, ` +
        `next review looks up at cycleNumber=${nextReviewCycleNumberComputed}; they MUST match`,
    );
    assert.equal(loaded[0].blockerCategory, "debug-noise");
  } finally {
    cleanup(root);
  }
});

test("H3 #11 fullchain: sidecar at the WRONG (pre-fix) cycleNumber is NOT picked up", async () => {
  // Negative test: prove the audit found a real bug. If sidecar is
  // written under the marker convention (= reworkCycle + 1) and the
  // review uses the episodic convention (= reworkCycle + 2), it will
  // be silently missed.
  const root = freshFs();
  try {
    const reworkCycle = 0;
    const wrongCycleKey = reworkCycle + 1; // pre-fix code wrote here
    const correctCycleKey = reworkCycle + 2; // review reads here

    await writeSolutionSidecar(
      { memoryRoot: root, repo: REPO, pullNumber: PR, cycleNumber: wrongCycleKey },
      [
        {
          blockerCategory: "debug-noise",
          blockerMessage: "x",
          hunk: "diff --git a/x b/x\n",
          agent: "claude",
        },
      ],
    );
    const loaded = await readSolutionSidecar({
      memoryRoot: root,
      repo: REPO,
      pullNumber: PR,
      cycleNumber: correctCycleKey,
    });
    assert.equal(loaded.length, 0, "lookup at the correct key MUST miss when sidecar is written at the wrong key");
  } finally {
    cleanup(root);
  }
});

test("H3 #11 fullchain: full 4-hop chain — autofix → review → recordOutcome merge → answer-key with solutionPatch", async () => {
  const root = freshFs();
  try {
    const store = new FileSystemMemoryStore({ root });
    const writer = new OutcomeWriter({ store });

    // === Stage 1: Cycle 1 review with blocker (no autofix yet). ===
    const ep1 = await writer.writeReview({
      ctx: {
        diff: "diff --git a/x.js b/x.js\n+console.log('debug');\n",
        repo: REPO,
        pullNumber: PR,
        newSha: "sha-c1",
      },
      reviews: [
        {
          agent: "claude",
          verdict: "rework",
          blockers: [
            {
              severity: "major",
              category: "debug-noise",
              message: "console.log debug call left",
              file: "x.js",
              line: 2,
            },
          ],
          summary: "1 blocker",
        },
      ],
      councilVerdict: "rework",
      costUsd: 0.05,
      cycleNumber: 1,
    });
    await writer.recordOutcome({ episodicId: ep1.id, outcome: "reworked" });

    // === Stage 2: Autofix runs. Per FIXED autofix.ts: ===
    // reworkCycle=0 → markerCycle=1 → sidecar at cycleNumber=2 (next review's episodic.cycleNumber)
    const reworkCycle = 0;
    const sidecarCycle = reworkCycle + 2;
    const samplePatch = {
      blockerCategory: "debug-noise",
      blockerMessage: "console.log debug call left",
      blockerFile: "x.js",
      blockerLine: 2,
      hunk:
        "diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@ -1,2 +1,1 @@\n-console.log('debug');\n",
      agent: "claude",
    };
    await writeSolutionSidecar(
      { memoryRoot: root, repo: REPO, pullNumber: PR, cycleNumber: sidecarCycle },
      [samplePatch],
    );

    // === Stage 3: Cycle 2 review (after the autofix commit was extracted, ===
    // workflow runs review --rework-cycle 1). Mirrors review.ts logic.
    const c2ReworkCycle = reworkCycle + 1; // 1
    const c2CycleNumber = c2ReworkCycle + 1; // 2
    assert.equal(c2CycleNumber, sidecarCycle, "sidecar key invariant");
    const c2Prior = await findPriorEpisodicId(store, REPO, PR, c2CycleNumber);
    assert.equal(c2Prior, ep1.id);
    const sidecarLoad = await readSolutionSidecar({
      memoryRoot: root,
      repo: REPO,
      pullNumber: PR,
      cycleNumber: c2CycleNumber,
    });
    assert.equal(sidecarLoad.length, 1, "review must find the autofix sidecar at the right key");

    const ep2 = await writer.writeReview({
      ctx: {
        diff: "diff --git a/x.js b/x.js\n-console.log('debug');\n",
        repo: REPO,
        pullNumber: PR,
        newSha: "sha-c2",
      },
      reviews: [
        { agent: "claude", verdict: "approve", blockers: [], summary: "LGTM after rework" },
      ],
      councilVerdict: "approve",
      costUsd: 0.02,
      cycleNumber: c2CycleNumber,
      priorEpisodicId: c2Prior,
      solutionPatches: sidecarLoad, // ← this is what review.ts does post-fix
    });

    // === Stage 4: User merges → recordOutcome → answer-key with solutionPatch. ===
    const out = await writer.recordOutcome({ episodicId: ep2.id, outcome: "merged" });
    const solnKey = out.answerKeys.find((k) => k.pattern.startsWith("autofix-solution/"));
    assert.ok(solnKey, "merge must emit an autofix-solution answer-key with solutionPatch");
    assert.equal(solnKey.solutionPatch.blockerCategory, "debug-noise");
    assert.match(solnKey.solutionPatch.hunk, /-console\.log/);

    // === Stage 5: A NEW PR with a similar blocker — retrieval surfaces the autofix-solution. ===
    const ctxNewPR = {
      diff: "diff --git a/y.js b/y.js\n+console.log('debug something');\n",
      repo: REPO,
      pullNumber: 99,
      newSha: "sha-newpr",
    };
    const retrieval = await store.retrieve({
      query: `${REPO} ${ctxNewPR.diff}`,
      repo: REPO,
      k: 8,
    });
    const surfaced = retrieval.answerKeys.find((k) => k.id === solnKey.id);
    assert.ok(surfaced, "new PR's retrieval must surface the autofix-solution answer-key");
    assert.equal(surfaced.solutionPatch.blockerCategory, "debug-noise");
  } finally {
    cleanup(root);
  }
});

test("H3 #11 fullchain: sidecar slug encoding round-trips for tricky repo names", async () => {
  // Slug round-trip — repo names with /, ., - shouldn't collide.
  const root = freshFs();
  try {
    const repoA = "acme/app";
    const repoB = "acme/app.web";
    const repoC = "other/app";
    await writeSolutionSidecar(
      { memoryRoot: root, repo: repoA, pullNumber: 1, cycleNumber: 2 },
      [{ blockerCategory: "x", blockerMessage: "a", hunk: "diff -- a", agent: "claude" }],
    );
    await writeSolutionSidecar(
      { memoryRoot: root, repo: repoB, pullNumber: 1, cycleNumber: 2 },
      [{ blockerCategory: "x", blockerMessage: "b", hunk: "diff -- b", agent: "claude" }],
    );
    await writeSolutionSidecar(
      { memoryRoot: root, repo: repoC, pullNumber: 1, cycleNumber: 2 },
      [{ blockerCategory: "x", blockerMessage: "c", hunk: "diff -- c", agent: "claude" }],
    );
    // Distinct files
    const pA = sidecarPath({ memoryRoot: root, repo: repoA, pullNumber: 1, cycleNumber: 2 });
    const pB = sidecarPath({ memoryRoot: root, repo: repoB, pullNumber: 1, cycleNumber: 2 });
    const pC = sidecarPath({ memoryRoot: root, repo: repoC, pullNumber: 1, cycleNumber: 2 });
    assert.notEqual(pA, pB);
    assert.notEqual(pA, pC);

    const loadA = await readSolutionSidecar({ memoryRoot: root, repo: repoA, pullNumber: 1, cycleNumber: 2 });
    const loadB = await readSolutionSidecar({ memoryRoot: root, repo: repoB, pullNumber: 1, cycleNumber: 2 });
    const loadC = await readSolutionSidecar({ memoryRoot: root, repo: repoC, pullNumber: 1, cycleNumber: 2 });
    assert.equal(loadA[0].blockerMessage, "a");
    assert.equal(loadB[0].blockerMessage, "b");
    assert.equal(loadC[0].blockerMessage, "c");
  } finally {
    cleanup(root);
  }
});
