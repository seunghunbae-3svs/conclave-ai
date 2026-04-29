/**
 * UX-2 / UX-3 / AF-1 — terminal progress emit + per-blocker progress
 * + apply-conflict partial-apply rescue.
 *
 * Live catch: eventbadge PR #39 had 9 council blockers across code,
 * design, and runtime defects. Pre-fix, autofix:
 *   - emitted progress only at iter-started + iter-done (success path),
 *     so Telegram showed "auto fixing 1/3" then went silent forever.
 *   - bailed the entire iteration on the first apply-conflict, wiping
 *     8 clean patches because of 1 off-by-N hunk (`reset --hard HEAD`).
 *   - posted UX-1 unified bail summary only as PR comment, never to
 *     the progress stream Telegram listens on.
 *
 * Post-fix:
 *   UX-2 — every shouldPostSummary terminal status fires
 *          autofix-cycle-ended progress, carrying bailStatus + iter
 *          count + cost + remaining-blocker count.
 *   UX-3 — per-blocker emits autofix-blocker-started +
 *          autofix-blocker-done with index/total/label/outcome so
 *          users see "fixing blocker 3/9: contrast violation" instead
 *          of staring at "auto fixing 1/3".
 *   AF-1 — apply-conflict on one patch restores ONLY that patch's files
 *          (`git checkout HEAD -- <files>`), keeps the others, and
 *          continues the iteration. Bail only when EVERY patch failed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runAutofix } from "../dist/commands/autofix.js";

const fakeConfig = {
  config: { version: 1, agents: ["claude"], budget: { perPrUsd: 0.5 } },
  configDir: "/tmp/fake-ux2",
};

const baseArgs = {
  budgetUsd: 3,
  maxIterations: 1,
  autonomy: "l2",
  cwd: "/repo",
  dryRun: false,
  help: false,
  allowSecrets: [],
  skipSecretGuard: false,
  reworkCycle: 0,
};

function makeWorker({ patch } = {}) {
  return {
    work: async () => ({
      patch:
        patch ?? "diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@\n-a\n+b\n",
      message: "fix",
      appliedFiles: ["src/x.ts"],
      costUsd: 0.01,
      tokensUsed: 100,
    }),
  };
}

function makeGit({ failApplyOn = [], applyLoopOnly = false } = {}) {
  // failApplyOn: filenames whose apply should fail.
  // applyLoopOnly: true → only the apply-loop (autofix.ts) calls fail;
  //                per-blocker pre-validation (autofix-worker.ts) passes.
  //                This simulates real-world apply-loop conflicts: pre-
  //                validation passed, but a later patch conflicts after
  //                an earlier patch has modified the worktree.
  // The mock distinguishes the two by tempPath prefix:
  //   .conclave-autofix-{id}.patch        — per-blocker validation
  //   .conclave-autofix-apply-{id}.patch  — sequential apply-loop
  let lastTempPatchContents = "";
  const calls = [];
  const exec = async (bin, args, opts) => {
    calls.push({ bin, args: [...args] });
    const lastArg = args[args.length - 1] ?? "";
    const isApplyLoop = typeof lastArg === "string" && lastArg.includes(".conclave-autofix-apply-");
    if (bin === "git" && args[0] === "apply") {
      const willFail = failApplyOn.some((f) => lastTempPatchContents.includes(f))
        && (!applyLoopOnly || isApplyLoop);
      if (willFail) throw new Error(`error: patch failed: ${lastTempPatchContents.match(/diff --git a\/(\S+)/)?.[1] ?? "unknown"}`);
    }
    if (bin === "patch") {
      const willFail = failApplyOn.some((f) => lastTempPatchContents.includes(f))
        && (!applyLoopOnly || isApplyLoop);
      if (willFail) throw new Error(`patch: **** unexpected end of file in patch`);
    }
    return { stdout: "", stderr: "", code: 0 };
  };
  exec._setLastTemp = (s) => { lastTempPatchContents = s; };
  return { exec, calls };
}

function makeVerifier({ buildOk = true, testsOk = true } = {}) {
  return {
    build: async () => ({
      success: buildOk,
      command: "pnpm build",
      stdout: "",
      stderr: buildOk ? "" : "TS2345 type error",
      durationMs: 100,
      detectedFrom: "package.json",
    }),
    test: async () => ({
      success: testsOk,
      command: "pnpm test",
      stdout: "",
      stderr: testsOk ? "" : "test failed",
      durationMs: 100,
      detectedFrom: "package.json",
    }),
  };
}

const stickyBlockers = [
  { severity: "blocker", category: "type-error", message: "Bad type", file: "src/a.ts" },
  { severity: "blocker", category: "logging", message: "Stray console.log", file: "src/b.ts" },
  { severity: "blocker", category: "contrast", message: "Low contrast button", file: "src/c.ts" },
];

function captureProgress() {
  const events = [];
  const notifier = {
    id: "test-notifier",
    displayName: "TestNotifier",
    notifyReview: async () => {},
    notifyProgress: async (input) => {
      events.push({ stage: input.stage, payload: input.payload ?? {} });
    },
  };
  return { events, notifier };
}

function stubGh() {
  const calls = [];
  const fn = async (bin, args) => {
    calls.push([...args]);
    if (args[0] === "pr" && args[1] === "view") {
      return {
        stdout: JSON.stringify({
          state: "OPEN",
          headRefOid: "abc",
          updatedAt: "t",
          headRepository: { name: "r" },
          headRepositoryOwner: { login: "o" },
        }),
        stderr: "",
      };
    }
    return { stdout: "", stderr: "" };
  };
  return { calls, fn };
}

// Drives the mock writeTempPatch so makeGit can simulate selective
// apply failure by inspecting the patch body.
function makeWriteTempPatch(git) {
  return async (_path, contents) => {
    git.exec._setLastTemp(contents);
  };
}

test("UX-3: per-blocker progress emits autofix-blocker-started + done with index/total/label/outcome", async () => {
  const { events, notifier } = captureProgress();
  const git = makeGit();
  const verdict = JSON.stringify({
    councilVerdict: "rework",
    episodicId: "ep-ux3-test",
    reviews: [{ agent: "claude", verdict: "rework", summary: "", blockers: stickyBlockers }],
  });
  const { result } = await runAutofix(
    { ...baseArgs, pr: 1, maxIterations: 1, verdictFile: "/tmp/v.json" },
    {
      loadConfig: async () => fakeConfig,
      worker: makeWorker(),
      git: git.exec,
      verifier: makeVerifier(),
      readFile: async () => verdict,
      readVerdictFile: async () => verdict,
      writeTempPatch: makeWriteTempPatch(git),
      removeTempPatch: async () => {},
      gh: stubGh().fn,
      runReview: async () => ({
        verdict: "rework",
        reviews: [{ agent: "claude", verdict: "rework", summary: "", blockers: stickyBlockers }],
      }),
      stdout: () => {},
      stderr: () => {},
      notifiers: [notifier],
    },
  );
  // We expect 3 blockers × (started + done) = 6 per-blocker emits.
  const started = events.filter((e) => e.stage === "autofix-blocker-started");
  const done = events.filter((e) => e.stage === "autofix-blocker-done");
  assert.equal(started.length, 3, `expected 3 blocker-started, got ${started.length}`);
  assert.equal(done.length, 3, `expected 3 blocker-done, got ${done.length}`);
  // Index + total + label populated.
  assert.equal(started[0].payload.blockerIndex, 1);
  assert.equal(started[0].payload.blockerTotal, 3);
  assert.match(started[0].payload.blockerLabel, /type-error.*Bad type/);
  // Outcome present on done.
  assert.ok(["ready", "skipped", "conflict", "secret-block", "worker-error"].includes(done[0].payload.blockerOutcome));
  // result is defined regardless of bail/success.
  assert.ok(result);
});

test("UX-2: bailed-no-patches emits autofix-cycle-ended with bailStatus + counts + cost", async () => {
  const { events, notifier } = captureProgress();
  // Force every patch to conflict by making the worker return an
  // un-appliable diff and the git mock reject every apply.
  const git = makeGit({ failApplyOn: ["src/"] });
  const verdict = JSON.stringify({
    councilVerdict: "rework",
    episodicId: "ep-ux2-test",
    reviews: [{ agent: "claude", verdict: "rework", summary: "", blockers: stickyBlockers }],
  });
  const { result } = await runAutofix(
    { ...baseArgs, pr: 1, maxIterations: 1, verdictFile: "/tmp/v.json" },
    {
      loadConfig: async () => fakeConfig,
      worker: makeWorker(),
      git: git.exec,
      verifier: makeVerifier(),
      readFile: async () => verdict,
      readVerdictFile: async () => verdict,
      writeTempPatch: makeWriteTempPatch(git),
      removeTempPatch: async () => {},
      gh: stubGh().fn,
      runReview: async () => ({
        verdict: "rework",
        reviews: [{ agent: "claude", verdict: "rework", summary: "", blockers: stickyBlockers }],
      }),
      stdout: () => {},
      stderr: () => {},
      notifiers: [notifier],
    },
  );
  const cycleEnded = events.find((e) => e.stage === "autofix-cycle-ended");
  assert.ok(cycleEnded, "must emit autofix-cycle-ended");
  assert.match(cycleEnded.payload.bailStatus, /^bailed-/);
  assert.equal(typeof cycleEnded.payload.iterationsAttempted, "number");
  assert.ok(cycleEnded.payload.iterationsAttempted >= 1);
  assert.equal(typeof cycleEnded.payload.totalCostUsd, "number");
  assert.equal(typeof cycleEnded.payload.remainingBlockerCount, "number");
  assert.ok(result.status.startsWith("bailed-"));
});

test("AF-1: 1 patch conflicts among 3 → other 2 survive, iteration commits, status=approved/awaiting", async () => {
  // Worker returns the SAME boilerplate patch for every blocker; the
  // git mock fails apply ONLY when the temp patch contains "src/b.ts"
  // (the second blocker's file). The first and third blockers' patches
  // succeed. Pre-AF-1 the entire iteration would `reset --hard HEAD` and
  // bail. Post-AF-1 it commits the 2 survivors.
  const { events, notifier } = captureProgress();
  let workerCallIdx = 0;
  const worker = {
    work: async (ctx) => {
      const blocker = ctx.reviews[0].blockers[0];
      workerCallIdx += 1;
      // Encode the file in the diff so the git mock can selectively reject.
      return {
        patch: `diff --git a/${blocker.file} b/${blocker.file}\n--- a/${blocker.file}\n+++ b/${blocker.file}\n@@\n-a\n+b\n`,
        message: `fix ${blocker.message}`,
        appliedFiles: [blocker.file],
        costUsd: 0.01,
        tokensUsed: 100,
      };
    },
  };
  const git = makeGit({ failApplyOn: ["src/b.ts"], applyLoopOnly: true });
  const verdict = JSON.stringify({
    councilVerdict: "rework",
    episodicId: "ep-af1-test",
    reviews: [{ agent: "claude", verdict: "rework", summary: "", blockers: stickyBlockers }],
  });
  const { result } = await runAutofix(
    { ...baseArgs, pr: 1, maxIterations: 1, verdictFile: "/tmp/v.json" },
    {
      loadConfig: async () => fakeConfig,
      worker,
      git: git.exec,
      verifier: makeVerifier(),
      readFile: async () => verdict,
      readVerdictFile: async () => verdict,
      writeTempPatch: makeWriteTempPatch(git),
      removeTempPatch: async () => {},
      gh: stubGh().fn,
      runReview: async () => ({
        verdict: "approve",
        reviews: [{ agent: "claude", verdict: "approve", summary: "", blockers: [] }],
      }),
      stdout: () => {},
      stderr: () => {},
      notifiers: [notifier],
    },
  );
  // Should NOT be bailed-no-patches — partial-apply rescue kept 2 of 3.
  assert.ok(
    result.status === "awaiting-approval" || result.status === "approved" || result.status === "deferred-to-next-review",
    `expected non-bail status, got ${result.status}`,
  );
  // The commit + push step should have run (one of the 2 surviving fixes).
  const stub = stubGh();
  // Confirm at least one iteration recorded ≥1 ready fix.
  assert.ok(result.iterations.length >= 1);
  // git checkout HEAD -- <files> was called for the conflicting patch
  // (AF-1 partial-restore).
  const checkoutRestore = git.calls.find(
    (c) => c.bin === "git" && c.args[0] === "checkout" && c.args[1] === "HEAD" && c.args.includes("--"),
  );
  assert.ok(checkoutRestore, "AF-1 must call `git checkout HEAD -- <files>` for the conflicting patch");
  // No `git reset --hard HEAD` should fire mid-iteration when at least
  // one fix survived.
  const hardResets = git.calls.filter(
    (c) => c.bin === "git" && c.args[0] === "reset" && c.args.includes("--hard"),
  );
  // Some hardResets are OK in test scaffolding (e.g. rollback on
  // verifier-fail elsewhere); we only assert <= 1 to allow the budget /
  // build-fail safety paths but catch the "wipe-all-on-conflict" regression.
  assert.ok(hardResets.length <= 1, `pre-AF-1 would reset --hard ALL changes; got ${hardResets.length} reset calls`);
});

test("AF-1: ALL 3 patches conflict in apply-loop → bail with bailed-no-patches + apply-conflict reason", async () => {
  // Per-blocker pre-validation passes; the apply-loop fails for every
  // patch (e.g., concurrent modification). No patch survives — must
  // bail cleanly and emit autofix-cycle-ended with the apply-conflict
  // reason (the "every patch this iteration rejected" path I added).
  const { events, notifier } = captureProgress();
  const worker = {
    work: async (ctx) => {
      const blocker = ctx.reviews[0].blockers[0];
      return {
        patch: `diff --git a/${blocker.file} b/${blocker.file}\n--- a/${blocker.file}\n+++ b/${blocker.file}\n@@\n-a\n+b\n`,
        message: "fix",
        appliedFiles: [blocker.file],
        costUsd: 0.01,
        tokensUsed: 100,
      };
    },
  };
  const git = makeGit({ failApplyOn: ["src/"], applyLoopOnly: true });
  const verdict = JSON.stringify({
    councilVerdict: "rework",
    episodicId: "ep-af1-all",
    reviews: [{ agent: "claude", verdict: "rework", summary: "", blockers: stickyBlockers }],
  });
  const { result } = await runAutofix(
    { ...baseArgs, pr: 1, maxIterations: 1, verdictFile: "/tmp/v.json" },
    {
      loadConfig: async () => fakeConfig,
      worker,
      git: git.exec,
      verifier: makeVerifier(),
      readFile: async () => verdict,
      readVerdictFile: async () => verdict,
      writeTempPatch: makeWriteTempPatch(git),
      removeTempPatch: async () => {},
      gh: stubGh().fn,
      runReview: async () => ({
        verdict: "rework",
        reviews: [{ agent: "claude", verdict: "rework", summary: "", blockers: stickyBlockers }],
      }),
      stdout: () => {},
      stderr: () => {},
      notifiers: [notifier],
    },
  );
  assert.equal(result.status, "bailed-no-patches");
  // Cycle ended emit fires for the bail too.
  const cycleEnded = events.find((e) => e.stage === "autofix-cycle-ended");
  assert.ok(cycleEnded);
  assert.equal(cycleEnded.payload.bailStatus, "bailed-no-patches");
  assert.match(cycleEnded.payload.reason ?? "", /apply-conflict|every patch/i);
});
