/**
 * H2 end-to-end pipeline integration test.
 *
 * Wires together the H2 components in the same order review.ts does:
 *   1. Retrieve answer-keys + failures from memory store (H2 #6 RAG path)
 *   2. Compute agent scores → derive weights (H2 #10)
 *   3. Build Council with weights
 *   4. (Optional) split diff into chunks (H2 #9)
 *   5. Deliberate
 *   6. Apply failure-catalog gate with calibration (H2 #7 + H2 #8)
 *   7. recordOutcome on merge → walks priors → answer-key with removed-blockers
 *
 * Catches wiring bugs that unit tests in isolation miss:
 *   - import / export mismatches between modules
 *   - field-name drift (e.g. ReviewContext shape changes)
 *   - default-config changes that break the integration assumptions
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Council,
  FileSystemCalibrationStore,
  FileSystemMemoryStore,
  OutcomeWriter,
  applyFailureGate,
  computeAllAgentScores,
  deriveAgentWeights,
  integrateChunkOutcomes,
  splitDiff,
} from "../dist/index.js";

function freshFs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aic-h2-pipeline-"));
  return { root };
}
function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

class FakeAgent {
  constructor(id, behavior) {
    this.id = id;
    this.displayName = id;
    this.behavior = behavior;
  }
  async review(ctx) {
    return this.behavior(ctx);
  }
}

const REPO = "acme/app";

test("H2 pipeline: full flow on a small diff — RAG + gate + calibration + score weights", async () => {
  const { root } = freshFs();
  try {
    const memory = new FileSystemMemoryStore({ root });
    const calibrationStore = new FileSystemCalibrationStore({ root });

    // — Seed memory: a failure-catalog entry that should match our diff.
    //   In production, classifier.mapCategory normalizes free-form
    //   blocker categories to the closed enum, and seedBlocker preserves
    //   the original. We mirror that shape.
    await memory.writeFailure({
      id: "fc-debug-noise",
      createdAt: new Date().toISOString(),
      domain: "code",
      category: "other", // mapCategory("debug-noise") → "other"
      severity: "major",
      title: "console.log debug calls left in production code",
      body: "Remove console.log debug calls before merging — they leak operational data.",
      tags: ["debug-noise"],
      seedBlocker: {
        severity: "major",
        category: "debug-noise", // free-form preserved
        message: "console.log debug call left in",
      },
    });

    // — Seed memory: an answer-key with removed-blockers (H2 #6 history).
    await memory.writeAnswerKey({
      id: "ak-merged-prior",
      createdAt: new Date().toISOString(),
      domain: "code",
      pattern: `by-repo/${REPO}`,
      lesson: "merged after rework",
      tags: ["debug-noise"],
      repo: REPO,
      removedBlockers: [
        { category: "debug-noise", severity: "major", message: "earlier console.log fix" },
      ],
    });

    // — Seed memory: episodic history for the score computer.
    //    `noisy` agent has rejected lots of merged PRs (low score);
    //    `trusted` agent's approves merged successfully (high score).
    for (let i = 0; i < 10; i += 1) {
      await memory.writeEpisodic({
        id: `ep-hist-${i}`,
        createdAt: new Date().toISOString(),
        repo: REPO,
        pullNumber: 100 + i,
        sha: `sha${i}`,
        diffSha256: "0".repeat(64),
        reviews: [
          { agent: "trusted", verdict: "approve", blockers: [], summary: "ok" },
          {
            agent: "noisy",
            verdict: "reject",
            blockers: [{ severity: "blocker", category: "x", message: "false alarm" }],
            summary: "no",
          },
        ],
        councilVerdict: "reject",
        outcome: "merged", // user overrode noisy → noisy's score drops
        costUsd: 0.01,
        cycleNumber: 1,
      });
    }

    // — Step 1: retrieve RAG context.
    const retrieval = await memory.retrieve({ query: "console.log debug noise", repo: REPO, k: 8 });
    assert.equal(retrieval.failures.length, 1);
    assert.equal(retrieval.answerKeys.length, 1);

    // — Step 2: compute scores + derive weights. With 10 samples, both
    //   agents pass the minSamples threshold; noisy's score should be
    //   below 0.5 (its rejects on merged PRs hurt buildPass).
    const scores = await computeAllAgentScores(memory);
    assert.ok(scores.length >= 2, `expected ≥2 agents in scores, got ${scores.length}`);
    const weights = deriveAgentWeights(scores);
    const noisyWeight = weights.get("noisy");
    assert.ok(noisyWeight !== undefined && noisyWeight < 0.5, `noisy weight should < 0.5, got ${noisyWeight}`);

    // — Step 3 + 4: build council. Tier-1 only flat council with score weights.
    const council = new Council({
      agents: [
        new FakeAgent("trusted", async () => ({
          agent: "trusted",
          verdict: "approve",
          blockers: [],
          summary: "looks fine",
        })),
        // Noisy rejects this PR — but its score should demote that to rework.
        new FakeAgent("noisy", async () => ({
          agent: "noisy",
          verdict: "reject",
          blockers: [{ severity: "blocker", category: "trivia", message: "false alarm" }],
          summary: "block",
        })),
      ],
      maxRounds: 1,
      enableDebate: false,
      agentWeights: weights,
    });

    // — Step 5: deliberate over a small diff (under splitter threshold).
    const smallDiff = [
      "diff --git a/x.js b/x.js",
      "index abc..def 100644",
      "--- a/x.js",
      "+++ b/x.js",
      "@@ -1,1 +1,2 @@",
      " const x = 1;",
      "+console.log('debug operational data frontend production');",
    ].join("\n") + "\n";

    const reviewCtx = {
      diff: smallDiff,
      repo: REPO,
      pullNumber: 42,
      newSha: "head-sha",
      answerKeys: retrieval.answerKeys.map((k) => `${k.pattern}: ${k.lesson}`),
      failureCatalog: retrieval.failures.map((f) => `${f.category}: ${f.title}`),
    };

    const rawOutcome = await council.deliberate(reviewCtx);
    // Without weighting, noisy's reject would block. With weighting (H2 #10),
    // it should be demoted to rework.
    assert.equal(rawOutcome.verdict, "rework", `score weights should demote noisy reject; got ${rawOutcome.verdict}`);

    // — Step 6: apply failure gate (no calibration yet — first time this category lands).
    const calibration = await calibrationStore.load(REPO, "code");
    const gateOutput = applyFailureGate(rawOutcome, retrieval.failures, reviewCtx, {
      calibration,
    });
    // The diff contains "console", "operational", "production", "frontend" tokens;
    // the failure body shares >=2 of those. Sticky should fire.
    assert.equal(gateOutput.stickyBlockers.length, 1, "failure gate should match the seeded debug-noise pattern");
    // Sticky carries the (mapped) failure category. Test by content
    // since mapCategory may evolve.
    assert.match(gateOutput.stickyBlockers[0].message, /console\.log/);
    // Verdict was "rework" (from low-trust agent) → unchanged by major sticky.
    assert.equal(gateOutput.outcome.verdict, "rework");

    // — Step 7: write episodic + record merge → calibration override gets recorded.
    const writer = new OutcomeWriter({ store: memory, calibration: calibrationStore });
    const ep = await writer.writeReview({
      ctx: reviewCtx,
      reviews: gateOutput.outcome.results,
      councilVerdict: gateOutput.outcome.verdict,
      costUsd: 0.05,
      cycleNumber: 1,
    });
    await writer.recordOutcome({ episodicId: ep.id, outcome: "merged" });

    // The merge on a "rework" verdict means the user overrode — calibration
    // should now have an entry for debug-noise.
    const calAfter = await calibrationStore.load(REPO, "code");
    assert.ok(
      calAfter.has("debug-noise"),
      `expected debug-noise calibration after merge override, got categories ${[...calAfter.keys()].join(",")}`,
    );
    assert.equal(calAfter.get("debug-noise").overrideCount, 1);

    // — Re-run the gate with NEW calibration: still 1 override, still full strength.
    //   (calibration kicks in at 2 overrides per H2 #8 step-function.)
    const gateOutput2 = applyFailureGate(rawOutcome, retrieval.failures, reviewCtx, {
      calibration: calAfter,
    });
    assert.equal(gateOutput2.stickyBlockers.length, 1, "1 override still full strength");

    // — After 2 more overrides (3 total), gate should skip.
    for (let i = 0; i < 2; i += 1) {
      await calibrationStore.recordOverride({
        repo: REPO,
        domain: "code",
        category: "debug-noise",
      });
    }
    const calFull = await calibrationStore.load(REPO, "code");
    assert.equal(calFull.get("debug-noise").overrideCount, 3);
    const gateOutput3 = applyFailureGate(rawOutcome, retrieval.failures, reviewCtx, {
      calibration: calFull,
    });
    assert.equal(gateOutput3.stickyBlockers.length, 0, "3 overrides should skip the sticky");
    assert.equal(gateOutput3.calibrationSkips.length, 1);
  } finally {
    cleanup(root);
  }
});

test("H2 pipeline: large diff routes through splitter then integrates correctly", async () => {
  const { root } = freshFs();
  try {
    const memory = new FileSystemMemoryStore({ root });
    const calibrationStore = new FileSystemCalibrationStore({ root });

    // Build a large multi-file diff that exceeds the default 500-line threshold.
    const fileBlock = (name, lines) => {
      const body = Array.from({ length: lines }, (_, i) => `+line ${i}`).join("\n");
      return [
        `diff --git a/${name} b/${name}`,
        `index abc..def 100644`,
        `--- a/${name}`,
        `+++ b/${name}`,
        `@@ -1,1 +1,${lines} @@`,
        body,
      ].join("\n") + "\n";
    };
    const bigDiff = fileBlock("a.ts", 300) + fileBlock("b.ts", 300) + fileBlock("c.ts", 300);
    const chunks = splitDiff(bigDiff, { maxLinesPerChunk: 500 });
    assert.ok(chunks.length >= 2, `expected splitter to produce ≥ 2 chunks, got ${chunks.length}`);

    // Build a council that approves chunk-by-chunk.
    const council = new Council({
      agents: [
        new FakeAgent("claude", async (ctx) => ({
          agent: "claude",
          verdict: "approve",
          blockers: [],
          summary: `chunk approved (${ctx.diff.split("\n").length} lines)`,
        })),
      ],
      maxRounds: 1,
      enableDebate: false,
    });
    const baseCtx = {
      diff: "",
      repo: REPO,
      pullNumber: 7,
      newSha: "head-sha",
    };
    const chunkOutcomes = [];
    for (const chunk of chunks) {
      chunkOutcomes.push(await council.deliberate({ ...baseCtx, diff: chunk.diff }));
    }
    const integrated = integrateChunkOutcomes(chunkOutcomes);
    assert.equal(integrated.verdict, "approve");
    const claude = integrated.results.find((r) => r.agent === "claude");
    assert.match(claude.summary, /chunk approved/);

    // Per-agent merge means we should have one combined "claude" entry.
    assert.equal(integrated.results.length, 1);

    // Episodic write captures the integrated verdict.
    const writer = new OutcomeWriter({ store: memory, calibration: calibrationStore });
    const ep = await writer.writeReview({
      ctx: { ...baseCtx, diff: bigDiff },
      reviews: integrated.results,
      councilVerdict: integrated.verdict,
      costUsd: 0.15,
      cycleNumber: 1,
    });
    assert.equal(ep.councilVerdict, "approve");
  } finally {
    cleanup(root);
  }
});

test("H2 pipeline: removed-blockers chain on merge produces an enriched answer-key", async () => {
  const { root } = freshFs();
  try {
    const memory = new FileSystemMemoryStore({ root });
    const writer = new OutcomeWriter({ store: memory });

    // Cycle 1: review with a blocker.
    const cycle1 = await writer.writeReview({
      ctx: {
        diff: "diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@ -1,1 +1,2 @@\n+console.log('debug');\n",
        repo: REPO,
        pullNumber: 42,
        newSha: "sha-c1",
      },
      reviews: [
        {
          agent: "claude",
          verdict: "rework",
          blockers: [
            { severity: "major", category: "debug-noise", message: "console.log left in" },
          ],
          summary: "1 blocker",
        },
      ],
      councilVerdict: "rework",
      costUsd: 0.05,
      cycleNumber: 1,
    });

    // Cycle 2: clean re-review after autofix; merge.
    const cycle2 = await writer.writeReview({
      ctx: {
        diff: "diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@ -1,2 +1,1 @@\n-console.log('debug');\n",
        repo: REPO,
        pullNumber: 42,
        newSha: "sha-c2",
      },
      reviews: [{ agent: "claude", verdict: "approve", blockers: [], summary: "LGTM" }],
      councilVerdict: "approve",
      costUsd: 0.02,
      cycleNumber: 2,
      priorEpisodicId: cycle1.id,
    });
    const out = await writer.recordOutcome({ episodicId: cycle2.id, outcome: "merged" });

    assert.equal(out.answerKeys.length, 1);
    const ak = out.answerKeys[0];
    assert.equal(ak.removedBlockers.length, 1);
    assert.equal(ak.removedBlockers[0].category, "debug-noise");
    assert.match(ak.removedBlockers[0].message, /console\.log/);
    // Lesson surfaces the resolved-before-merge phrase.
    assert.match(ak.lesson, /Resolved before merge/);
  } finally {
    cleanup(root);
  }
});
