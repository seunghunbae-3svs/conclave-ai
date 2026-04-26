import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { runAutofix, parseVerdictFile, defaultSpawnReview } from "../dist/commands/autofix.js";

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

// ---- v0.7.2 regression: spawnReview exit-code interpretation -------------
//
// Background (live-debug on seunghunbae-3svs/eventbadge#21):
//   `conclave review --json` exits 0/1/2 depending on verdict outcome
//   (approve/rework/reject). The v0.7.1 defaultSpawnReview wrapper re-threw
//   on any non-zero exit — so execFile's "child exited non-zero" rejection
//   bubbled past the call-site's exit-code-aware branch, leaving autofix
//   with "failed to auto-fetch verdict" even though the subprocess had
//   successfully emitted valid verdict JSON on stdout.
//
//   The fix: defaultSpawnReview now returns {code:N, stdout, stderr} for
//   codes 0/1/2 instead of throwing. The runAutofix exit-code guard at
//   the call site (accepts 0/1/2, rejects ≥3) works as intended.

const approveVerdictJson = JSON.stringify({
  verdict: "approve",
  domain: "code",
  tiers: { tier1Count: 1, tier1Verdict: "approve", tier2Count: 0, tier2Verdict: "" },
  agents: [{ id: "claude", verdict: "approve", blockers: [], summary: "lgtm" }],
  metrics: { calls: 1, tokensIn: 50, tokensOut: 10, costUsd: 0.005, latencyMs: 100, cacheHitRate: 0 },
  episodicId: "ep-43",
  sha: "head-sha",
  repo: "o/r",
  prNumber: 21,
});

const rejectVerdictJson = JSON.stringify({
  verdict: "reject",
  domain: "code",
  tiers: { tier1Count: 2, tier1Verdict: "reject", tier2Count: 0, tier2Verdict: "" },
  agents: [
    {
      id: "claude",
      verdict: "reject",
      blockers: [{ severity: "blocker", category: "architecture", message: "wrong approach entirely" }],
      summary: "please close",
    },
    {
      id: "openai",
      verdict: "reject",
      blockers: [{ severity: "blocker", category: "security", message: "exposes secret" }],
      summary: "sec issue",
    },
  ],
  metrics: { calls: 2, tokensIn: 200, tokensOut: 80, costUsd: 0.02, latencyMs: 400, cacheHitRate: 0 },
  episodicId: "ep-44",
  sha: "head-sha",
  repo: "o/r",
  prNumber: 21,
});

test("v0.7.2: spawnReview exits 0 (approve) with no blockers → 'nothing to autofix', exit 0", async () => {
  const stdoutBuf = [];
  const { code, result } = await runAutofix(
    { ...baseArgs, pr: 21, dryRun: false },
    {
      loadConfig: async () => fakeConfig,
      worker: makeWorker(),
      git: makeGit().exec,
      verifier: makeVerifier(),
      readFile: async () => "x",
      spawnReview: async () => ({ stdout: approveVerdictJson, stderr: "", code: 0 }),
      gh: okGh,
      stdout: (s) => stdoutBuf.push(s),
      stderr: () => {},
    },
  );

  assert.equal(code, 0, "approve exits 0");
  assert.equal(result.status, "approved");
  assert.equal(result.finalVerdict, "approve");
  const out = stdoutBuf.join("");
  assert.ok(/already approves|nothing to fix/i.test(out), `should say verdict already approves: ${out}`);
});

test("v0.7.2: spawnReview exits 2 (reject) → refuses to autofix, exit 1, clear message", async () => {
  const stdoutBuf = [];
  const stderrBuf = [];
  const { code, result } = await runAutofix(
    { ...baseArgs, pr: 21, dryRun: false },
    {
      loadConfig: async () => fakeConfig,
      worker: makeWorker(),
      git: makeGit().exec,
      verifier: makeVerifier(),
      readFile: async () => "x",
      spawnReview: async () => ({ stdout: rejectVerdictJson, stderr: "", code: 2 }),
      gh: okGh,
      stdout: (s) => stdoutBuf.push(s),
      stderr: (s) => stderrBuf.push(s),
    },
  );

  // Not a crash — exit 1 with explanatory message.
  assert.equal(code, 1, "reject exits 1 (non-zero signal, but not error-crash)");
  assert.equal(result.status, "bailed-no-patches");
  assert.equal(result.finalVerdict, "reject");
  // Should carry the actual blockers from the reject reviews.
  assert.ok(result.remainingBlockers.length >= 1, "should surface the blockers so Bae sees them");
  const out = stdoutBuf.join("");
  assert.ok(/reject/i.test(out), `should mention reject: ${out}`);
  assert.ok(/destructive|refus/i.test(out), `should explain why it refused: ${out}`);
  // Must NOT have reached the "failed to auto-fetch" bailout.
  const err = stderrBuf.join("");
  assert.ok(!/failed to auto-fetch/.test(err), `should not claim auto-fetch failure: ${err}`);
});

test("v0.7.2: spawnReview exits 1 (rework) with real blockers → proceeds to fix loop", async () => {
  // Same as existing test #7 but NOT dry-run — confirms the verdict is
  // actually carried through into the worker loop and not bailed-out on.
  let workerCalls = 0;
  const worker = {
    work: async () => {
      workerCalls += 1;
      return {
        patch: "diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@\n-a\n+b\n",
        message: "fix",
        appliedFiles: ["src/x.ts"],
        costUsd: 0.01,
        tokensUsed: 10,
      };
    },
  };

  const { code, result } = await runAutofix(
    { ...baseArgs, pr: 42, dryRun: true },
    {
      loadConfig: async () => fakeConfig,
      worker,
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

  assert.equal(code, 0);
  assert.equal(result.status, "dry-run");
  assert.ok(workerCalls >= 1, "worker must be invoked for rework blockers — the verdict was parsed");
});

test("v0.7.2: spawnReview exits 4 (genuine subprocess crash) → clear error, exit 2", async () => {
  const stderrBuf = [];
  const { code, result } = await runAutofix(
    { ...baseArgs, pr: 42, dryRun: false },
    {
      loadConfig: async () => fakeConfig,
      worker: makeWorker(),
      git: makeGit().exec,
      verifier: makeVerifier(),
      readFile: async () => "x",
      spawnReview: async () => ({ stdout: "", stderr: "internal panic: segfault", code: 4 }),
      gh: okGh,
      stdout: () => {},
      stderr: (s) => stderrBuf.push(s),
    },
  );

  assert.equal(code, 2);
  assert.equal(result.status, "bailed-no-patches");
  const err = stderrBuf.join("");
  assert.ok(err.includes("exited 4"), `should mention exit 4: ${err}`);
  assert.ok(err.includes("internal panic"), `should surface the subprocess stderr: ${err}`);
});

// ---- v0.7.2: defaultSpawnReview unit test (the bug's ground zero) --------
//
// This test runs the REAL defaultSpawnReview (not the injected one) against
// a temporary fake `conclave.js` script that exits with controllable code
// and stdout. Without the v0.7.2 fix, execFile's "child exited non-zero"
// rejection bubbles up as a throw — defaultSpawnReview must instead return
// {code:1, stdout, stderr} so the caller can parse the verdict.

async function makeFakeConclave(exitCode, stdoutPayload, stderrPayload = "") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "conclave-autofix-test-"));
  const script = path.join(dir, "conclave.js");
  // The script ignores its argv and just emits the configured stdout/stderr,
  // then exits with the configured code.
  const src = `
process.stdout.write(${JSON.stringify(stdoutPayload)});
process.stderr.write(${JSON.stringify(stderrPayload)});
process.exit(${exitCode});
`;
  await fs.writeFile(script, src, "utf8");
  return { dir, script };
}

async function callDefaultSpawnReviewWithFakeBinary(fakeScriptPath, cwd) {
  // defaultSpawnReview picks the spawn target based on `process.argv[1]`:
  //   - if argv[1] matches /conclave(\.js)?$/, it spawns `node argv[1] ...`
  //   - otherwise it spawns `conclave` from PATH
  // We temporarily override argv[1] to our fake script, call, then restore.
  const originalArgv1 = process.argv[1];
  process.argv[1] = fakeScriptPath;
  try {
    return await defaultSpawnReview({ prNumber: 999, cwd, timeoutMs: 10_000 });
  } finally {
    process.argv[1] = originalArgv1;
  }
}

test("v0.7.2 defaultSpawnReview: exit 0 returns {code:0, stdout}", async () => {
  const { dir, script } = await makeFakeConclave(0, approveVerdictJson);
  try {
    const result = await callDefaultSpawnReviewWithFakeBinary(script, dir);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, approveVerdictJson);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("v0.7.2 defaultSpawnReview: exit 1 (rework) DOES NOT THROW — returns {code:1, stdout}", async () => {
  // This is the exact bug Bae hit on eventbadge#21.
  const { dir, script } = await makeFakeConclave(1, reworkVerdictJson);
  try {
    const result = await callDefaultSpawnReviewWithFakeBinary(script, dir);
    assert.equal(result.code, 1, "exit 1 (rework) must be returned, not thrown");
    assert.equal(result.stdout, reworkVerdictJson);
    // Verify the stdout is actually parseable — proves the caller can use it.
    const parsed = parseVerdictFile(result.stdout);
    assert.equal(parsed.verdict, "rework");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("v0.7.2 defaultSpawnReview: exit 2 (reject) DOES NOT THROW — returns {code:2, stdout}", async () => {
  const { dir, script } = await makeFakeConclave(2, rejectVerdictJson);
  try {
    const result = await callDefaultSpawnReviewWithFakeBinary(script, dir);
    assert.equal(result.code, 2, "exit 2 (reject) must be returned, not thrown");
    const parsed = parseVerdictFile(result.stdout);
    assert.equal(parsed.verdict, "reject");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// v0.13.2 RC #13 — defaultSpawnReview must pass --no-notify so the spawned
// verdict-fetch review doesn't push a duplicate Telegram notification (the
// upstream rework workflow's earlier review already notified). Pre-fix the
// chat saw "Conclave reviewing..." → "verdict: rework" twice per cycle.
test("v0.13.2 defaultSpawnReview: passes --no-notify to spawned review (RC #13)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "conclave-autofix-test-"));
  const script = path.join(dir, "conclave.js");
  // Fake binary: writes its received argv (post-script-path) to stderr,
  // then a valid approve verdict to stdout, then exits 0. We assert on
  // the captured argv to confirm --no-notify is in the call.
  const src = `
process.stderr.write(JSON.stringify(process.argv.slice(2)));
process.stdout.write(${JSON.stringify(approveVerdictJson)});
process.exit(0);
`;
  await fs.writeFile(script, src, "utf8");
  try {
    const result = await callDefaultSpawnReviewWithFakeBinary(script, dir);
    assert.equal(result.code, 0);
    const argv = JSON.parse(result.stderr);
    assert.equal(argv[0], "review", `first arg must be 'review'; got ${JSON.stringify(argv)}`);
    assert.ok(
      argv.includes("--no-notify"),
      `defaultSpawnReview must pass --no-notify; got argv=${JSON.stringify(argv)}`,
    );
    assert.ok(
      argv.includes("--json"),
      `defaultSpawnReview must request --json; got argv=${JSON.stringify(argv)}`,
    );
    const prIdx = argv.indexOf("--pr");
    assert.ok(prIdx >= 0 && argv[prIdx + 1] === "999", `expected --pr 999; got argv=${JSON.stringify(argv)}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("v0.7.2 defaultSpawnReview: exit 5 (crash) throws with clear message", async () => {
  const { dir, script } = await makeFakeConclave(5, "", "boom: subprocess crashed");
  try {
    let caught = null;
    try {
      await callDefaultSpawnReviewWithFakeBinary(script, dir);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, "exit 5 must throw");
    assert.equal(caught.code, 5);
    assert.match(caught.stderr, /boom/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
