import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseArgv,
  parseVerdictFile,
  runAutofix,
  renderAutofixSummary,
  HARD_MAX_ITERATIONS,
  HARD_MAX_BUDGET_USD,
  DIFF_BUDGET_LINES,
} from "../dist/commands/autofix.js";
import {
  detectCommand,
  runCommand,
  summarizeFailure,
} from "../dist/lib/build-verifier.js";
import {
  isFileDenied,
  summarizeAutofixPatches,
  dedupeBlockersAcrossAgents,
  LoopGuard,
  CircuitBreaker,
} from "@conclave-ai/core";

// ---- parseArgv ------------------------------------------------------------

test("parseArgv: defaults", () => {
  const a = parseArgv([]);
  assert.equal(a.budgetUsd, 3);
  assert.equal(a.maxIterations, 2);
  assert.equal(a.autonomy, "l2");
  assert.equal(a.cwd, ".");
  assert.equal(a.dryRun, false);
  assert.equal(a.skipSecretGuard, false);
});

test("parseArgv: --budget is clamped to HARD_MAX_BUDGET_USD", () => {
  const a = parseArgv(["--budget", "25"]);
  assert.equal(a.budgetUsd, HARD_MAX_BUDGET_USD);
});

test("parseArgv: --max-iterations is clamped to HARD_MAX_ITERATIONS", () => {
  const a = parseArgv(["--max-iterations", "10"]);
  assert.equal(a.maxIterations, HARD_MAX_ITERATIONS);
});

test("parseArgv: --autonomy l3 + --dry-run + flags", () => {
  const a = parseArgv(["--autonomy", "l3", "--dry-run", "--cwd", "/repo", "--pr", "21"]);
  assert.equal(a.autonomy, "l3");
  assert.equal(a.dryRun, true);
  assert.equal(a.cwd, "/repo");
  assert.equal(a.pr, 21);
});

test("parseArgv: --build-cmd and --test-cmd override detection", () => {
  const a = parseArgv(["--build-cmd", "make build", "--test-cmd", "make check"]);
  assert.equal(a.buildCmd, "make build");
  assert.equal(a.testCmd, "make check");
});

// ---- v0.10: --rework-cycle parsing ---------------------------------------

test("parseArgv: --rework-cycle defaults to 0", () => {
  const a = parseArgv([]);
  assert.equal(a.reworkCycle, 0);
});

test("parseArgv: --rework-cycle 2 parses to 2", () => {
  const a = parseArgv(["--rework-cycle", "2"]);
  assert.equal(a.reworkCycle, 2);
});

test("parseArgv: --rework-cycle clamps above hard ceiling (5)", () => {
  const a = parseArgv(["--rework-cycle", "99"]);
  assert.equal(a.reworkCycle, 5);
});

test("parseArgv: --rework-cycle ignores negative values (treated as default 0)", () => {
  const a = parseArgv(["--rework-cycle", "-1"]);
  assert.equal(a.reworkCycle, 0);
});

test("parseArgv: --rework-cycle ignores non-numeric input", () => {
  const a = parseArgv(["--rework-cycle", "wat"]);
  assert.equal(a.reworkCycle, 0);
});

// ---- core autofix helpers (pure) -----------------------------------------

test("isFileDenied: matches .env, *.pem, *secret*", () => {
  assert.equal(isFileDenied(".env"), true);
  assert.equal(isFileDenied(".env.production"), true);
  assert.equal(isFileDenied("secrets/foo.key"), true);
  assert.equal(isFileDenied("server.pem"), true);
  assert.equal(isFileDenied("src/index.ts"), false);
  assert.equal(isFileDenied("config/credentials.json"), true);
});

test("summarizeAutofixPatches: counts + files across multiple patches", () => {
  const p1 =
    "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@\n-a\n+b\n+c\n";
  const p2 =
    "diff --git a/y.ts b/y.ts\n--- a/y.ts\n+++ b/y.ts\n@@\n-d\n+e\n";
  const s = summarizeAutofixPatches([p1, p2]);
  assert.equal(s.totalFiles, 2);
  assert.equal(s.totalLines, 2 + 1 + 1 + 1); // +b +c -a -d +e
});

test("dedupeBlockersAcrossAgents: dedupes same (category, file, message-prefix) across agents", () => {
  const reviews = [
    {
      agent: "claude",
      verdict: "rework",
      summary: "",
      blockers: [
        { severity: "blocker", category: "type-error", message: "fix thing", file: "a.ts" },
        { severity: "nit", category: "style", message: "spaces", file: "b.ts" },
      ],
    },
    {
      agent: "openai",
      verdict: "rework",
      summary: "",
      blockers: [
        { severity: "blocker", category: "type-error", message: "fix thing", file: "a.ts" },
        { severity: "major", category: "sec", message: "bad input", file: "c.ts" },
      ],
    },
  ];
  const out = dedupeBlockersAcrossAgents(reviews);
  // nit dropped, dup collapsed -> 2 entries
  assert.equal(out.length, 2);
  assert.equal(out[0].blocker.file, "a.ts");
  assert.equal(out[1].blocker.file, "c.ts");
});

// ---- parseVerdictFile -----------------------------------------------------

test("parseVerdictFile: accepts episodic shape", () => {
  const raw = JSON.stringify({
    councilVerdict: "rework",
    reviews: [{ agent: "claude", verdict: "rework", summary: "", blockers: [] }],
  });
  const p = parseVerdictFile(raw);
  assert.equal(p.verdict, "rework");
});

test("parseVerdictFile: rejects malformed JSON", () => {
  assert.throws(() => parseVerdictFile("{ not json"));
});

test("parseVerdictFile: rejects missing verdict field", () => {
  assert.throws(() => parseVerdictFile(JSON.stringify({ reviews: [] })));
});

// ---- detectCommand --------------------------------------------------------

test("detectCommand: package.json with build script detects pnpm run build", async () => {
  const fakeStat = async () => ({ isFile: () => true });
  const fakeRead = async () =>
    JSON.stringify({ scripts: { build: "tsc", test: "node --test" }, packageManager: "pnpm@10.0.0" });
  const r = await detectCommand("/repo", "build", { stat: fakeStat, readFile: fakeRead });
  assert.equal(r.command, "pnpm run build");
  assert.equal(r.detectedFrom, "package.json");
});

test("detectCommand: falls back to cargo.toml when package.json absent", async () => {
  const fakeStat = async (p) => {
    if (p.endsWith("Cargo.toml")) return { isFile: () => true };
    throw new Error("ENOENT");
  };
  const fakeRead = async () => { throw new Error("ENOENT"); };
  const r = await detectCommand("/repo", "test", { stat: fakeStat, readFile: fakeRead });
  assert.equal(r.command, "cargo test");
  assert.equal(r.detectedFrom, "cargo.toml");
});

test("detectCommand: returns null when nothing matches", async () => {
  const fakeStat = async () => { throw new Error("ENOENT"); };
  const fakeRead = async () => { throw new Error("ENOENT"); };
  const r = await detectCommand("/repo", "build", { stat: fakeStat, readFile: fakeRead });
  assert.equal(r, null);
});

test("runCommand: failure returns success=false with tail output", async () => {
  const fakeRun = async () => {
    const err = new Error("x");
    err.stderr = "compilation failed\nTS2345";
    throw err;
  };
  const r = await runCommand("pnpm build", "/repo", 5000, { run: fakeRun, now: () => 0 });
  assert.equal(r.success, false);
  assert.ok(r.stderr.includes("compilation failed"));
});

test("summarizeFailure: trims to last 2KB + includes command", () => {
  const result = {
    success: false,
    command: "pnpm test",
    stdout: "",
    stderr: "x".repeat(3000),
    durationMs: 1234,
    detectedFrom: "explicit",
  };
  const s = summarizeFailure(result);
  assert.ok(s.includes(`"pnpm test"`));
  assert.ok(s.length < 3000);
});

// ---- runAutofix ----------------------------------------------------------

const fakeConfig = {
  config: { version: 1, agents: ["claude"], budget: { perPrUsd: 0.5 } },
  configDir: "/tmp/fake",
};

function makeWorker({
  patch = "diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@\n-a\n+b\n",
  message = "fix: x",
  appliedFiles = ["src/x.ts"],
  costUsd = 0.01,
} = {}) {
  const calls = [];
  return {
    calls,
    work: async (ctx) => {
      calls.push(ctx);
      return { patch, message, appliedFiles, costUsd, tokensUsed: 100 };
    },
  };
}

function makeGit(overrides = {}) {
  const calls = [];
  const runner = async (bin, args) => {
    calls.push({ bin, args: [...args] });
    if (overrides.applyCheckFails && args[0] === "apply" && args[1] === "--check") {
      throw new Error("error: patch does not apply cleanly");
    }
    if (overrides.applyFails && args[0] === "apply" && args[1] !== "--check") {
      throw new Error("error: cannot apply");
    }
    return { stdout: "", stderr: "", code: 0 };
  };
  return { calls, exec: runner };
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

function makeReviewRunner(responses) {
  let i = 0;
  return async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return r;
  };
}

// 1. Happy path — 2 blockers, both fixed, build+test pass, auto-commit, L2 awaiting
test("runAutofix: happy path — L2 commits + awaits approval", async () => {
  const worker = makeWorker();
  const git = makeGit();
  const verifier = makeVerifier();
  const mergeCalls = [];

  const initialReviews = [
    {
      agent: "claude",
      verdict: "rework",
      summary: "",
      blockers: [
        { severity: "blocker", category: "type-error", message: "fix a", file: "src/x.ts" },
        { severity: "major", category: "bad-pattern", message: "fix b", file: "src/y.ts" },
      ],
    },
  ];

  const { code, result } = await runAutofix(
    { ...baseArgs, pr: 21 },
    {
      loadConfig: async () => fakeConfig,
      worker,
      git: git.exec,
      verifier,
      readFile: async () => "old content",
      writeTempPatch: async () => {},
      removeTempPatch: async () => {},
      mergePr: async (n) => { mergeCalls.push(n); },
      gh: async () => ({ stdout: JSON.stringify({ state: "OPEN", headRefOid: "head-sha", updatedAt: "t", headRepository: { name: "r" }, headRepositoryOwner: { login: "o" } }), stderr: "" }),
      runReview: makeReviewRunner([
        { verdict: "rework", reviews: initialReviews },
        { verdict: "approve", reviews: [{ agent: "claude", verdict: "approve", summary: "", blockers: [] }] },
      ]),
      stdout: () => {},
      stderr: () => {},
    },
  );

  assert.equal(code, 0);
  assert.equal(result.status, "awaiting-approval");
  assert.equal(result.finalVerdict, "approve");
  assert.equal(result.iterations.length, 1);
  assert.equal(result.iterations[0].verified, true);
  assert.equal(result.mergeStatus, "not-merged");
  assert.equal(mergeCalls.length, 0, "L2 must NOT auto-merge");
  assert.ok(worker.calls.length >= 2, `expected >=2 worker calls, got ${worker.calls.length}`);
});

// ---- v0.10: cycle marker in commit message --------------------------------

function findCommitArgs(gitCalls) {
  // git is invoked via execFile-style runner; the `git commit -m ...` call
  // has args[0] === "commit". We have to skip the leading -c overrides we
  // pass to set the bot author.
  const commit = gitCalls.find((c) => c.bin === "git" && c.args.includes("commit"));
  if (!commit) return null;
  const idx = commit.args.indexOf("-m");
  if (idx < 0 || idx + 1 >= commit.args.length) return null;
  return commit.args[idx + 1];
}

async function runHappyPathWithArgs(extraArgs, runReviewResponses, env) {
  const worker = makeWorker();
  const git = makeGit();
  const verifier = makeVerifier();
  const initialReviews = [
    {
      agent: "claude",
      verdict: "rework",
      summary: "",
      blockers: [
        { severity: "blocker", category: "type-error", message: "m", file: "src/x.ts" },
      ],
    },
  ];
  const before = process.env["CONCLAVE_AUTONOMY_LOOP"];
  if (env && env.CONCLAVE_AUTONOMY_LOOP !== undefined) {
    process.env["CONCLAVE_AUTONOMY_LOOP"] = env.CONCLAVE_AUTONOMY_LOOP;
  } else {
    delete process.env["CONCLAVE_AUTONOMY_LOOP"];
  }
  try {
    const out = await runAutofix(
      { ...baseArgs, pr: 21, ...extraArgs },
      {
        loadConfig: async () => fakeConfig,
        worker,
        git: git.exec,
        verifier,
        readFile: async () => "x",
        writeTempPatch: async () => {},
        removeTempPatch: async () => {},
        mergePr: async () => {},
        gh: async () => ({
          stdout: JSON.stringify({
            state: "OPEN",
            headRefOid: "h",
            updatedAt: "t",
            headRepository: { name: "r" },
            headRepositoryOwner: { login: "o" },
          }),
          stderr: "",
        }),
        runReview: makeReviewRunner(
          runReviewResponses ?? [
            { verdict: "rework", reviews: initialReviews },
            {
              verdict: "approve",
              reviews: [{ agent: "claude", verdict: "approve", summary: "", blockers: [] }],
            },
          ],
        ),
        stdout: () => {},
        stderr: () => {},
      },
    );
    return { ...out, gitCalls: git.calls };
  } finally {
    if (before === undefined) delete process.env["CONCLAVE_AUTONOMY_LOOP"];
    else process.env["CONCLAVE_AUTONOMY_LOOP"] = before;
  }
}

test("runAutofix: reworkCycle=0 + no env → commit message has NO cycle marker (local-dev path)", async () => {
  const { result, gitCalls } = await runHappyPathWithArgs({ reworkCycle: 0 });
  assert.equal(result.iterations.length, 1);
  const commitMsg = findCommitArgs(gitCalls);
  assert.ok(commitMsg, "expected a git commit invocation");
  assert.ok(
    !commitMsg.includes("[conclave-rework-cycle:"),
    `local-dev autofix must NOT embed cycle marker; got: ${commitMsg}`,
  );
});

test("runAutofix: reworkCycle=2 → commit message embeds [conclave-rework-cycle:3]", async () => {
  const { result, gitCalls } = await runHappyPathWithArgs({ reworkCycle: 2 });
  assert.equal(result.iterations.length, 1);
  const commitMsg = findCommitArgs(gitCalls);
  assert.ok(commitMsg, "expected a git commit invocation");
  assert.ok(
    commitMsg.includes("[conclave-rework-cycle:3]"),
    `expected marker [conclave-rework-cycle:3] in commit; got: ${commitMsg}`,
  );
});

test("runAutofix: reworkCycle=0 + CONCLAVE_AUTONOMY_LOOP=1 → marker bumps to 1", async () => {
  const { result, gitCalls } = await runHappyPathWithArgs(
    { reworkCycle: 0 },
    null,
    { CONCLAVE_AUTONOMY_LOOP: "1" },
  );
  assert.equal(result.iterations.length, 1);
  const commitMsg = findCommitArgs(gitCalls);
  assert.ok(commitMsg, "expected a git commit invocation");
  assert.ok(
    commitMsg.includes("[conclave-rework-cycle:1]"),
    `loop env must force marker even when reworkCycle=0; got: ${commitMsg}`,
  );
});

test("runAutofix: reworkCycle=5 (at ceiling) → marker stays at 5, never exceeds", async () => {
  const { result, gitCalls } = await runHappyPathWithArgs({ reworkCycle: 5 });
  assert.equal(result.iterations.length, 1);
  const commitMsg = findCommitArgs(gitCalls);
  assert.ok(commitMsg, "expected a git commit invocation");
  assert.ok(
    commitMsg.includes("[conclave-rework-cycle:5]"),
    `marker must clamp to ceiling; got: ${commitMsg}`,
  );
  assert.ok(
    !commitMsg.includes("[conclave-rework-cycle:6]"),
    `marker must NOT exceed hard ceiling; got: ${commitMsg}`,
  );
});

// 2. L3 autonomy: auto-merges on approve
test("runAutofix: L3 autonomy calls gh pr merge", async () => {
  const worker = makeWorker();
  const git = makeGit();
  const verifier = makeVerifier();
  const mergeCalls = [];

  const { code, result } = await runAutofix(
    { ...baseArgs, pr: 21, autonomy: "l3" },
    {
      loadConfig: async () => fakeConfig,
      worker,
      git: git.exec,
      verifier,
      readFile: async () => "x",
      writeTempPatch: async () => {},
      removeTempPatch: async () => {},
      mergePr: async (n) => { mergeCalls.push(n); },
      gh: async () => ({ stdout: JSON.stringify({ state: "OPEN", headRefOid: "h", updatedAt: "t", headRepository: { name: "r" }, headRepositoryOwner: { login: "o" } }), stderr: "" }),
      runReview: makeReviewRunner([
        { verdict: "rework", reviews: [{ agent: "claude", verdict: "rework", summary: "", blockers: [{ severity: "blocker", category: "type-error", message: "m", file: "x.ts" }] }] },
        { verdict: "approve", reviews: [{ agent: "claude", verdict: "approve", summary: "", blockers: [] }] },
      ]),
      stdout: () => {},
      stderr: () => {},
    },
  );

  assert.equal(code, 0);
  assert.equal(result.status, "approved");
  assert.equal(result.mergeStatus, "merged");
  assert.deepEqual(mergeCalls, [21]);
});

// 3. Patch conflict: drop patch, continue
test("runAutofix: patch conflict → dropped, no apply attempted for that fix", async () => {
  const worker = makeWorker({ patch: "bogus patch, not a diff" });
  const git = makeGit({ applyCheckFails: true });
  const verifier = makeVerifier();

  const { code, result } = await runAutofix(
    { ...baseArgs, pr: 1 },
    {
      loadConfig: async () => fakeConfig,
      worker,
      git: git.exec,
      verifier,
      readFile: async () => "x",
      writeTempPatch: async () => {},
      removeTempPatch: async () => {},
      gh: async () => ({ stdout: JSON.stringify({ state: "OPEN", headRefOid: "h", updatedAt: "t", headRepository: { name: "r" }, headRepositoryOwner: { login: "o" } }), stderr: "" }),
      runReview: makeReviewRunner([
        { verdict: "rework", reviews: [{ agent: "claude", verdict: "rework", summary: "", blockers: [{ severity: "blocker", category: "type-error", message: "m", file: "x.ts" }] }] },
      ]),
      stdout: () => {},
      stderr: () => {},
    },
  );

  assert.equal(code, 1);
  assert.ok(["bailed-no-patches", "bailed-max-iterations"].includes(result.status), `got ${result.status}`);
  // All fixes should be "conflict"
  const iter = result.iterations[0];
  assert.ok(iter.fixes.every((f) => f.status === "conflict" || f.status === "worker-error"));
});

// 4. Build fails after patch → don't commit, bail
test("runAutofix: build fails → revert + bail", async () => {
  const worker = makeWorker();
  const git = makeGit();
  const verifier = makeVerifier({ buildOk: false });

  const { code, result } = await runAutofix(
    { ...baseArgs, pr: 1, maxIterations: 1 },
    {
      loadConfig: async () => fakeConfig,
      worker,
      git: git.exec,
      verifier,
      readFile: async () => "x",
      writeTempPatch: async () => {},
      removeTempPatch: async () => {},
      gh: async () => ({ stdout: JSON.stringify({ state: "OPEN", headRefOid: "h", updatedAt: "t", headRepository: { name: "r" }, headRepositoryOwner: { login: "o" } }), stderr: "" }),
      runReview: makeReviewRunner([
        { verdict: "rework", reviews: [{ agent: "claude", verdict: "rework", summary: "", blockers: [{ severity: "blocker", category: "type-error", message: "m", file: "x.ts" }] }] },
      ]),
      stdout: () => {},
      stderr: () => {},
    },
  );

  assert.equal(code, 1);
  assert.equal(result.status, "bailed-build-failed");
  // No commit should have been recorded
  const committed = git.calls.some((c) => c.args.includes("commit"));
  assert.equal(committed, false, "commit must NOT happen when build fails");
  // Reset was called
  assert.ok(git.calls.some((c) => c.args.join(" ").includes("reset --hard HEAD")));
});

// 5. Tests fail → don't commit
test("runAutofix: tests fail → revert, do NOT commit", async () => {
  const worker = makeWorker();
  const git = makeGit();
  const verifier = makeVerifier({ testsOk: false });

  const { code, result } = await runAutofix(
    { ...baseArgs, pr: 1, maxIterations: 1 },
    {
      loadConfig: async () => fakeConfig,
      worker,
      git: git.exec,
      verifier,
      readFile: async () => "x",
      writeTempPatch: async () => {},
      removeTempPatch: async () => {},
      gh: async () => ({ stdout: JSON.stringify({ state: "OPEN", headRefOid: "h", updatedAt: "t", headRepository: { name: "r" }, headRepositoryOwner: { login: "o" } }), stderr: "" }),
      runReview: makeReviewRunner([
        { verdict: "rework", reviews: [{ agent: "claude", verdict: "rework", summary: "", blockers: [{ severity: "blocker", category: "type-error", message: "m", file: "x.ts" }] }] },
      ]),
      stdout: () => {},
      stderr: () => {},
    },
  );

  assert.equal(code, 1);
  assert.equal(result.status, "bailed-tests-failed");
  const committed = git.calls.some((c) => c.args.includes("commit"));
  assert.equal(committed, false, "commit must NOT happen when tests fail");
});

// 6. Secret-guard blocks
test("runAutofix: secret-guard blocks patches with secrets", async () => {
  const worker = makeWorker();
  const git = makeGit();
  const verifier = makeVerifier();
  const secretScan = () => ({
    blocked: true,
    findings: [{ ruleId: "openai-key", ruleName: "OpenAI", confidence: "high", line: 1, column: 1, preview: "sk-…" }],
  });

  const { code, result } = await runAutofix(
    { ...baseArgs, pr: 1 },
    {
      loadConfig: async () => fakeConfig,
      worker,
      git: git.exec,
      verifier,
      secretScan,
      readFile: async () => "x",
      writeTempPatch: async () => {},
      removeTempPatch: async () => {},
      gh: async () => ({ stdout: JSON.stringify({ state: "OPEN", headRefOid: "h", updatedAt: "t", headRepository: { name: "r" }, headRepositoryOwner: { login: "o" } }), stderr: "" }),
      runReview: makeReviewRunner([
        { verdict: "rework", reviews: [{ agent: "claude", verdict: "rework", summary: "", blockers: [{ severity: "blocker", category: "type-error", message: "m", file: "x.ts" }] }] },
      ]),
      stdout: () => {},
      stderr: () => {},
    },
  );

  assert.equal(code, 1);
  // Should not commit
  const committed = git.calls.some((c) => c.args.includes("commit"));
  assert.equal(committed, false);
  // Fix marked secret-block
  assert.ok(result.iterations[0].fixes.some((f) => f.status === "secret-block"));
});

// 7. Diff budget exceeded
test("runAutofix: diff budget exceeded → bail", async () => {
  // Synthesize a patch bigger than DIFF_BUDGET_LINES.
  const hugePatchBody = Array.from({ length: DIFF_BUDGET_LINES + 50 }, (_, i) => `+line ${i}`).join("\n");
  const patch = `diff --git a/big.ts b/big.ts\n--- a/big.ts\n+++ b/big.ts\n@@\n${hugePatchBody}\n`;
  const worker = makeWorker({ patch, appliedFiles: ["big.ts"] });
  const git = makeGit();
  const verifier = makeVerifier();

  const { code, result } = await runAutofix(
    { ...baseArgs, pr: 1 },
    {
      loadConfig: async () => fakeConfig,
      worker,
      git: git.exec,
      verifier,
      readFile: async () => "x",
      writeTempPatch: async () => {},
      removeTempPatch: async () => {},
      gh: async () => ({ stdout: JSON.stringify({ state: "OPEN", headRefOid: "h", updatedAt: "t", headRepository: { name: "r" }, headRepositoryOwner: { login: "o" } }), stderr: "" }),
      runReview: makeReviewRunner([
        { verdict: "rework", reviews: [{ agent: "claude", verdict: "rework", summary: "", blockers: [{ severity: "blocker", category: "type-error", message: "m", file: "big.ts" }] }] },
      ]),
      stdout: () => {},
      stderr: () => {},
    },
  );

  assert.equal(code, 2);
  assert.equal(result.status, "bailed-diff-budget");
  const committed = git.calls.some((c) => c.args.includes("commit"));
  assert.equal(committed, false);
});

// 8. File allowlist blocks .env.production
test("runAutofix: file deny-list blocks .env.production", async () => {
  const worker = makeWorker();
  const git = makeGit();
  const verifier = makeVerifier();

  const { result } = await runAutofix(
    { ...baseArgs, pr: 1, maxIterations: 1 },
    {
      loadConfig: async () => fakeConfig,
      worker,
      git: git.exec,
      verifier,
      readFile: async () => "x",
      writeTempPatch: async () => {},
      removeTempPatch: async () => {},
      gh: async () => ({ stdout: JSON.stringify({ state: "OPEN", headRefOid: "h", updatedAt: "t", headRepository: { name: "r" }, headRepositoryOwner: { login: "o" } }), stderr: "" }),
      runReview: makeReviewRunner([
        { verdict: "rework", reviews: [{ agent: "claude", verdict: "rework", summary: "", blockers: [{ severity: "blocker", category: "type-error", message: "fix", file: ".env.production" }] }] },
      ]),
      stdout: () => {},
      stderr: () => {},
    },
  );

  // Fix should be marked skipped with deny-list reason
  const f = result.iterations[0].fixes[0];
  assert.equal(f.status, "skipped");
  assert.ok(/deny-list|.env/.test(f.reason ?? ""));
});

// 9. Design-domain blocker skipped
test("runAutofix: design-domain blockers are skipped in v0.7", async () => {
  const worker = makeWorker();
  const git = makeGit();

  const { result } = await runAutofix(
    { ...baseArgs, pr: 1, maxIterations: 1 },
    {
      loadConfig: async () => fakeConfig,
      worker,
      git: git.exec,
      verifier: makeVerifier(),
      readFile: async () => "x",
      writeTempPatch: async () => {},
      removeTempPatch: async () => {},
      gh: async () => ({ stdout: JSON.stringify({ state: "OPEN", headRefOid: "h", updatedAt: "t", headRepository: { name: "r" }, headRepositoryOwner: { login: "o" } }), stderr: "" }),
      runReview: makeReviewRunner([
        { verdict: "rework", reviews: [{ agent: "design", verdict: "rework", summary: "", blockers: [{ severity: "blocker", category: "design-contrast", message: "contrast too low", file: "src/App.tsx" }] }] },
      ]),
      stdout: () => {},
      stderr: () => {},
    },
  );

  const f = result.iterations[0].fixes[0];
  assert.equal(f.status, "skipped");
  assert.ok(/design|visual/i.test(f.reason ?? ""));
});

// 10. --dry-run: shows patches without applying
test("runAutofix: --dry-run prints but does not apply", async () => {
  const worker = makeWorker();
  const git = makeGit();
  const stdout = [];

  const { code, result } = await runAutofix(
    { ...baseArgs, pr: 1, dryRun: true, maxIterations: 1 },
    {
      loadConfig: async () => fakeConfig,
      worker,
      git: git.exec,
      verifier: makeVerifier(),
      readFile: async () => "x",
      writeTempPatch: async () => {},
      removeTempPatch: async () => {},
      gh: async () => ({ stdout: JSON.stringify({ state: "OPEN", headRefOid: "h", updatedAt: "t", headRepository: { name: "r" }, headRepositoryOwner: { login: "o" } }), stderr: "" }),
      runReview: makeReviewRunner([
        { verdict: "rework", reviews: [{ agent: "claude", verdict: "rework", summary: "", blockers: [{ severity: "blocker", category: "type-error", message: "m", file: "x.ts" }] }] },
      ]),
      stdout: (s) => stdout.push(s),
      stderr: () => {},
    },
  );

  assert.equal(code, 0);
  assert.equal(result.status, "dry-run");
  // No apply, no commit
  const s = git.calls.map((c) => c.args.join(" ")).join(" | ");
  assert.ok(!s.includes("apply --recount"), `git apply should not run in dry-run: ${s}`);
  assert.ok(stdout.join("").includes("dry-run"));
});

// 11. LoopGuard trips
test("runAutofix: LoopGuard trip → exit 2", async () => {
  // fetchPrState returns repo="" in this mock path (test injects only the shape
  // fields). Pre-seed both possible loopKey shapes so we don't depend on the
  // exact repo-resolution fallback:
  const guard = new LoopGuard({ threshold: 0, windowMs: 60_000 });
  // With threshold=0 any single check triggers the LoopDetectedError.

  const { code, result } = await runAutofix(
    { ...baseArgs, pr: 1 },
    {
      loadConfig: async () => fakeConfig,
      loopGuard: guard,
      worker: makeWorker(),
      git: makeGit().exec,
      verifier: makeVerifier(),
      readFile: async () => "x",
      gh: async () => ({ stdout: JSON.stringify({ state: "OPEN", headRefOid: "h", updatedAt: "t", headRepository: { name: "r" }, headRepositoryOwner: { login: "o" } }), stderr: "" }),
      runReview: async () => ({ verdict: "rework", reviews: [] }),
      stdout: () => {},
      stderr: () => {},
    },
  );

  assert.equal(code, 2);
  assert.equal(result.status, "bailed-loop-guard");
});

// 12. CircuitBreaker trips (3 consecutive worker errors)
test("runAutofix: circuit breaker trips after consecutive worker errors", async () => {
  const worker = { work: async () => { throw new Error("LLM down"); } };
  const git = makeGit();
  const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 60_000 });
  // Pre-trip the breaker
  await breaker.guard("worker", async () => { throw new Error("pre-trip"); }).catch(() => {});

  const { code, result } = await runAutofix(
    { ...baseArgs, pr: 1 },
    {
      loadConfig: async () => fakeConfig,
      worker,
      breaker,
      git: git.exec,
      verifier: makeVerifier(),
      readFile: async () => "x",
      gh: async () => ({ stdout: JSON.stringify({ state: "OPEN", headRefOid: "h", updatedAt: "t", headRepository: { name: "r" }, headRepositoryOwner: { login: "o" } }), stderr: "" }),
      runReview: makeReviewRunner([
        { verdict: "rework", reviews: [{ agent: "claude", verdict: "rework", summary: "", blockers: [{ severity: "blocker", category: "type-error", message: "m", file: "x.ts" }] }] },
      ]),
      stdout: () => {},
      stderr: () => {},
    },
  );

  assert.equal(code, 2);
  assert.equal(result.status, "bailed-circuit");
});

// 13. PR not open
test("runAutofix: PR not open → exit 1", async () => {
  const { code, result } = await runAutofix(
    { ...baseArgs, pr: 1 },
    {
      loadConfig: async () => fakeConfig,
      worker: makeWorker(),
      git: makeGit().exec,
      verifier: makeVerifier(),
      readFile: async () => "x",
      gh: async () => ({ stdout: JSON.stringify({ state: "MERGED", headRefOid: "h", updatedAt: "t", headRepository: { name: "r" }, headRepositoryOwner: { login: "o" } }), stderr: "" }),
      runReview: async () => ({ verdict: "rework", reviews: [] }),
      stdout: () => {},
      stderr: () => {},
    },
  );

  assert.equal(code, 1);
  assert.ok(result.status.startsWith("bailed"));
});

// 14. Verdict file input bypass
test("runAutofix: --verdict JSON bypasses initial review", async () => {
  const worker = makeWorker();
  const git = makeGit();
  const verifier = makeVerifier();
  let reviewRuns = 0;

  const verdictJson = JSON.stringify({
    repo: "o/r",
    pullNumber: 42,
    sha: "head-sha",
    councilVerdict: "rework",
    reviews: [
      {
        agent: "claude", verdict: "rework", summary: "",
        blockers: [{ severity: "blocker", category: "type-error", message: "fix", file: "src/x.ts" }],
      },
    ],
  });

  const { code, result } = await runAutofix(
    { ...baseArgs, pr: 42, verdictFile: "/tmp/verdict.json", maxIterations: 1 },
    {
      loadConfig: async () => fakeConfig,
      worker,
      git: git.exec,
      verifier,
      readVerdictFile: async () => verdictJson,
      readFile: async () => "x",
      writeTempPatch: async () => {},
      removeTempPatch: async () => {},
      gh: async () => ({ stdout: JSON.stringify({ state: "OPEN", headRefOid: "head-sha", updatedAt: "t", headRepository: { name: "r" }, headRepositoryOwner: { login: "o" } }), stderr: "" }),
      runReview: async () => { reviewRuns += 1; return { verdict: "approve", reviews: [] }; },
      stdout: () => {},
      stderr: () => {},
    },
  );

  assert.equal(code, 0);
  // runReview should have been called at most ONCE (for the meta-review after commit), never for the initial verdict.
  assert.ok(reviewRuns <= 1, `reviewRuns=${reviewRuns} — initial review not bypassed`);
});

// 15. Max iterations reached → post bailout comment
test("runAutofix: max iterations reached → bailed-max-iterations", async () => {
  const worker = makeWorker();
  const git = makeGit();
  const verifier = makeVerifier();
  const ghCalls = [];

  const blockers = [{ severity: "blocker", category: "type-error", message: "stubborn", file: "x.ts" }];

  const { code, result } = await runAutofix(
    { ...baseArgs, pr: 1, maxIterations: 2 },
    {
      loadConfig: async () => fakeConfig,
      worker,
      git: git.exec,
      verifier,
      readFile: async () => "x",
      writeTempPatch: async () => {},
      removeTempPatch: async () => {},
      gh: async (bin, args) => {
        ghCalls.push(args.slice(0, 2));
        return { stdout: JSON.stringify({ state: "OPEN", headRefOid: "h", updatedAt: "t", headRepository: { name: "r" }, headRepositoryOwner: { login: "o" } }), stderr: "" };
      },
      runReview: async () => ({ verdict: "rework", reviews: [{ agent: "claude", verdict: "rework", summary: "", blockers }] }),
      stdout: () => {},
      stderr: () => {},
    },
  );

  assert.equal(code, 1);
  assert.equal(result.status, "bailed-max-iterations");
  // gh pr comment should have been attempted
  const commentCalls = ghCalls.filter((a) => a[0] === "pr" && a[1] === "comment");
  assert.ok(commentCalls.length >= 1, "should post bailout comment");
});

// 16. Budget exhaustion mid-loop
test("runAutofix: budget exhaustion stops more worker calls", async () => {
  const worker = makeWorker({ costUsd: 2 }); // every call spends $2
  const git = makeGit();
  const verifier = makeVerifier();
  let workerCalls = 0;
  const instrumented = { work: async (ctx) => { workerCalls += 1; return worker.work(ctx); } };

  await runAutofix(
    { ...baseArgs, pr: 1, budgetUsd: 3, maxIterations: 1 },
    {
      loadConfig: async () => fakeConfig,
      worker: instrumented,
      git: git.exec,
      verifier,
      readFile: async () => "x",
      writeTempPatch: async () => {},
      removeTempPatch: async () => {},
      gh: async () => ({ stdout: JSON.stringify({ state: "OPEN", headRefOid: "h", updatedAt: "t", headRepository: { name: "r" }, headRepositoryOwner: { login: "o" } }), stderr: "" }),
      runReview: makeReviewRunner([
        {
          verdict: "rework",
          reviews: [{
            agent: "claude", verdict: "rework", summary: "",
            blockers: [
              { severity: "blocker", category: "t1", message: "a", file: "x.ts" },
              { severity: "blocker", category: "t2", message: "b", file: "y.ts" },
              { severity: "blocker", category: "t3", message: "c", file: "z.ts" },
            ],
          }],
        },
      ]),
      stdout: () => {},
      stderr: () => {},
    },
  );

  // After 2 calls ($4) budget is exceeded, so the 3rd should not run.
  assert.ok(workerCalls <= 2, `expected ≤2 worker calls, got ${workerCalls}`);
});

// 17. renderAutofixSummary produces human-readable output
test("renderAutofixSummary: includes status + iterations", () => {
  const out = renderAutofixSummary(
    {
      status: "awaiting-approval",
      iterations: [
        { index: 0, fixes: [], appliedCount: 1, verified: true, costUsd: 0.05, notes: ["committed:1"], buildOk: true, testsOk: true, buildCommand: "pnpm build", testCommand: "pnpm test" },
      ],
      totalCostUsd: 0.05,
      finalVerdict: "approve",
      remainingBlockers: [],
      mergeStatus: "not-merged",
    },
    "o/r",
    42,
  );
  assert.ok(out.includes("awaiting-approval"));
  assert.ok(out.includes("o/r#42"));
  assert.ok(out.includes("1/0 patches applied"));
});
