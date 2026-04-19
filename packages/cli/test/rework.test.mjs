import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseArgv,
  collectBlockerFiles,
  resolveEpisodic,
  runRework,
} from "../dist/commands/rework.js";
import { LoopGuard, CircuitBreaker } from "@conclave-ai/core";

// ---- parseArgv ------------------------------------------------------------

test("parseArgv: defaults + --pr", () => {
  const a = parseArgv(["--pr", "42"]);
  assert.equal(a.pr, 42);
  assert.equal(a.episodic, undefined);
  assert.equal(a.cwd, ".");
  assert.equal(a.dryRun, false);
  assert.equal(a.noPush, false);
  assert.equal(a.loopThreshold, 5);
  assert.equal(a.loopWindowMs, 3600_000);
  assert.equal(a.breakerThreshold, 3);
  assert.equal(a.help, false);
});

test("parseArgv: --episodic wins over --pr semantically but both can coexist", () => {
  const a = parseArgv(["--pr", "9", "--episodic", "ep-123"]);
  assert.equal(a.pr, 9);
  assert.equal(a.episodic, "ep-123");
});

test("parseArgv: flags", () => {
  const a = parseArgv(["--dry-run", "--no-push", "--cwd", "/repo", "--loop-threshold", "2"]);
  assert.equal(a.dryRun, true);
  assert.equal(a.noPush, true);
  assert.equal(a.cwd, "/repo");
  assert.equal(a.loopThreshold, 2);
});

test("parseArgv: --allow-secret is repeatable and --skip-secret-guard toggles", () => {
  const a = parseArgv(["--allow-secret", "openai-key", "--allow-secret", "aws-access-key", "--skip-secret-guard"]);
  assert.deepEqual(a.allowSecrets, ["openai-key", "aws-access-key"]);
  assert.equal(a.skipSecretGuard, true);
});

test("parseArgv: --help", () => {
  assert.equal(parseArgv(["--help"]).help, true);
  assert.equal(parseArgv(["-h"]).help, true);
});

test("parseArgv: rejects non-numeric --pr silently (leaves undefined)", () => {
  const a = parseArgv(["--pr", "abc"]);
  assert.equal(a.pr, undefined);
});

// ---- collectBlockerFiles --------------------------------------------------

test("collectBlockerFiles: dedupes paths across reviews", () => {
  const ep = {
    reviews: [
      {
        agent: "claude", verdict: "rework", summary: "", blockers: [
          { severity: "blocker", category: "x", message: "m", file: "a.ts" },
          { severity: "major", category: "y", message: "m", file: "b.ts" },
        ],
      },
      {
        agent: "openai", verdict: "rework", summary: "", blockers: [
          { severity: "blocker", category: "x", message: "m", file: "a.ts" },
          { severity: "minor", category: "z", message: "m" },
        ],
      },
    ],
  };
  assert.deepEqual(collectBlockerFiles(ep), ["a.ts", "b.ts"]);
});

test("collectBlockerFiles: handles empty reviews", () => {
  assert.deepEqual(collectBlockerFiles({ reviews: [] }), []);
});

// ---- resolveEpisodic ------------------------------------------------------

function makeStore(entries) {
  return {
    async listEpisodic() { return entries; },
    async findEpisodic(id) { return entries.find((e) => e.id === id) ?? null; },
  };
}

test("resolveEpisodic: --episodic id success", async () => {
  const store = makeStore([{ id: "ep-1", pullNumber: 1, outcome: "pending", createdAt: "t" }]);
  const e = await resolveEpisodic(store, { episodic: "ep-1" });
  assert.equal(e.id, "ep-1");
});

test("resolveEpisodic: --episodic id not found throws", async () => {
  const store = makeStore([]);
  await assert.rejects(() => resolveEpisodic(store, { episodic: "ep-missing" }), /not found/);
});

test("resolveEpisodic: --pr picks most recent pending", async () => {
  const store = makeStore([
    { id: "ep-old", pullNumber: 42, outcome: "pending", createdAt: "2026-04-18T00:00:00Z" },
    { id: "ep-new", pullNumber: 42, outcome: "pending", createdAt: "2026-04-20T00:00:00Z" },
    { id: "ep-merged", pullNumber: 42, outcome: "merged", createdAt: "2026-04-21T00:00:00Z" },
    { id: "ep-other", pullNumber: 7, outcome: "pending", createdAt: "2026-04-22T00:00:00Z" },
  ]);
  const e = await resolveEpisodic(store, { pr: 42 });
  assert.equal(e.id, "ep-new");
});

test("resolveEpisodic: --pr with no pending throws", async () => {
  const store = makeStore([{ id: "ep", pullNumber: 1, outcome: "merged", createdAt: "t" }]);
  await assert.rejects(() => resolveEpisodic(store, { pr: 1 }), /no pending episodic/);
});

test("resolveEpisodic: neither arg throws", async () => {
  const store = makeStore([]);
  await assert.rejects(() => resolveEpisodic(store, {}), /--pr or --episodic/);
});

// ---- runRework integration ------------------------------------------------

function makeEpisodic(overrides = {}) {
  return {
    id: "ep-abc",
    createdAt: "2026-04-20T00:00:00Z",
    repo: "acme/x",
    pullNumber: 1,
    sha: "old-sha",
    diffSha256: "a".repeat(64),
    councilVerdict: "rework",
    outcome: "pending",
    costUsd: 0.01,
    reviews: [
      {
        agent: "claude", verdict: "rework", summary: "s",
        blockers: [
          { severity: "blocker", category: "type-error", message: "fix type", file: "src/x.ts", line: 1 },
        ],
      },
    ],
    ...overrides,
  };
}

function makeWorker({ patch = "diff --git a/src/x.ts b/src/x.ts\n@@\n-a\n+b\n", message = "fix: x", appliedFiles = ["src/x.ts"] } = {}) {
  const calls = [];
  return {
    calls,
    work: async (ctx) => {
      calls.push(ctx);
      return { patch, message, appliedFiles, tokensUsed: 100, costUsd: 0.01 };
    },
  };
}

function makeGit() {
  const calls = [];
  return {
    calls,
    exec: async (bin, args, _opts) => {
      calls.push({ bin, args: [...args] });
      return { stdout: "", stderr: "" };
    },
  };
}

function makeGh(headSha = "head-sha-1", state = "OPEN") {
  return async (_bin, _args, _opts) => ({
    stdout: JSON.stringify({ state, headRefOid: headSha, updatedAt: "2026-04-20T00:00:00Z" }),
  });
}

function makeWriter() {
  const recorded = [];
  return {
    recorded,
    recordOutcome: async (input) => {
      recorded.push(input);
      return { answerKeys: [], failures: [] };
    },
  };
}

const fakeConfig = {
  config: { version: 1, agents: ["claude"], budget: { perPrUsd: 0.5 } },
  configDir: "/tmp/fake",
};

const baseArgs = {
  cwd: "/repo",
  dryRun: false,
  noPush: false,
  loopThreshold: 5,
  loopWindowMs: 3600_000,
  breakerThreshold: 3,
  allowSecrets: [],
  skipSecretGuard: false,
  help: false,
};

test("runRework: happy path — applies patch, commits, pushes, records outcome", async () => {
  const store = makeStore([makeEpisodic()]);
  const writer = makeWriter();
  const worker = makeWorker();
  const git = makeGit();
  const fileReads = [];
  const stdout = [];
  const stderr = [];
  const tempWrites = [];
  const tempRemoves = [];

  const code = await runRework(
    { ...baseArgs, pr: 1 },
    {
      loadConfig: async () => fakeConfig,
      store,
      writer,
      worker,
      gh: makeGh("head-sha-1"),
      git: git.exec,
      readFile: async (p) => {
        fileReads.push(p);
        return "export const x = 1;\n";
      },
      writeTempPatch: async (p, c) => { tempWrites.push({ p, c }); },
      removeTempPatch: async (p) => { tempRemoves.push(p); },
      stdout: (s) => stdout.push(s),
      stderr: (s) => stderr.push(s),
    },
  );

  assert.equal(code, 0, stderr.join(""));
  assert.equal(worker.calls.length, 1);
  assert.equal(worker.calls[0].newSha, "head-sha-1");
  assert.equal(worker.calls[0].repo, "acme/x");
  assert.equal(worker.calls[0].fileSnapshots.length, 1);
  assert.equal(worker.calls[0].fileSnapshots[0].path, "src/x.ts");
  assert.equal(tempWrites.length, 1);
  const gitCmds = git.calls.map((c) => c.args.join(" "));
  assert.ok(gitCmds.some((c) => c.startsWith("apply --check --recount")), `git apply --check --recount missing: ${gitCmds.join(" | ")}`);
  assert.ok(gitCmds.some((c) => c === `apply --recount ${tempWrites[0].p}`), "git apply --recount missing");
  assert.ok(gitCmds.some((c) => c === "add -A"), "git add -A missing");
  assert.ok(gitCmds.some((c) => c.includes("commit")), "git commit missing");
  assert.ok(gitCmds.some((c) => c === "push"), "git push missing");
  assert.equal(writer.recorded.length, 1);
  assert.equal(writer.recorded[0].outcome, "reworked");
  assert.equal(writer.recorded[0].episodicId, "ep-abc");
});

test("runRework: --dry-run skips git apply/commit/push and does not record outcome", async () => {
  const store = makeStore([makeEpisodic()]);
  const writer = makeWriter();
  const worker = makeWorker();
  const git = makeGit();
  const stdout = [];

  const code = await runRework(
    { ...baseArgs, pr: 1, dryRun: true },
    {
      loadConfig: async () => fakeConfig,
      store,
      writer,
      worker,
      gh: makeGh(),
      git: git.exec,
      readFile: async () => "x",
      stdout: (s) => stdout.push(s),
      stderr: () => {},
    },
  );

  assert.equal(code, 0);
  assert.equal(git.calls.length, 0, "no git commands should run on dry-run");
  assert.equal(writer.recorded.length, 0, "no outcome should be recorded on dry-run");
  assert.ok(stdout.join("").includes("--dry-run, not applying"));
});

test("runRework: --no-push applies + commits but does not push", async () => {
  const store = makeStore([makeEpisodic()]);
  const writer = makeWriter();
  const worker = makeWorker();
  const git = makeGit();

  const code = await runRework(
    { ...baseArgs, pr: 1, noPush: true },
    {
      loadConfig: async () => fakeConfig,
      store,
      writer,
      worker,
      gh: makeGh(),
      git: git.exec,
      readFile: async () => "x",
      writeTempPatch: async () => {},
      removeTempPatch: async () => {},
      stdout: () => {},
      stderr: () => {},
    },
  );

  assert.equal(code, 0);
  const gitCmds = git.calls.map((c) => c.args.join(" "));
  assert.ok(gitCmds.some((c) => c.includes("commit")), "commit should run");
  assert.ok(!gitCmds.some((c) => c === "push"), "push should NOT run");
  assert.equal(writer.recorded.length, 1);
});

test("runRework: PR not open returns exit 1", async () => {
  const store = makeStore([makeEpisodic()]);
  const writer = makeWriter();
  const worker = makeWorker();
  const stderr = [];

  const code = await runRework(
    { ...baseArgs, pr: 1 },
    {
      loadConfig: async () => fakeConfig,
      store,
      writer,
      worker,
      gh: makeGh("x", "MERGED"),
      git: makeGit().exec,
      readFile: async () => "x",
      stdout: () => {},
      stderr: (s) => stderr.push(s),
    },
  );

  assert.equal(code, 1);
  assert.ok(stderr.join("").includes("not open"));
  assert.equal(worker.calls.length, 0);
});

test("runRework: LoopGuard trip returns exit 2", async () => {
  const store = makeStore([makeEpisodic()]);
  const writer = makeWriter();
  const worker = makeWorker();
  const stderr = [];
  const guard = new LoopGuard({ threshold: 2, windowMs: 10 * 60_000 });
  // Pre-fill to trip immediately
  guard.check("acme/x#1:head-sha-1");
  guard.check("acme/x#1:head-sha-1");

  const code = await runRework(
    { ...baseArgs, pr: 1 },
    {
      loadConfig: async () => fakeConfig,
      store,
      writer,
      worker,
      gh: makeGh("head-sha-1"),
      git: makeGit().exec,
      readFile: async () => "x",
      loopGuard: guard,
      stdout: () => {},
      stderr: (s) => stderr.push(s),
    },
  );

  assert.equal(code, 2);
  assert.ok(stderr.join("").includes("loop guard"));
  assert.equal(worker.calls.length, 0);
});

test("runRework: CircuitBreaker open returns exit 2", async () => {
  const store = makeStore([makeEpisodic()]);
  const writer = makeWriter();
  const worker = makeWorker();
  const stderr = [];
  const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 60_000 });
  // Trip the breaker manually
  await breaker
    .guard("worker", async () => { throw new Error("boom"); })
    .catch(() => {});

  const code = await runRework(
    { ...baseArgs, pr: 1 },
    {
      loadConfig: async () => fakeConfig,
      store,
      writer,
      worker,
      gh: makeGh(),
      git: makeGit().exec,
      readFile: async () => "x",
      breaker,
      stdout: () => {},
      stderr: (s) => stderr.push(s),
    },
  );

  assert.equal(code, 2);
  assert.ok(stderr.join("").includes("circuit breaker"));
});

test("runRework: empty patch (worker gave up) returns exit 1", async () => {
  const store = makeStore([makeEpisodic()]);
  const writer = makeWriter();
  const worker = makeWorker({ patch: "", appliedFiles: [] });
  const git = makeGit();
  const stderr = [];

  const code = await runRework(
    { ...baseArgs, pr: 1 },
    {
      loadConfig: async () => fakeConfig,
      store,
      writer,
      worker,
      gh: makeGh(),
      git: git.exec,
      readFile: async () => "x",
      stdout: () => {},
      stderr: (s) => stderr.push(s),
    },
  );

  assert.equal(code, 1);
  assert.equal(git.calls.length, 0);
  assert.equal(writer.recorded.length, 0);
  assert.ok(stderr.join("").includes("could not produce a patch"));
});

test("runRework: git apply --check failure returns exit 1 and does NOT record outcome", async () => {
  const store = makeStore([makeEpisodic()]);
  const writer = makeWriter();
  const worker = makeWorker();
  const stderr = [];

  const git = async (_bin, args, _opts) => {
    if (args[0] === "apply" && args[1] === "--check") {
      throw new Error("error: patch does not apply");
    }
    return { stdout: "", stderr: "" };
  };

  const code = await runRework(
    { ...baseArgs, pr: 1 },
    {
      loadConfig: async () => fakeConfig,
      store,
      writer,
      worker,
      gh: makeGh(),
      git,
      readFile: async () => "x",
      writeTempPatch: async () => {},
      removeTempPatch: async () => {},
      stdout: () => {},
      stderr: (s) => stderr.push(s),
    },
  );

  assert.equal(code, 1);
  assert.equal(writer.recorded.length, 0);
  assert.ok(stderr.join("").includes("does not apply cleanly"));
});

test("runRework: missing blocker file is noted on stderr but worker still runs", async () => {
  const store = makeStore([makeEpisodic()]);
  const writer = makeWriter();
  const worker = makeWorker();
  const stderr = [];

  const code = await runRework(
    { ...baseArgs, pr: 1 },
    {
      loadConfig: async () => fakeConfig,
      store,
      writer,
      worker,
      gh: makeGh(),
      git: makeGit().exec,
      readFile: async () => { throw new Error("ENOENT"); },
      writeTempPatch: async () => {},
      removeTempPatch: async () => {},
      stdout: () => {},
      stderr: (s) => stderr.push(s),
    },
  );

  assert.equal(code, 0);
  assert.ok(stderr.join("").includes("could not read src/x.ts"));
  // Worker was still invoked, but with zero snapshots
  assert.equal(worker.calls[0].fileSnapshots.length, 0);
});

test("runRework: secret-guard blocks when worker patch contains a secret", async () => {
  const store = makeStore([makeEpisodic()]);
  const writer = makeWriter();
  const worker = makeWorker();
  const git = makeGit();
  const stderr = [];

  // Return a "blocked" scan result regardless of patch contents.
  const fakeScan = (_patch, _opts) => ({
    blocked: true,
    findings: [{
      ruleId: "openai-key",
      ruleName: "OpenAI API Key",
      confidence: "high",
      line: 3,
      column: 12,
      preview: "sk-a…89AB",
      file: "src/x.ts",
    }],
  });

  const code = await runRework(
    { ...baseArgs, pr: 1 },
    {
      loadConfig: async () => fakeConfig,
      store,
      writer,
      worker,
      gh: makeGh(),
      git: git.exec,
      readFile: async () => "x",
      writeTempPatch: async () => {},
      removeTempPatch: async () => {},
      secretScan: fakeScan,
      stdout: () => {},
      stderr: (s) => stderr.push(s),
    },
  );

  assert.equal(code, 1);
  assert.equal(git.calls.length, 0, "git should never run when secret-guard blocks");
  assert.equal(writer.recorded.length, 0, "no outcome should be recorded when blocked");
  const err = stderr.join("");
  assert.ok(err.includes("secret-guard blocked"));
  assert.ok(err.includes("openai-key"));
  assert.ok(err.includes("--allow-secret"));
});

test("runRework: --allow-secret forwards to the scanner", async () => {
  const store = makeStore([makeEpisodic()]);
  const writer = makeWriter();
  const worker = makeWorker();
  const git = makeGit();
  const seenAllow = [];
  const fakeScan = (_patch, opts) => {
    seenAllow.push(opts?.allow ?? []);
    return { blocked: false, findings: [] };
  };

  const code = await runRework(
    { ...baseArgs, pr: 1, allowSecrets: ["openai-key", "aws-access-key"] },
    {
      loadConfig: async () => fakeConfig,
      store,
      writer,
      worker,
      gh: makeGh(),
      git: git.exec,
      readFile: async () => "x",
      writeTempPatch: async () => {},
      removeTempPatch: async () => {},
      secretScan: fakeScan,
      stdout: () => {},
      stderr: () => {},
    },
  );

  assert.equal(code, 0);
  assert.deepEqual([...seenAllow[0]], ["openai-key", "aws-access-key"]);
});

test("runRework: --skip-secret-guard does not invoke the scanner at all", async () => {
  const store = makeStore([makeEpisodic()]);
  const writer = makeWriter();
  const worker = makeWorker();
  const git = makeGit();
  let scanCalls = 0;
  const fakeScan = () => { scanCalls += 1; return { blocked: true, findings: [] }; };

  const code = await runRework(
    { ...baseArgs, pr: 1, skipSecretGuard: true },
    {
      loadConfig: async () => fakeConfig,
      store,
      writer,
      worker,
      gh: makeGh(),
      git: git.exec,
      readFile: async () => "x",
      writeTempPatch: async () => {},
      removeTempPatch: async () => {},
      secretScan: fakeScan,
      stdout: () => {},
      stderr: () => {},
    },
  );

  assert.equal(code, 0);
  assert.equal(scanCalls, 0, "scanner must NOT be invoked when --skip-secret-guard is set");
});

test("runRework: low-confidence-only scan findings do NOT block", async () => {
  const store = makeStore([makeEpisodic()]);
  const writer = makeWriter();
  const worker = makeWorker();
  const git = makeGit();
  const stdout = [];
  const fakeScan = () => ({
    blocked: false,
    findings: [{ ruleId: "generic-password-assignment", ruleName: "x", confidence: "low", line: 1, column: 1, preview: "[redacted]" }],
  });

  const code = await runRework(
    { ...baseArgs, pr: 1 },
    {
      loadConfig: async () => fakeConfig,
      store,
      writer,
      worker,
      gh: makeGh(),
      git: git.exec,
      readFile: async () => "x",
      writeTempPatch: async () => {},
      removeTempPatch: async () => {},
      secretScan: fakeScan,
      stdout: (s) => stdout.push(s),
      stderr: () => {},
    },
  );

  assert.equal(code, 0);
  assert.ok(stdout.join("").includes("low/medium finding"));
});

test("runRework: commit is authored as conclave-worker[bot]", async () => {
  const store = makeStore([makeEpisodic()]);
  const writer = makeWriter();
  const worker = makeWorker();
  const git = makeGit();

  await runRework(
    { ...baseArgs, pr: 1 },
    {
      loadConfig: async () => fakeConfig,
      store,
      writer,
      worker,
      gh: makeGh(),
      git: git.exec,
      readFile: async () => "x",
      writeTempPatch: async () => {},
      removeTempPatch: async () => {},
      stdout: () => {},
      stderr: () => {},
    },
  );

  const commit = git.calls.find((c) => c.args.includes("commit"));
  assert.ok(commit, "commit call should exist");
  const joined = commit.args.join(" ");
  assert.ok(joined.includes("conclave-worker[bot]"), `author missing: ${joined}`);
  assert.ok(joined.includes("noreply@conclave.ai"), `email missing: ${joined}`);
});
