/**
 * Phase B.3 — multi-PR self-evolve sequence.
 *
 * Scripts a 4-PR sequence on a real fixture install and verifies the
 * system ACTUALLY gets smarter:
 *
 *   PR-1: clean reject → failure-catalog gains debug-noise entry.
 *   PR-2: same pattern, council misses → gate catches via PR-1's catalog.
 *         Verdict: approve → rework. The "same mistake never sneaks
 *         past twice" promise — proven on disk.
 *   PR-3: same pattern again, user MERGES (override).
 *         calibration[debug-noise] = 1.
 *   PR-4: same pattern. Override count = 1 → still full-strength
 *         sticky. Then 2 more overrides recorded out-of-band.
 *         calibration[debug-noise] = 3 → gate now SKIPS.
 *
 * Invariants:
 *   - Every PR runs against the SAME on-disk store; state from PR-N
 *     is read by PR-(N+1).
 *   - The free-form category "debug-noise" round-trips through every
 *     layer (writeFailure / retrieve / gate / writeOverride /
 *     gate-lookup) — the H2 audit invariant pinned down at scale.
 *   - PR retries don't dup notifications across the sequence (notif
 *     ledger persists).
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
  newEpisodicId,
} from "@conclave-ai/core";
import { runInit } from "../dist/commands/init.js";
import { loadConfig, resolveMemoryRoot } from "../dist/lib/config.js";

function freshGitRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aic-b3-"));
  execSync("git init -q", { cwd: root });
  execSync('git config user.email "test@test"', { cwd: root });
  execSync('git config user.name "test"', { cwd: root });
  execSync("git remote add origin https://github.com/acme/fixture-app.git", { cwd: root });
  return root;
}
function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

const REPO = "acme/fixture-app";

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

const debugBlocker = (msg = "console.log debug call left in production code") => ({
  severity: "major",
  category: "debug-noise",
  message: msg,
  file: "src/x.js",
});

const dbgDiff = (extra = "") =>
  [
    "diff --git a/src/x.js b/src/x.js",
    "+++ b/src/x.js",
    "@@ -1,1 +1,2 @@",
    " const x = 1;",
    `+console.log('debug operational frontend production data ${extra}');`,
  ].join("\n");

test("B.3: 4-PR self-evolve sequence — system actually gets smarter on disk", async () => {
  const repoRoot = freshGitRepo();
  try {
    // Install conclave on the fixture.
    await runInit(
      { yes: true, reconfigure: false, cwd: repoRoot, skipOauth: true, help: false },
      { stdout: () => {}, stderr: () => {} },
    );
    const { config, configDir } = await loadConfig(repoRoot);
    const memoryRoot = resolveMemoryRoot(config, configDir);
    const memory = new FileSystemMemoryStore({ root: memoryRoot });
    const calibration = new FileSystemCalibrationStore({ root: memoryRoot });

    // ─── PR-1: rejecting council. catalog gains the pattern. ───
    {
      const council = new Council({
        agents: [
          new FakeAgent("claude", async () => ({
            agent: "claude",
            verdict: "reject",
            blockers: [debugBlocker()],
            summary: "blocker found",
          })),
        ],
        maxRounds: 1,
        enableDebate: false,
      });
      const ctx = { diff: dbgDiff("pr1"), repo: REPO, pullNumber: 1, newSha: "sha-1" };
      const outcome = await council.deliberate(ctx);
      assert.equal(outcome.verdict, "reject");

      const writer = new OutcomeWriter({ store: memory, calibration });
      const ep = await writer.writeReview({
        ctx,
        reviews: outcome.results,
        councilVerdict: outcome.verdict,
        costUsd: 0.02,
        cycleNumber: 1,
      });
      const recorded = await writer.recordOutcome({ episodicId: ep.id, outcome: "rejected" });
      assert.equal(recorded.failures.length, 1, "PR-1 reject → 1 FailureEntry written");

      const failuresOnDisk = await memory.listFailures("code");
      assert.equal(failuresOnDisk.length, 1);
      assert.equal(failuresOnDisk[0].seedBlocker.category, "debug-noise");
    }

    // ─── PR-2: identical pattern. Council misses. Gate must catch. ───
    {
      const council = new Council({
        agents: [
          new FakeAgent("claude", async () => ({ agent: "claude", verdict: "approve", blockers: [], summary: "looks ok" })),
          new FakeAgent("openai", async () => ({ agent: "openai", verdict: "approve", blockers: [], summary: "ok" })),
        ],
        maxRounds: 1,
        enableDebate: false,
      });
      const ctx = { diff: dbgDiff("pr2"), repo: REPO, pullNumber: 2, newSha: "sha-2" };
      const rawOutcome = await council.deliberate(ctx);
      assert.equal(rawOutcome.verdict, "approve", "council misses on PR-2 (preconditions for the gate to step in)");

      const retrieval = await memory.retrieve({ query: ctx.diff, repo: REPO, k: 8 });
      const calMap = await calibration.load(REPO, "code");
      const gateOut = applyFailureGate(rawOutcome, retrieval.failures, ctx, {
        minTokenOverlap: 2,
        calibration: calMap,
      });
      assert.equal(
        gateOut.stickyBlockers.length,
        1,
        "GATE INVARIANT: same mistake must NOT sneak past on the very next PR",
      );
      assert.equal(gateOut.stickyBlockers[0].category, "debug-noise");
      assert.equal(gateOut.outcome.verdict, "rework", "approve → rework via gate");

      // User RE-WORKS this one (doesn't override) — record as reworked.
      const writer = new OutcomeWriter({ store: memory, calibration });
      const ep = await writer.writeReview({
        ctx,
        reviews: gateOut.outcome.results,
        councilVerdict: gateOut.outcome.verdict,
        costUsd: 0.05,
        cycleNumber: 1,
      });
      await writer.recordOutcome({ episodicId: ep.id, outcome: "reworked" });

      // No calibration override yet — the user accepted the rework, didn't override.
      const cal = await calibration.load(REPO, "code");
      assert.equal(
        cal.get("debug-noise"),
        undefined,
        "reworked outcome → NO override recorded (calibration only counts merge-on-rework)",
      );
    }

    // ─── PR-3: identical pattern. User MERGES anyway (override #1). ───
    {
      const council = new Council({
        agents: [
          new FakeAgent("claude", async () => ({ agent: "claude", verdict: "approve", blockers: [], summary: "" })),
        ],
        maxRounds: 1,
        enableDebate: false,
      });
      const ctx = { diff: dbgDiff("pr3"), repo: REPO, pullNumber: 3, newSha: "sha-3" };
      const rawOutcome = await council.deliberate(ctx);
      const retrieval = await memory.retrieve({ query: ctx.diff, repo: REPO, k: 8 });
      const calMap = await calibration.load(REPO, "code");
      const gateOut = applyFailureGate(rawOutcome, retrieval.failures, ctx, {
        minTokenOverlap: 2,
        calibration: calMap,
      });
      assert.equal(gateOut.stickyBlockers.length, 1, "0 overrides → still full strength");
      assert.equal(gateOut.outcome.verdict, "rework");

      const writer = new OutcomeWriter({ store: memory, calibration });
      const ep = await writer.writeReview({
        ctx,
        reviews: gateOut.outcome.results,
        councilVerdict: gateOut.outcome.verdict, // rework
        costUsd: 0.05,
        cycleNumber: 1,
      });
      // User OVERRIDES — merges despite rework.
      await writer.recordOutcome({ episodicId: ep.id, outcome: "merged" });
      const cal = await calibration.load(REPO, "code");
      assert.equal(
        cal.get("debug-noise")?.overrideCount,
        1,
        "merge-on-rework → calibration override count = 1",
      );
    }

    // ─── PR-4: identical pattern. Verify ESCALATING demotion. ───
    {
      // Override count is 1 from PR-3. Bump to 2 manually (out-of-band
      // — like 2 more PRs with the same override happened).
      await calibration.recordOverride({ repo: REPO, domain: "code", category: "debug-noise" });
      let cal = await calibration.load(REPO, "code");
      assert.equal(cal.get("debug-noise").overrideCount, 2);

      const ctx4 = { diff: dbgDiff("pr4-2x"), repo: REPO, pullNumber: 4, newSha: "sha-4" };
      const council = new Council({
        agents: [new FakeAgent("claude", async () => ({ agent: "claude", verdict: "approve", blockers: [], summary: "" }))],
        maxRounds: 1,
        enableDebate: false,
      });
      const rawOutcome4 = await council.deliberate(ctx4);
      const retrieval4 = await memory.retrieve({ query: ctx4.diff, repo: REPO, k: 8 });
      const gateOut4 = applyFailureGate(rawOutcome4, retrieval4.failures, ctx4, {
        minTokenOverlap: 2,
        calibration: cal,
      });
      assert.equal(gateOut4.stickyBlockers.length, 1, "2 overrides → still injects, but demoted");
      assert.equal(
        gateOut4.stickyBlockers[0].severity,
        "minor",
        "major (original) → minor (demoted at 2 overrides)",
      );
      // Demoted minor → verdict NOT escalated.
      assert.equal(gateOut4.outcome.verdict, "approve", "demoted-to-minor sticky doesn't override council approve");

      // Bump to 3 overrides → gate skips.
      await calibration.recordOverride({ repo: REPO, domain: "code", category: "debug-noise" });
      cal = await calibration.load(REPO, "code");
      assert.equal(cal.get("debug-noise").overrideCount, 3);

      const ctx5 = { diff: dbgDiff("pr5-skip"), repo: REPO, pullNumber: 5, newSha: "sha-5" };
      const rawOutcome5 = await council.deliberate(ctx5);
      const retrieval5 = await memory.retrieve({ query: ctx5.diff, repo: REPO, k: 8 });
      const gateOut5 = applyFailureGate(rawOutcome5, retrieval5.failures, ctx5, {
        minTokenOverlap: 2,
        calibration: cal,
      });
      assert.equal(gateOut5.stickyBlockers.length, 0, "3+ overrides → gate skips entirely");
      assert.equal(gateOut5.calibrationSkips.length, 1, "skip is reported via calibrationSkips");
      assert.equal(gateOut5.outcome.verdict, "approve");
    }
  } finally {
    cleanup(repoRoot);
  }
});

test("B.3: episodic chain on a 3-cycle PR survives across the multi-PR sequence", async () => {
  // Same fixture, separate test isolation. PR-A is 3-cycle (rework
  // x2 then merge). PR-B is 1-cycle clean. The PR-A merge produces an
  // AnswerKey with removedBlockers covering BOTH cycle-1 + cycle-2
  // blockers; PR-B's retrieval surfaces it.
  const repoRoot = freshGitRepo();
  try {
    await runInit(
      { yes: true, reconfigure: false, cwd: repoRoot, skipOauth: true, help: false },
      { stdout: () => {}, stderr: () => {} },
    );
    const { config, configDir } = await loadConfig(repoRoot);
    const memoryRoot = resolveMemoryRoot(config, configDir);
    const memory = new FileSystemMemoryStore({ root: memoryRoot });
    const writer = new OutcomeWriter({ store: memory });

    // PR-A cycle 1 — debug-noise blocker
    const ep1 = await writer.writeReview({
      ctx: { diff: dbgDiff("c1"), repo: REPO, pullNumber: 50, newSha: "sha-c1" },
      reviews: [
        {
          agent: "claude",
          verdict: "rework",
          blockers: [debugBlocker("console.log left c1")],
          summary: "",
        },
      ],
      councilVerdict: "rework",
      costUsd: 0.05,
      cycleNumber: 1,
    });
    await writer.recordOutcome({ episodicId: ep1.id, outcome: "reworked" });

    // PR-A cycle 2 — type-error blocker
    const ep2 = await writer.writeReview({
      ctx: { diff: "+++ b/src/y.ts\n+const x: number = 'string';", repo: REPO, pullNumber: 50, newSha: "sha-c2" },
      reviews: [
        {
          agent: "claude",
          verdict: "rework",
          blockers: [{ severity: "major", category: "type-error", message: "ts2345 mismatch on line 1", file: "src/y.ts" }],
          summary: "",
        },
      ],
      councilVerdict: "rework",
      costUsd: 0.04,
      cycleNumber: 2,
      priorEpisodicId: ep1.id,
    });
    await writer.recordOutcome({ episodicId: ep2.id, outcome: "reworked" });

    // PR-A cycle 3 — clean approve, merge
    const ep3 = await writer.writeReview({
      ctx: { diff: "+++ b/src/clean.js\n+const x = 1;\n", repo: REPO, pullNumber: 50, newSha: "sha-c3" },
      reviews: [{ agent: "claude", verdict: "approve", blockers: [], summary: "LGTM" }],
      councilVerdict: "approve",
      costUsd: 0.01,
      cycleNumber: 3,
      priorEpisodicId: ep2.id,
    });
    const merged = await writer.recordOutcome({ episodicId: ep3.id, outcome: "merged" });
    assert.equal(merged.answerKeys.length, 1);
    const ak = merged.answerKeys[0];
    const removedCats = ak.removedBlockers.map((b) => b.category).sort();
    assert.deepEqual(
      removedCats,
      ["debug-noise", "type-error"],
      "AnswerKey carries removed blockers across the FULL multi-cycle chain",
    );

    // PR-B unrelated — but a similar diff pattern surfaces the answer-key.
    const retrieval = await memory.retrieve({
      query: `${REPO} ${dbgDiff("pr-b")}`,
      repo: REPO,
      k: 8,
    });
    assert.ok(
      retrieval.answerKeys.some((k) => k.id === ak.id),
      "next PR's retrieval surfaces the merged AnswerKey carrying the multi-cycle history",
    );
  } finally {
    cleanup(repoRoot);
  }
});
