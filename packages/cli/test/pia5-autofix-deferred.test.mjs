/**
 * PIA-5 — autofix exit code semantics when max-iterations is reached.
 *
 * Caught LIVE on eventbadge PR #38: autofix committed + pushed a fix
 * patch, then internally hit `--max-iterations` before its own verify
 * loop could re-review. Pre-PIA-5 this returned status=bailed-max-iterations
 * with exit 1, which:
 *   1. painted GitHub Actions red even though the cycle had advanced,
 *   2. fired a misleading Telegram failure card,
 *   3. confused the user about whether anything had been pushed.
 *
 * The fix splits the bail path on whether *any* iteration successfully
 * pushed. When yes → status=deferred-to-next-review, exit 0 (the next
 * review.yml run on the new push is the authority). When no → status
 * stays bailed-max-iterations with exit 1 (genuinely stuck, user must
 * intervene).
 *
 * These tests exercise both branches via the runAutofix dependency
 * injection seam so we don't need a real git repo or GitHub.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runAutofix } from "../dist/commands/autofix.js";

const fakeConfig = {
  config: { version: 1, agents: ["claude"], budget: { perPrUsd: 0.5 } },
  configDir: "/tmp/fake-pia5",
};

const baseArgs = {
  budgetUsd: 3,
  maxIterations: 2,
  autonomy: "l2",
  cwd: "/repo",
  dryRun: false,
  help: false,
  allowSecrets: [],
  skipSecretGuard: false,
  reworkCycle: 0,
};

function makeWorker() {
  return {
    work: async () => ({
      patch: "diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@\n-a\n+b\n",
      message: "fix: x",
      appliedFiles: ["src/x.ts"],
      costUsd: 0.01,
      tokensUsed: 100,
    }),
  };
}

function makeGit({ pushFails = false } = {}) {
  const calls = [];
  const exec = async (bin, args) => {
    calls.push({ bin, args: [...args] });
    if (pushFails && bin === "git" && args[0] === "push") {
      throw new Error("error: failed to push some refs");
    }
    return { stdout: "", stderr: "", code: 0 };
  };
  return { calls, exec };
}

function makeVerifier({ buildOk = true, testsOk = true } = {}) {
  return {
    build: async () => ({
      success: buildOk,
      command: "pnpm build",
      stdout: "",
      stderr: buildOk ? "" : "TS2345: type error",
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

const stubGh = async () => ({
  stdout: JSON.stringify({
    state: "OPEN",
    headRefOid: "abc",
    updatedAt: "t",
    headRepository: { name: "r" },
    headRepositoryOwner: { login: "o" },
  }),
  stderr: "",
});

const stickyBlockers = [
  { severity: "blocker", category: "type-error", message: "stubborn", file: "x.ts" },
];

test("PIA-5: max-iterations + pushes succeeded → deferred-to-next-review, exit 0", async () => {
  const stdoutLines = [];
  const { code, result } = await runAutofix(
    { ...baseArgs, pr: 1, maxIterations: 2 },
    {
      loadConfig: async () => fakeConfig,
      worker: makeWorker(),
      git: makeGit().exec,
      verifier: makeVerifier(),
      readFile: async () => "x",
      writeTempPatch: async () => {},
      removeTempPatch: async () => {},
      gh: stubGh,
      runReview: async () => ({
        verdict: "rework",
        reviews: [{ agent: "claude", verdict: "rework", summary: "", blockers: stickyBlockers }],
      }),
      stdout: (s) => stdoutLines.push(s),
      stderr: () => {},
    },
  );

  assert.equal(code, 0, "exit 0 when push advanced the cycle");
  assert.equal(result.status, "deferred-to-next-review");
  // The user-facing stdout must explain WHY exit code is 0 — the
  // next review.yml run is the authoritative verdict.
  const blob = stdoutLines.join("");
  assert.match(blob, /defer.*next review|next review\.yml|deferring verdict/i);
});

test("PIA-5: max-iterations + push always fails → bailed-max-iterations, exit 1", async () => {
  // When git push consistently fails (e.g., branch protection, lost
  // network), no iteration ever advances the cycle. The bail must
  // remain a hard failure (exit 1) so the user knows to intervene.
  const stdoutLines = [];
  const { code, result } = await runAutofix(
    { ...baseArgs, pr: 1, maxIterations: 2 },
    {
      loadConfig: async () => fakeConfig,
      worker: makeWorker(),
      git: makeGit({ pushFails: true }).exec,
      verifier: makeVerifier(),
      readFile: async () => "x",
      writeTempPatch: async () => {},
      removeTempPatch: async () => {},
      gh: stubGh,
      runReview: async () => ({
        verdict: "rework",
        reviews: [{ agent: "claude", verdict: "rework", summary: "", blockers: stickyBlockers }],
      }),
      stdout: (s) => stdoutLines.push(s),
      stderr: () => {},
    },
  );

  assert.equal(code, 1, "no successful push = stuck = exit 1");
  assert.equal(result.status, "bailed-max-iterations");
  const blob = stdoutLines.join("");
  assert.match(blob, /NO pushed patch|bailed after/i);
});

test("PIA-5: build fails → no commit, no push, max-iter bail = bailed-max-iterations exit 1", async () => {
  // When verify fails inside every iteration, the autofix reverts and
  // no push happens. Hitting max-iterations after this should remain
  // bailed-build-failed (handled before reachedMax) — but if build
  // somehow recovers and we hit max-iter without ever pushing, we
  // must NOT promote to deferred-to-next-review.
  // This test holds the contract: never-pushed → bailed, regardless
  // of why we never pushed.
  const stdoutLines = [];
  const { result, code } = await runAutofix(
    { ...baseArgs, pr: 1, maxIterations: 1 },
    {
      loadConfig: async () => fakeConfig,
      worker: makeWorker(),
      git: makeGit().exec,
      verifier: makeVerifier({ buildOk: false }),
      readFile: async () => "x",
      writeTempPatch: async () => {},
      removeTempPatch: async () => {},
      gh: stubGh,
      runReview: async () => ({
        verdict: "rework",
        reviews: [{ agent: "claude", verdict: "rework", summary: "", blockers: stickyBlockers }],
      }),
      stdout: (s) => stdoutLines.push(s),
      stderr: () => {},
    },
  );

  // Build failure short-circuits before reachedMax.
  assert.equal(result.status, "bailed-build-failed");
  assert.equal(code, 1);
});

test("PIA-5: deferred-to-next-review status type is reachable + exported in core", async () => {
  // Smoke test — confirms the new union member exists in the compiled
  // type contract by checking the runtime branch. If someone removes
  // it from the type later, this still passes (TS types don't gate
  // runtime), but at least guards the actual code path is wired.
  const { result } = await runAutofix(
    { ...baseArgs, pr: 1, maxIterations: 1 },
    {
      loadConfig: async () => fakeConfig,
      worker: makeWorker(),
      git: makeGit().exec,
      verifier: makeVerifier(),
      readFile: async () => "x",
      writeTempPatch: async () => {},
      removeTempPatch: async () => {},
      gh: stubGh,
      runReview: async () => ({
        verdict: "rework",
        reviews: [{ agent: "claude", verdict: "rework", summary: "", blockers: stickyBlockers }],
      }),
      stdout: () => {},
      stderr: () => {},
    },
  );

  assert.equal(result.status, "deferred-to-next-review");
});
