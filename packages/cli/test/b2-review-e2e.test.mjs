/**
 * Phase B.2 — review pipeline E2E on a real fixture install.
 *
 * Composes runInit + review.ts's pipeline pieces (without invoking the
 * full review() function which needs API keys) on a fresh fixture
 * git repo. Verifies that everything wires together when sharing a
 * real on-disk install:
 *
 *   - runInit produces a config the review path can load.
 *   - applyDeployGuard + applyFailureGate + calibration + score
 *     routing + catch-regression + episodic chain + notif-ledger all
 *     coexist in one pass.
 *   - Disk artifacts after the pipeline are exactly what
 *     record-outcome / next-PR retrieval expect.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
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
  detectCatchRegressions,
  newEpisodicId,
  writeCatchRegression,
} from "@conclave-ai/core";
import { runInit } from "../dist/commands/init.js";
import { loadConfig, resolveMemoryRoot } from "../dist/lib/config.js";
import { applyDeployGuard } from "../dist/lib/deploy-guard.js";
import {
  checkAndRecordNotification,
  computeFingerprint,
} from "../dist/lib/notification-ledger.js";

function freshGitRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aic-b2-"));
  execSync("git init -q", { cwd: root });
  execSync('git config user.email "test@test"', { cwd: root });
  execSync('git config user.name "test"', { cwd: root });
  execSync("git remote add origin https://github.com/acme/fixture-app.git", { cwd: root });
  return root;
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

test("B.2: full pipeline on init'd fixture — review → gate → calibration → record-outcome → ledger", async () => {
  const repoRoot = freshGitRepo();
  try {
    // Stage 1: install conclave on the fixture.
    const exit = await runInit(
      { yes: true, reconfigure: false, cwd: repoRoot, skipOauth: true, help: false },
      { stdout: () => {}, stderr: () => {} },
    );
    assert.equal(exit, 0);

    // Stage 2: load config the way review.ts does.
    const { config, configDir } = await loadConfig(repoRoot);
    const memoryRoot = resolveMemoryRoot(config, configDir);
    const memory = new FileSystemMemoryStore({ root: memoryRoot });
    const calibration = new FileSystemCalibrationStore({ root: memoryRoot });

    // Stage 3: seed a prior failure entry as if a previous PR landed it.
    await memory.writeFailure({
      id: "fc-debug",
      createdAt: new Date().toISOString(),
      domain: "code",
      category: "other",
      severity: "major",
      title: "console.log debug call left in production",
      body: "Remove console.log debug calls before merging operational frontend production",
      tags: ["debug-noise"],
      seedBlocker: { severity: "major", category: "debug-noise", message: "console.log left" },
    });

    // Stage 4: build a council of FakeAgents that mimic real agents.
    // claude approves, openai approves, council verdict = approve.
    // The diff DOES contain a console.log but the council misses it.
    const council = new Council({
      agents: [
        new FakeAgent("claude", async () => ({ agent: "claude", verdict: "approve", blockers: [], summary: "looks ok" })),
        new FakeAgent("openai", async () => ({ agent: "openai", verdict: "approve", blockers: [], summary: "ok" })),
      ],
      maxRounds: 1,
      enableDebate: false,
      agentWeights: deriveAgentWeights(await computeAllAgentScores(memory)),
    });

    const ctx = {
      diff: [
        "diff --git a/src/x.js b/src/x.js",
        "+++ b/src/x.js",
        "@@ -1,1 +1,2 @@",
        " const x = 1;",
        "+console.log('debug operational frontend production');",
      ].join("\n"),
      repo: "acme/fixture-app",
      pullNumber: 42,
      newSha: "sha-A",
      deployStatus: "success", // green deploy
    };

    const rawOutcome = await council.deliberate(ctx);
    assert.equal(rawOutcome.verdict, "approve");

    // Stage 5: deploy-guard pass-through (deploy success).
    const guardOut = applyDeployGuard(rawOutcome, "success");
    assert.equal(guardOut.applied, false);

    // Stage 6: failure-gate catches what council missed.
    const retrieval = await memory.retrieve({ query: ctx.diff, repo: ctx.repo, k: 8 });
    const calMap = await calibration.load(ctx.repo, "code");
    const gateOut = applyFailureGate(guardOut.outcome, retrieval.failures, ctx, {
      minTokenOverlap: 2,
      calibration: calMap,
    });
    assert.equal(gateOut.stickyBlockers.length, 1, "gate must catch the seeded debug-noise pattern");
    assert.equal(gateOut.outcome.verdict, "rework", "gate sticky escalates approve → rework");

    // Stage 7: catch-regression detector runs (relaxed) — should NOT
    // add anything since the gate already caught it (same category).
    const regs = detectCatchRegressions({
      outcome: gateOut.outcome,
      ctx: { diff: ctx.diff },
      retrievedFailures: retrieval.failures,
    });
    assert.equal(regs.length, 0, "regression detector skips what gate already raised");

    // Stage 8: persist episodic via OutcomeWriter (the same path
    // review.ts uses).
    const episodicId = newEpisodicId();
    const writer = new OutcomeWriter({ store: memory, calibration });
    const ep = await writer.writeReview({
      ctx,
      reviews: gateOut.outcome.results,
      councilVerdict: gateOut.outcome.verdict,
      costUsd: 0.05,
      episodicId,
      cycleNumber: 1,
    });
    assert.equal(ep.id, episodicId);
    assert.equal(ep.cycleNumber, 1);

    // Verify on-disk artifact.
    const epFiles = fs
      .readdirSync(path.join(memoryRoot, "episodic"), { recursive: true })
      .filter((f) => typeof f === "string" && f.endsWith(".json"));
    assert.ok(epFiles.length >= 1, "episodic file must be on disk under .conclave/episodic/");

    // Stage 9: notification ledger dedup invariant.
    const fp = computeFingerprint({
      episodicId,
      verdict: gateOut.outcome.verdict,
      blockerCount: 1,
      reworkCycle: 0,
    });
    const first = await checkAndRecordNotification({
      memoryRoot,
      episodicId,
      fingerprint: fp,
    });
    assert.equal(first.alreadySent, false, "first notify-attempt must pass");
    const second = await checkAndRecordNotification({
      memoryRoot,
      episodicId,
      fingerprint: fp,
    });
    assert.equal(second.alreadySent, true, "second notify-attempt MUST be dedup'd (B.4b invariant)");

    // Stage 10: simulate user merging the rework verdict (override).
    // calibration must record an override.
    await writer.recordOutcome({ episodicId, outcome: "merged" });
    const calAfter = await calibration.load(ctx.repo, "code");
    assert.ok(
      calAfter.has("debug-noise"),
      `calibration override must be recorded under the free-form category — got categories ${[...calAfter.keys()].join(",")}`,
    );
  } finally {
    cleanup(repoRoot);
  }
});

test("B.2: deploy=failure pipeline — guard fires + downstream sees rework + episodic carries reject signal", async () => {
  const repoRoot = freshGitRepo();
  try {
    await runInit(
      { yes: true, reconfigure: false, cwd: repoRoot, skipOauth: true, help: false },
      { stdout: () => {}, stderr: () => {} },
    );
    const { config, configDir } = await loadConfig(repoRoot);
    const memoryRoot = resolveMemoryRoot(config, configDir);
    const memory = new FileSystemMemoryStore({ root: memoryRoot });

    // Council CLEAN approve — but deploy is red.
    const council = new Council({
      agents: [
        new FakeAgent("claude", async () => ({ agent: "claude", verdict: "approve", blockers: [], summary: "looks fine" })),
      ],
      maxRounds: 1,
      enableDebate: false,
    });
    const ctx = {
      diff: "+++ b/x.js\n+const x = 1;\n",
      repo: "acme/fixture-app",
      pullNumber: 99,
      newSha: "sha-deploy-red",
    };
    const rawOutcome = await council.deliberate(ctx);
    assert.equal(rawOutcome.verdict, "approve");

    const guardOut = applyDeployGuard(rawOutcome, "failure");
    assert.equal(guardOut.applied, true, "deploy=failure must downgrade approve");
    assert.equal(guardOut.outcome.verdict, "rework");

    // Episodic must persist with the corrected verdict so the merge
    // UI button reflects "rework" and not "ready".
    const writer = new OutcomeWriter({ store: memory });
    const ep = await writer.writeReview({
      ctx,
      reviews: guardOut.outcome.results,
      councilVerdict: guardOut.outcome.verdict, // ← CORRECTED, not raw
      costUsd: 0.02,
      cycleNumber: 1,
    });
    assert.equal(ep.councilVerdict, "rework", "persisted verdict reflects deploy-guard, not raw council");
  } finally {
    cleanup(repoRoot);
  }
});
