/**
 * H2 #8 fullchain audit — per-repo blocker-vs-nit calibration.
 *
 * Round-trips override accumulation across multiple PRs on a real
 * on-disk store:
 *
 *   1. PR-A council=rework with category X → user merges → OutcomeWriter
 *      writes calibration[X]=1 to disk.
 *   2. PR-B with same category in retrieval → gate looks up disk
 *      calibration → 1 override → unchanged.
 *   3. Another PR same shape → merges as rework override → calibration[X]=2.
 *   4. Next PR's gate sees count=2 → demotes severity one step.
 *   5. Once more → calibration[X]=3 → gate skips entirely.
 *
 * Verifies the FREE-FORM category round-trips through every layer
 * (recordOverride → load → gate lookup → sticky construction).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FileSystemCalibrationStore,
  FileSystemMemoryStore,
  OutcomeWriter,
  applyFailureGate,
} from "@conclave-ai/core";

function freshFs() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aic-h2-8-fc-"));
}
function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

const REPO = "acme/app";

const reviewWithDebugNoise = ({ severity = "major" } = {}) => ({
  agent: "claude",
  verdict: "rework",
  blockers: [
    {
      severity,
      category: "debug-noise",
      message: "console.log debug call left in production",
      file: "src/x.js",
    },
  ],
  summary: "1 blocker",
});

async function simulateRebornReviewAndOverride({ store, calibration, prNumber }) {
  // PR with the SAME free-form category that ends up rework→merge override.
  const writer = new OutcomeWriter({ store, calibration });
  const ep = await writer.writeReview({
    ctx: {
      diff: "diff --git a/src/x.js b/src/x.js\n+++ b/src/x.js\n+console.log('debug operational frontend production data');",
      repo: REPO,
      pullNumber: prNumber,
      newSha: `sha-${prNumber}`,
    },
    reviews: [reviewWithDebugNoise()],
    councilVerdict: "rework",
    costUsd: 0.01,
    cycleNumber: 1,
  });
  await writer.recordOutcome({ episodicId: ep.id, outcome: "merged" });
}

test("H2 #8 fullchain: 1 override → unchanged sticky severity", async () => {
  const root = freshFs();
  try {
    const store = new FileSystemMemoryStore({ root });
    const calibration = new FileSystemCalibrationStore({ root });

    // Seed catalog with a debug-noise FailureEntry as if a prior reject
    // produced it (mimicking H2 #7 path).
    await store.writeFailure({
      id: "fc-debug",
      createdAt: new Date().toISOString(),
      domain: "code",
      category: "other", // mapCategory("debug-noise") → "other"
      severity: "major",
      title: "console.log debug call left in production",
      body: "Remove console.log debug calls before merging operational frontend production",
      tags: ["debug-noise"],
      seedBlocker: {
        severity: "major",
        category: "debug-noise",
        message: "console.log debug call left",
      },
    });

    // PR-A: rework verdict + user merges → 1 override.
    await simulateRebornReviewAndOverride({ store, calibration, prNumber: 100 });

    const calMap = await calibration.load(REPO, "code");
    assert.equal(calMap.get("debug-noise")?.overrideCount, 1, "first override should land");

    // PR-B: gate runs on a similar diff with calibration loaded.
    const ctxB = {
      diff: "diff --git a/src/y.js b/src/y.js\n+++ b/src/y.js\n+console.log('debug operational frontend production');",
      repo: REPO,
      pullNumber: 101,
      newSha: "sha-B",
    };
    const councilOutcome = {
      verdict: "approve",
      rounds: 1,
      results: [{ agent: "claude", verdict: "approve", blockers: [], summary: "" }],
      consensusReached: true,
    };
    const retrieval = await store.retrieve({ query: ctxB.diff, repo: REPO, k: 8 });
    assert.ok(retrieval.failures.length >= 1, "PR-B retrieval pulls the seeded failure");

    const gateResult = applyFailureGate(councilOutcome, retrieval.failures, ctxB, {
      calibration: calMap,
    });
    assert.equal(gateResult.stickyBlockers.length, 1, "1 override → sticky still fires");
    assert.equal(gateResult.stickyBlockers[0].severity, "major", "severity unchanged at 1 override");
    assert.equal(gateResult.stickyBlockers[0].category, "debug-noise");
  } finally {
    cleanup(root);
  }
});

test("H2 #8 fullchain: 2 overrides → severity demoted one step (major→minor → no verdict escalate)", async () => {
  const root = freshFs();
  try {
    const store = new FileSystemMemoryStore({ root });
    const calibration = new FileSystemCalibrationStore({ root });

    await store.writeFailure({
      id: "fc-debug",
      createdAt: new Date().toISOString(),
      domain: "code",
      category: "other",
      severity: "major",
      title: "console.log debug call",
      body: "Remove console.log debug calls before merging operational frontend production",
      tags: ["debug-noise"],
      seedBlocker: { severity: "major", category: "debug-noise", message: "console.log" },
    });

    // 2 PRs, both rework→merge overrides.
    await simulateRebornReviewAndOverride({ store, calibration, prNumber: 200 });
    await simulateRebornReviewAndOverride({ store, calibration, prNumber: 201 });
    const cal = await calibration.load(REPO, "code");
    assert.equal(cal.get("debug-noise")?.overrideCount, 2);

    const ctxC = {
      diff: "diff --git a/src/z.js b/src/z.js\n+++ b/src/z.js\n+console.log('debug operational frontend production');",
      repo: REPO,
      pullNumber: 202,
      newSha: "sha-C",
    };
    const councilOutcome = {
      verdict: "approve",
      rounds: 1,
      results: [{ agent: "claude", verdict: "approve", blockers: [], summary: "" }],
      consensusReached: true,
    };
    const retrieval = await store.retrieve({ query: ctxC.diff, repo: REPO, k: 8 });
    const gateResult = applyFailureGate(councilOutcome, retrieval.failures, ctxC, {
      calibration: cal,
    });
    assert.equal(gateResult.stickyBlockers.length, 1, "2 overrides on major still injects (demoted)");
    assert.equal(gateResult.stickyBlockers[0].severity, "minor", "major → minor at 2 overrides");
    // Minor sticky doesn't escalate council verdict per H2 #8 design.
    assert.equal(gateResult.outcome.verdict, "approve");
    assert.match(
      gateResult.stickyBlockers[0].message,
      /demoted major→minor/,
      "demote note should mention the strength reduction",
    );
  } finally {
    cleanup(root);
  }
});

test("H2 #8 fullchain: 3 overrides → gate skips entirely + reports calibrationSkips", async () => {
  const root = freshFs();
  try {
    const store = new FileSystemMemoryStore({ root });
    const calibration = new FileSystemCalibrationStore({ root });

    await store.writeFailure({
      id: "fc-debug",
      createdAt: new Date().toISOString(),
      domain: "code",
      category: "other",
      severity: "major",
      title: "console.log debug call",
      body: "Remove console.log debug calls before merging operational frontend production",
      tags: ["debug-noise"],
      seedBlocker: { severity: "major", category: "debug-noise", message: "console.log" },
    });

    for (let pr = 300; pr < 303; pr += 1) {
      await simulateRebornReviewAndOverride({ store, calibration, prNumber: pr });
    }
    const cal = await calibration.load(REPO, "code");
    assert.equal(cal.get("debug-noise")?.overrideCount, 3);

    const ctxD = {
      diff: "diff --git a/src/w.js b/src/w.js\n+++ b/src/w.js\n+console.log('debug operational frontend production');",
      repo: REPO,
      pullNumber: 303,
      newSha: "sha-D",
    };
    const councilOutcome = {
      verdict: "approve",
      rounds: 1,
      results: [{ agent: "claude", verdict: "approve", blockers: [], summary: "" }],
      consensusReached: true,
    };
    const retrieval = await store.retrieve({ query: ctxD.diff, repo: REPO, k: 8 });
    const gateResult = applyFailureGate(councilOutcome, retrieval.failures, ctxD, {
      calibration: cal,
    });
    assert.equal(gateResult.stickyBlockers.length, 0, "3+ overrides → skip entirely");
    assert.equal(gateResult.calibrationSkips.length, 1);
    assert.equal(gateResult.calibrationSkips[0].category, "debug-noise");
    assert.equal(gateResult.calibrationSkips[0].overrideCount, 3);
    assert.equal(gateResult.outcome.verdict, "approve");
  } finally {
    cleanup(root);
  }
});

test("H2 #8 fullchain: calibration written under FREE-FORM key matches gate lookup key (round-trip)", async () => {
  // The exact bug the H2 QA fix initially addressed — and that the H2 #7
  // audit just expanded to alreadyCoveredByCouncil. This test pins it
  // down: the on-disk file's key must match what the gate looks up.
  const root = freshFs();
  try {
    const store = new FileSystemMemoryStore({ root });
    const calibration = new FileSystemCalibrationStore({ root });

    await simulateRebornReviewAndOverride({ store, calibration, prNumber: 1 });

    // Inspect the on-disk file directly.
    const file = path.join(root, "calibration", "code", "acme__app.json");
    assert.ok(fs.existsSync(file));
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.ok("debug-noise" in saved, `expected key 'debug-noise' on disk; got ${Object.keys(saved).join(",")}`);
    assert.equal(saved["debug-noise"].overrideCount, 1);
    assert.ok(!("other" in saved), "must NOT key under the enum-coerced 'other'");
  } finally {
    cleanup(root);
  }
});

test("H2 #8 fullchain: per-PR scoping — calibration counts only count once per PR even with multiple agents flagging same category", async () => {
  const root = freshFs();
  try {
    const store = new FileSystemMemoryStore({ root });
    const calibration = new FileSystemCalibrationStore({ root });
    const writer = new OutcomeWriter({ store, calibration });

    // 2 agents both raise debug-noise on the same PR. Recording the
    // override should only bump the counter by 1 (not 2 — that would
    // double-charge a single user click).
    const ep = await writer.writeReview({
      ctx: {
        diff: "+console.log('debug operational frontend production');",
        repo: REPO,
        pullNumber: 500,
        newSha: "sha",
      },
      reviews: [
        {
          agent: "claude",
          verdict: "rework",
          blockers: [
            { severity: "major", category: "debug-noise", message: "console.log" },
          ],
          summary: "",
        },
        {
          agent: "openai",
          verdict: "rework",
          blockers: [
            { severity: "major", category: "debug-noise", message: "same console.log" },
          ],
          summary: "",
        },
      ],
      councilVerdict: "rework",
      costUsd: 0.02,
      cycleNumber: 1,
    });
    await writer.recordOutcome({ episodicId: ep.id, outcome: "merged" });

    const cal = await calibration.load(REPO, "code");
    assert.equal(
      cal.get("debug-noise")?.overrideCount,
      1,
      "multi-agent same-category should NOT double-count overrides per merge",
    );
  } finally {
    cleanup(root);
  }
});
