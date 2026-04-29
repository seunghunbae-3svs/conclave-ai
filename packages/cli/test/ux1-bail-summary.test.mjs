/**
 * UX-1 — every bail terminal posts a unified PR-comment summary.
 *
 * Pre-UX-1, only `bailed-max-iterations` posted a PR comment with
 * an ad-hoc inline body. bailed-build-failed / bailed-tests-failed /
 * bailed-no-patches / bailed-budget all early-returned silently.
 * Bae's complaint after PR #37: "야 그러면 그렇다고 결과를 알려줘야지".
 *
 * These tests pin:
 *   1. renderBailSummary produces an actionable Markdown body for
 *      every bail status, with status-specific headline + next-steps.
 *   2. shouldPostSummary opts in for bail-* + deferred-to-next-review,
 *      opts out for approve / awaiting-approval / dry-run.
 *   3. runAutofix wiring: each terminal status invokes `gh pr comment`
 *      with the rendered body (best-effort — gh failure does not
 *      propagate).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderBailSummary,
  shouldPostSummary,
} from "../dist/lib/bail-summary.js";
import { runAutofix } from "../dist/commands/autofix.js";

const blockers = [
  { severity: "blocker", category: "type-error", message: "Bad type", file: "src/x.ts" },
  { severity: "major", category: "logging", message: "Stray console.log", file: "src/y.ts" },
];

// ---- renderer ---------------------------------------------------------

test("UX-1 render: bailed-max-iterations body has headline + iterations + cost + blockers", () => {
  const body = renderBailSummary("bailed-max-iterations", {
    iterationsAttempted: 3,
    totalCostUsd: 0.42,
    remainingBlockers: blockers,
  });
  assert.match(body, /max iterations/i);
  assert.match(body, /3 iteration\(s\)/);
  assert.match(body, /\$0\.4200/);
  assert.match(body, /Bad type/);
  assert.match(body, /Stray console\.log/);
  assert.match(body, /What you can do/);
});

test("UX-1 render: bailed-build-failed body mentions reverted branch + Actions log hint", () => {
  const body = renderBailSummary("bailed-build-failed", {
    iterationsAttempted: 2,
    totalCostUsd: 0.21,
    remainingBlockers: [blockers[0]],
    reason: "build failed after max iterations",
  });
  assert.match(body, /build failed/i);
  assert.match(body, /reverted/i);
  assert.match(body, /Actions log/i);
  assert.match(body, /Reason:.+build failed/);
});

test("UX-1 render: bailed-tests-failed body mentions test failure + worker misjudgement", () => {
  const body = renderBailSummary("bailed-tests-failed", {
    iterationsAttempted: 1,
    totalCostUsd: 0,
    remainingBlockers: [],
    reason: "tests failed",
  });
  assert.match(body, /test/i);
  assert.match(body, /worker misjudgement|patch broke a test/i);
});

test("UX-1 render: bailed-budget body suggests budget knob", () => {
  const body = renderBailSummary("bailed-budget", {
    iterationsAttempted: 1,
    totalCostUsd: 3.0,
    remainingBlockers: [blockers[0]],
  });
  assert.match(body, /budget/i);
  assert.match(body, /perPrUsd|conclaverc/i);
});

test("UX-1 render: bailed-no-patches body explains worker-error / deny-list / off-by-N", () => {
  const body = renderBailSummary("bailed-no-patches", {
    iterationsAttempted: 1,
    totalCostUsd: 0.05,
    remainingBlockers: blockers,
  });
  assert.match(body, /clean diff|off-by|deny-list/i);
});

test("UX-1 render: deferred-to-next-review body marks success-shaped + 'no action needed'", () => {
  const body = renderBailSummary("deferred-to-next-review", {
    iterationsAttempted: 2,
    totalCostUsd: 0.5,
    remainingBlockers: [],
  });
  assert.match(body, /authoritative verdict|next review\.yml|review.yml/i);
  assert.match(body, /No action needed/i);
});

test("UX-1 render: blocker list truncates at 10 with overflow note", () => {
  const many = Array.from({ length: 25 }, (_, i) => ({
    severity: "blocker",
    category: "type-error",
    message: `Bug ${i}`,
    file: `src/f${i}.ts`,
  }));
  const body = renderBailSummary("bailed-max-iterations", {
    iterationsAttempted: 3,
    totalCostUsd: 0.5,
    remainingBlockers: many,
  });
  assert.ok(body.includes("Bug 9"));
  // 11th and beyond are truncated.
  assert.ok(!body.includes("Bug 15"));
  assert.match(body, /15 more blockers/);
});

test("UX-1 render: zero-cost is rendered as $0 (not $0.0000)", () => {
  const body = renderBailSummary("bailed-no-patches", {
    iterationsAttempted: 1,
    totalCostUsd: 0,
    remainingBlockers: [],
  });
  assert.match(body, /\$0\b/);
  assert.doesNotMatch(body, /\$0\.0000/);
});

test("UX-1 render: unknown status falls back to a generic 'autofix terminated' headline", () => {
  const body = renderBailSummary("some-future-status", {
    iterationsAttempted: 0,
    totalCostUsd: 0,
    remainingBlockers: [],
  });
  assert.match(body, /Autofix terminated/i);
  assert.match(body, /some-future-status/);
});

// ---- shouldPostSummary ------------------------------------------------

test("UX-1 shouldPostSummary: bail-* + deferred → true", () => {
  assert.equal(shouldPostSummary("bailed-max-iterations"), true);
  assert.equal(shouldPostSummary("bailed-build-failed"), true);
  assert.equal(shouldPostSummary("bailed-tests-failed"), true);
  assert.equal(shouldPostSummary("bailed-no-patches"), true);
  assert.equal(shouldPostSummary("bailed-budget"), true);
  assert.equal(shouldPostSummary("bailed-secret-guard"), true);
  assert.equal(shouldPostSummary("loop-guard-trip"), true);
  assert.equal(shouldPostSummary("deferred-to-next-review"), true);
});

test("UX-1 shouldPostSummary: success-shaped statuses → false", () => {
  assert.equal(shouldPostSummary("approved"), false);
  assert.equal(shouldPostSummary("awaiting-approval"), false);
  assert.equal(shouldPostSummary("dry-run"), false);
});

// ---- runAutofix wiring ------------------------------------------------

const fakeConfig = {
  config: { version: 1, agents: ["claude"], budget: { perPrUsd: 0.5 } },
  configDir: "/tmp/fake-ux1",
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
  return async (bin, args) => {
    if (pushFails && bin === "git" && args[0] === "push") {
      throw new Error("push rejected");
    }
    return { stdout: "", stderr: "", code: 0 };
  };
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

const stickyBlockers = [{ severity: "blocker", category: "type-error", message: "stubborn", file: "x.ts" }];

function captureGh() {
  const calls = [];
  const fn = async (bin, args) => {
    calls.push([...args]); // full args, including the --body payload
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

test("UX-1 wiring: bailed-build-failed → posts PR comment with build-failed body", async () => {
  const gh = captureGh();
  const { result } = await runAutofix(
    { ...baseArgs, pr: 1, maxIterations: 1 },
    {
      loadConfig: async () => fakeConfig,
      worker: makeWorker(),
      git: makeGit(),
      verifier: makeVerifier({ buildOk: false }),
      readFile: async () => "x",
      writeTempPatch: async () => {},
      removeTempPatch: async () => {},
      gh: gh.fn,
      runReview: async () => ({
        verdict: "rework",
        reviews: [{ agent: "claude", verdict: "rework", summary: "", blockers: stickyBlockers }],
      }),
      stdout: () => {},
      stderr: () => {},
    },
  );
  assert.equal(result.status, "bailed-build-failed");
  // Find the pr-comment call.
  const commentCall = gh.calls.find((a) => a[0] === "pr" && a[1] === "comment");
  assert.ok(commentCall, "must post a PR comment for bailed-build-failed");
  // Body is the arg following --body.
  const bodyIdx = commentCall.indexOf("--body");
  const body = bodyIdx >= 0 ? commentCall[bodyIdx + 1] : "";
  assert.match(body, /build failed/i);
  assert.match(body, /Conclave AI — autofix cycle ended/);
});

test("UX-1 wiring: bailed-tests-failed → posts PR comment", async () => {
  const gh = captureGh();
  const { result } = await runAutofix(
    { ...baseArgs, pr: 1, maxIterations: 1 },
    {
      loadConfig: async () => fakeConfig,
      worker: makeWorker(),
      git: makeGit(),
      verifier: makeVerifier({ testsOk: false }),
      readFile: async () => "x",
      writeTempPatch: async () => {},
      removeTempPatch: async () => {},
      gh: gh.fn,
      runReview: async () => ({
        verdict: "rework",
        reviews: [{ agent: "claude", verdict: "rework", summary: "", blockers: stickyBlockers }],
      }),
      stdout: () => {},
      stderr: () => {},
    },
  );
  assert.equal(result.status, "bailed-tests-failed");
  const commentCall = gh.calls.find((a) => a[0] === "pr" && a[1] === "comment");
  assert.ok(commentCall);
  const bodyIdx = commentCall.indexOf("--body");
  assert.match(commentCall[bodyIdx + 1] ?? "", /test/i);
});

test("UX-1 wiring: deferred-to-next-review → posts PR comment with no-action-needed body", async () => {
  const gh = captureGh();
  const { result } = await runAutofix(
    { ...baseArgs, pr: 1, maxIterations: 2 },
    {
      loadConfig: async () => fakeConfig,
      worker: makeWorker(),
      git: makeGit(),
      verifier: makeVerifier(),
      readFile: async () => "x",
      writeTempPatch: async () => {},
      removeTempPatch: async () => {},
      gh: gh.fn,
      runReview: async () => ({
        verdict: "rework",
        reviews: [{ agent: "claude", verdict: "rework", summary: "", blockers: stickyBlockers }],
      }),
      stdout: () => {},
      stderr: () => {},
    },
  );
  assert.equal(result.status, "deferred-to-next-review");
  const commentCall = gh.calls.find((a) => a[0] === "pr" && a[1] === "comment");
  assert.ok(commentCall);
  const bodyIdx = commentCall.indexOf("--body");
  assert.match(commentCall[bodyIdx + 1] ?? "", /next review|authoritative/i);
});

test("UX-1 wiring: gh pr comment failure does NOT propagate (best-effort)", async () => {
  const flakeyGh = async (bin, args) => {
    if (args[0] === "pr" && args[1] === "comment") {
      throw new Error("gh: rate limit");
    }
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
  const stderrLines = [];
  const { result } = await runAutofix(
    { ...baseArgs, pr: 1, maxIterations: 1 },
    {
      loadConfig: async () => fakeConfig,
      worker: makeWorker(),
      git: makeGit(),
      verifier: makeVerifier({ buildOk: false }),
      readFile: async () => "x",
      writeTempPatch: async () => {},
      removeTempPatch: async () => {},
      gh: flakeyGh,
      runReview: async () => ({
        verdict: "rework",
        reviews: [{ agent: "claude", verdict: "rework", summary: "", blockers: stickyBlockers }],
      }),
      stdout: () => {},
      stderr: (s) => stderrLines.push(s),
    },
  );
  // Function still returns the bail result.
  assert.equal(result.status, "bailed-build-failed");
  // Failure is logged to stderr.
  assert.ok(stderrLines.some((s) => /terminal-summary PR comment failed/.test(s)));
});
