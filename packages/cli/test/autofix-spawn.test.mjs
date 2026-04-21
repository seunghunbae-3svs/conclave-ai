import { test } from "node:test";
import assert from "node:assert/strict";
import { runAutofix, parseVerdictFile } from "../dist/commands/autofix.js";

// v0.7.1 — verify the three UX paths:
//   1. --verdict -     (stdin pipe)
//   2. no --verdict, runReview injected  (existing DI path)
//   3. no --verdict, no DI   (spawn subprocess fallback)
//
// And four failure surfaces around (3): non-zero exit, invalid JSON,
// timeout, and empty stdin.

// ---- shared fixtures -----------------------------------------------------

const fakeConfig = {
  config: { version: 1, agents: ["claude"], budget: { perPrUsd: 0.5 } },
  configDir: "/tmp/fake",
};

const baseArgs = {
  budgetUsd: 3,
  maxIterations: 1,
  autonomy: "l2",
  cwd: "/repo",
  dryRun: true, // dry-run keeps the loop short; we're testing the verdict-fetch entry path.
  help: false,
  allowSecrets: [],
  skipSecretGuard: false,
};

function makeWorker() {
  return {
    work: async () => ({
      patch: "diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@\n-a\n+b\n",
      message: "fix",
      appliedFiles: ["src/x.ts"],
      costUsd: 0.01,
      tokensUsed: 10,
    }),
  };
}

function makeGit() {
  const calls = [];
  return {
    calls,
    exec: async (bin, args) => {
      calls.push({ bin, args: [...args] });
      return { stdout: "", stderr: "", code: 0 };
    },
  };
}

function makeVerifier() {
  return {
    build: async () => null,
    test: async () => null,
  };
}

// Standard gh mock — returns OPEN PR state with head sha "h".
const okGh = async () => ({
  stdout: JSON.stringify({
    state: "OPEN",
    headRefOid: "h",
    updatedAt: "t",
    headRepository: { name: "r" },
    headRepositoryOwner: { login: "o" },
  }),
  stderr: "",
});

const reworkVerdictJson = JSON.stringify({
  verdict: "rework",
  domain: "code",
  tiers: { tier1Count: 1, tier1Verdict: "rework", tier2Count: 0, tier2Verdict: "" },
  agents: [
    {
      id: "claude",
      verdict: "rework",
      blockers: [{ severity: "blocker", category: "type-error", message: "fix x", file: "src/x.ts" }],
      summary: "needs work",
    },
  ],
  metrics: { calls: 1, tokensIn: 100, tokensOut: 50, costUsd: 0.01, latencyMs: 200, cacheHitRate: 0 },
  episodicId: "ep-42",
  sha: "head-sha",
  repo: "o/r",
  prNumber: 21,
});

// ---- 1. --verdict - reads stdin -----------------------------------------

test("runAutofix: --verdict - reads stdin and parses v0.7.1 --json shape", async () => {
  const worker = makeWorker();
  const git = makeGit();
  let stdinRead = 0;
  const { code, result } = await runAutofix(
    { ...baseArgs, pr: 21, verdictFile: "-" },
    {
      loadConfig: async () => fakeConfig,
      worker,
      git: git.exec,
      verifier: makeVerifier(),
      readFile: async () => "x",
      writeTempPatch: async () => {},
      removeTempPatch: async () => {},
      readStdin: async () => { stdinRead += 1; return reworkVerdictJson; },
      // No runReview — if stdin path fails, this path asserts in spawnReview.
      spawnReview: async () => { throw new Error("spawnReview should not be called when stdin provides the verdict"); },
      gh: okGh,
      stdout: () => {},
      stderr: () => {},
    },
  );

  assert.equal(stdinRead, 1, "stdin should be read exactly once");
  assert.equal(code, 0, "dry-run exits 0");
  assert.equal(result.status, "dry-run");
});

test("runAutofix: --verdict - with empty stdin → exit 2, clear error", async () => {
  const stderrBuf = [];
  const { code, result } = await runAutofix(
    { ...baseArgs, pr: 21, verdictFile: "-" },
    {
      loadConfig: async () => fakeConfig,
      worker: makeWorker(),
      git: makeGit().exec,
      verifier: makeVerifier(),
      readStdin: async () => "   \n  \n",
      gh: okGh,
      stdout: () => {},
      stderr: (s) => stderrBuf.push(s),
    },
  );

  assert.equal(code, 2);
  assert.equal(result.status, "bailed-no-patches");
  assert.ok(stderrBuf.join("").includes("empty"), `stderr should mention empty: ${stderrBuf.join("")}`);
});

// ---- 2. runReview DI path (existing) -----------------------------------

test("runAutofix: no --verdict + runReview DI → uses DI, does not spawn", async () => {
  let spawnCalls = 0;
  let reviewCalls = 0;
  const worker = makeWorker();
  const git = makeGit();

  const { code, result } = await runAutofix(
    { ...baseArgs, pr: 21 },
    {
      loadConfig: async () => fakeConfig,
      worker,
      git: git.exec,
      verifier: makeVerifier(),
      readFile: async () => "x",
      writeTempPatch: async () => {},
      removeTempPatch: async () => {},
      runReview: async () => {
        reviewCalls += 1;
        return {
          verdict: "rework",
          reviews: [
            {
              agent: "claude",
              verdict: "rework",
              summary: "",
              blockers: [{ severity: "blocker", category: "type-error", message: "m", file: "src/x.ts" }],
            },
          ],
        };
      },
      spawnReview: async () => { spawnCalls += 1; return { stdout: "{}", stderr: "", code: 0 }; },
      gh: okGh,
      stdout: () => {},
      stderr: () => {},
    },
  );

  assert.equal(code, 0);
  assert.equal(result.status, "dry-run");
  assert.ok(reviewCalls >= 1, "runReview DI must be called");
  assert.equal(spawnCalls, 0, "spawnReview must NOT be called when runReview DI is present");
});

// ---- 3. No --verdict, no DI → spawns subprocess ------------------------

test("runAutofix: no --verdict + no DI → auto-spawns 'conclave review --pr N --json'", async () => {
  let spawnArgs = null;
  const worker = makeWorker();
  const git = makeGit();
  const stdoutBuf = [];

  const { code, result } = await runAutofix(
    { ...baseArgs, pr: 42 },
    {
      loadConfig: async () => fakeConfig,
      worker,
      git: git.exec,
      verifier: makeVerifier(),
      readFile: async () => "x",
      writeTempPatch: async () => {},
      removeTempPatch: async () => {},
      spawnReview: async (input) => {
        spawnArgs = input;
        return { stdout: reworkVerdictJson, stderr: "", code: 0 };
      },
      gh: okGh,
      stdout: (s) => stdoutBuf.push(s),
      stderr: () => {},
    },
  );

  assert.ok(spawnArgs, "spawnReview must be called");
  assert.equal(spawnArgs.prNumber, 42);
  assert.equal(spawnArgs.cwd, "/repo");
  assert.equal(code, 0);
  assert.equal(result.status, "dry-run");
  // Auto-spawn announcement on stdout
  assert.ok(stdoutBuf.join("").includes("spawning 'conclave review"), "should log the spawn");
});

// ---- 4. Subprocess non-zero exit (and not 1/2 verdict codes) ------------

test("runAutofix: spawnReview exits with unexpected code → clear error", async () => {
  const stderrBuf = [];
  const { code, result } = await runAutofix(
    { ...baseArgs, pr: 42 },
    {
      loadConfig: async () => fakeConfig,
      worker: makeWorker(),
      git: makeGit().exec,
      verifier: makeVerifier(),
      readFile: async () => "x",
      spawnReview: async () => ({ stdout: "", stderr: "config load failed", code: 5 }),
      gh: okGh,
      stdout: () => {},
      stderr: (s) => stderrBuf.push(s),
    },
  );

  assert.equal(code, 2);
  assert.equal(result.status, "bailed-no-patches");
  const err = stderrBuf.join("");
  assert.ok(err.includes("config load failed"), `stderr should surface subprocess stderr: ${err}`);
  assert.ok(err.includes("Pass --verdict"), "should suggest --verdict workaround");
});

// ---- 5. Subprocess stdout is invalid JSON --------------------------------

test("runAutofix: spawnReview stdout is invalid JSON → clear error", async () => {
  const stderrBuf = [];
  const { code, result } = await runAutofix(
    { ...baseArgs, pr: 42 },
    {
      loadConfig: async () => fakeConfig,
      worker: makeWorker(),
      git: makeGit().exec,
      verifier: makeVerifier(),
      readFile: async () => "x",
      spawnReview: async () => ({ stdout: "conclave review: tier-1 agents: [...]not-json", stderr: "", code: 0 }),
      gh: okGh,
      stdout: () => {},
      stderr: (s) => stderrBuf.push(s),
    },
  );

  assert.equal(code, 2);
  assert.equal(result.status, "bailed-no-patches");
  const err = stderrBuf.join("");
  assert.ok(/unparseable|parse/i.test(err), `stderr should mention parse failure: ${err}`);
});

// ---- 6. Subprocess throws (timeout) -------------------------------------

test("runAutofix: spawnReview throws (timeout) → clear error mentions it", async () => {
  const stderrBuf = [];
  const { code, result } = await runAutofix(
    { ...baseArgs, pr: 42 },
    {
      loadConfig: async () => fakeConfig,
      worker: makeWorker(),
      git: makeGit().exec,
      verifier: makeVerifier(),
      readFile: async () => "x",
      spawnReview: async () => {
        throw Object.assign(new Error("conclave review subprocess timed out after 60000ms"), {
          timedOut: true,
          stderr: "",
          code: 124,
        });
      },
      gh: okGh,
      stdout: () => {},
      stderr: (s) => stderrBuf.push(s),
    },
  );

  assert.equal(code, 2);
  assert.equal(result.status, "bailed-no-patches");
  const err = stderrBuf.join("");
  assert.ok(/timed out|timeout/i.test(err), `stderr should mention timeout: ${err}`);
});

// ---- 7. Subprocess exit=1 (rework verdict) is still parsed --------------

test("runAutofix: spawnReview exits 1 (rework) still parses verdict", async () => {
  // review exits 1 on rework — autofix must still parse stdout.
  const { code, result } = await runAutofix(
    { ...baseArgs, pr: 42 },
    {
      loadConfig: async () => fakeConfig,
      worker: makeWorker(),
      git: makeGit().exec,
      verifier: makeVerifier(),
      readFile: async () => "x",
      writeTempPatch: async () => {},
      removeTempPatch: async () => {},
      spawnReview: async () => ({ stdout: reworkVerdictJson, stderr: "", code: 1 }),
      gh: okGh,
      stdout: () => {},
      stderr: () => {},
    },
  );

  assert.equal(code, 0, "dry-run still exits 0 after parsing rework verdict");
  assert.equal(result.status, "dry-run");
});

// ---- 8. parseVerdictFile accepts --json shape (agents[] normalized) ----

test("parseVerdictFile: accepts v0.7.1 --json shape with agents[] → normalizes to reviews[]", () => {
  const parsed = parseVerdictFile(reworkVerdictJson);
  assert.equal(parsed.verdict, "rework");
  assert.equal(parsed.reviews.length, 1);
  assert.equal(parsed.reviews[0].agent, "claude");
  assert.equal(parsed.reviews[0].verdict, "rework");
  assert.equal(parsed.reviews[0].blockers.length, 1);
  assert.equal(parsed.reviews[0].blockers[0].category, "type-error");
});

test("parseVerdictFile: accepts legacy standalone shape", () => {
  const legacy = JSON.stringify({
    verdict: "reject",
    reviews: [{ agent: "openai", verdict: "reject", summary: "", blockers: [] }],
  });
  const parsed = parseVerdictFile(legacy);
  assert.equal(parsed.verdict, "reject");
  assert.equal(parsed.reviews[0].agent, "openai");
});

test("parseVerdictFile: rejects json with no reviews AND no agents", () => {
  const bad = JSON.stringify({ verdict: "rework" });
  assert.throws(() => parseVerdictFile(bad), /reviews.*agents/);
});
