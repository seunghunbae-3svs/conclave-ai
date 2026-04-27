import { test } from "node:test";
import assert from "node:assert/strict";
import { runPerBlocker } from "../dist/lib/autofix-worker.js";

/**
 * v0.13.19 (H1 #4) — runPerBlocker retry-with-feedback tests.
 *
 * When `git apply --check --recount` rejects the worker's patch (and
 * the GNU patch fuzz fallback also rejects), the autofix-worker layer
 * now calls the worker AGAIN with the rejection reason in the prompt
 * so it can correct the specific failure mode (off-by-N start line,
 * miscounted hunk header, hallucinated context).
 *
 * Live RC: eventbadge#29 burnt 3 OUTER cycles because each cycle's
 * single worker call emitted a bad patch; with retry-feedback the
 * SAME blocker can be re-attempted within a single cycle.
 */

const BLOCKER = {
  severity: "blocker",
  category: "type-error",
  message: "add explicit type annotation",
  file: "src/x.ts",
  line: 1,
};

const VALID_PATCH = `diff --git a/src/x.ts b/src/x.ts
--- a/src/x.ts
+++ b/src/x.ts
@@ -1,3 +1,3 @@
-export const x = 1;
+export const x: number = 1;
 export const y = 2;
 export const z = 3;
`;

const BAD_PATCH = `diff --git a/src/x.ts b/src/x.ts
--- a/src/x.ts
+++ b/src/x.ts
@@ -99,3 +99,3 @@
-line at impossible offset
+replacement
`;

function makeWorker(responses) {
  let i = 0;
  const calls = [];
  return {
    calls,
    async work(ctx) {
      calls.push(ctx);
      const r = responses[Math.min(i, responses.length - 1)];
      i += 1;
      if (typeof r === "function") return r(ctx, calls.length);
      return r;
    },
  };
}

function workerOutcome({ patch = VALID_PATCH, message = "fix(x)", filesTouched = ["src/x.ts"], costUsd = 0.21, tokensUsed = 2400 } = {}) {
  return { patch, message, appliedFiles: filesTouched, costUsd, tokensUsed };
}

const baseInput = () => ({
  repo: "acme/x",
  pullNumber: 1,
  newSha: "abc",
  agent: "claude",
  blocker: BLOCKER,
});

const baseDeps = (overrides = {}) => ({
  worker: overrides.worker,
  // Default git: returns success for `git apply --check --recount`.
  git: overrides.git ?? (async () => ({ stdout: "", stderr: "" })),
  cwd: "/tmp/fake-repo",
  readFile: overrides.readFile ?? (async () => "export const x = 1;\nexport const y = 2;\nexport const z = 3;\n"),
  writeTempPatch: overrides.writeTempPatch ?? (async () => {}),
  removeTempPatch: overrides.removeTempPatch ?? (async () => {}),
  stderr: () => {}, // silence retry log noise in tests
  ...overrides,
});

// ---- happy path (no retry needed) ---------------------------------------

test("runPerBlocker: first attempt validates → status=ready, NO retry, no workerAttempts field", async () => {
  const worker = makeWorker([workerOutcome()]);
  const fix = await runPerBlocker(baseInput(), baseDeps({ worker }));
  assert.equal(fix.status, "ready");
  assert.equal(worker.calls.length, 1, "must NOT retry when first attempt validates");
  // Backward compat: no workerAttempts field on first-try success.
  assert.equal(fix.workerAttempts, undefined);
});

// ---- retry path ---------------------------------------------------------

test("runPerBlocker: first attempt invalid → retry succeeds → status=ready, workerAttempts=2", async () => {
  // git rejects the first patch (BAD_PATCH), accepts the second.
  let gitApplyCalls = 0;
  const git = async (bin, args) => {
    if (bin === "git" && args[0] === "apply") {
      gitApplyCalls += 1;
      if (gitApplyCalls === 1) {
        throw Object.assign(new Error("error: patch failed: src/x.ts:99"), { stderr: "patch failed at line 99" });
      }
      return { stdout: "", stderr: "" };
    }
    if (bin === "patch") {
      // First-call fuzz fallback ALSO fails (so we go to retry path).
      throw new Error("patch: hunk #1 ignored at 99");
    }
    return { stdout: "", stderr: "" };
  };
  const worker = makeWorker([
    workerOutcome({ patch: BAD_PATCH }),
    workerOutcome({ patch: VALID_PATCH }),
  ]);
  const fix = await runPerBlocker(baseInput(), baseDeps({ worker, git }));
  assert.equal(fix.status, "ready");
  assert.equal(worker.calls.length, 2, "second attempt must fire when first fails");
  assert.equal(fix.workerAttempts, 2);
  // Cost should be the SUM of both attempts.
  assert.ok(fix.costUsd > 0.4, `expected accumulated cost > 0.4 across 2 attempts, got ${fix.costUsd}`);
});

test("runPerBlocker: second attempt's prompt context contains the previous rejection", async () => {
  let gitApplyCalls = 0;
  const git = async (bin, args) => {
    if (bin === "git" && args[0] === "apply") {
      gitApplyCalls += 1;
      if (gitApplyCalls === 1) throw new Error("patch failed: line 99");
      return { stdout: "", stderr: "" };
    }
    if (bin === "patch") throw new Error("fuzz also failed");
    return { stdout: "", stderr: "" };
  };
  const worker = makeWorker([
    workerOutcome({ patch: BAD_PATCH }),
    workerOutcome({ patch: VALID_PATCH }),
  ]);
  await runPerBlocker(baseInput(), baseDeps({ worker, git }));
  // First call: no previousAttempts.
  assert.equal(worker.calls[0].previousAttempts, undefined);
  // Second call: previousAttempts present with the rejected patch + reason.
  assert.ok(Array.isArray(worker.calls[1].previousAttempts));
  assert.equal(worker.calls[1].previousAttempts.length, 1);
  assert.equal(worker.calls[1].previousAttempts[0].patch, BAD_PATCH);
  assert.match(worker.calls[1].previousAttempts[0].rejectReason, /patch failed/i);
});

test("runPerBlocker: all attempts invalid → status=conflict, workerAttempts=3 (default 2 retries)", async () => {
  // Always reject.
  const git = async (bin, args) => {
    if (bin === "git" && args[0] === "apply") throw new Error("patch failed: line 99");
    if (bin === "patch") throw new Error("fuzz also failed");
    return { stdout: "", stderr: "" };
  };
  const worker = makeWorker([
    workerOutcome({ patch: BAD_PATCH }),
    workerOutcome({ patch: BAD_PATCH }),
    workerOutcome({ patch: BAD_PATCH }),
    workerOutcome({ patch: BAD_PATCH }), // safety: should not be called
  ]);
  const fix = await runPerBlocker(baseInput(), baseDeps({ worker, git }));
  assert.equal(fix.status, "conflict");
  assert.equal(worker.calls.length, 3, "default = 2 retries → 3 total worker calls");
  assert.equal(fix.workerAttempts, 3);
  assert.match(fix.reason, /patch failed/i);
});

test("runPerBlocker: workerRetries=0 → first failure short-circuits to conflict (single worker call)", async () => {
  const git = async (bin, args) => {
    if (bin === "git" && args[0] === "apply") throw new Error("patch failed: line 99");
    if (bin === "patch") throw new Error("fuzz also failed");
    return { stdout: "", stderr: "" };
  };
  const worker = makeWorker([workerOutcome({ patch: BAD_PATCH })]);
  const fix = await runPerBlocker(
    baseInput(),
    baseDeps({ worker, git, workerRetries: 0 }),
  );
  assert.equal(fix.status, "conflict");
  assert.equal(worker.calls.length, 1, "workerRetries=0 must do exactly one worker call");
  assert.equal(fix.workerAttempts, 1);
});

test("runPerBlocker: workerRetries clamped to hard cap of 4", async () => {
  // Even with workerRetries=999, only 5 worker calls should fire (1 + 4 retries).
  const git = async (bin, args) => {
    if (bin === "git" && args[0] === "apply") throw new Error("patch failed");
    if (bin === "patch") throw new Error("fuzz failed");
    return { stdout: "", stderr: "" };
  };
  const worker = makeWorker([
    workerOutcome({ patch: BAD_PATCH }),
    workerOutcome({ patch: BAD_PATCH }),
    workerOutcome({ patch: BAD_PATCH }),
    workerOutcome({ patch: BAD_PATCH }),
    workerOutcome({ patch: BAD_PATCH }),
    workerOutcome({ patch: BAD_PATCH }),
    workerOutcome({ patch: BAD_PATCH }),
    workerOutcome({ patch: BAD_PATCH }),
  ]);
  await runPerBlocker(
    baseInput(),
    baseDeps({ worker, git, workerRetries: 999 }),
  );
  assert.ok(worker.calls.length <= 5, `hard cap is 4 retries (5 calls); got ${worker.calls.length}`);
});

test("runPerBlocker: worker throws on retry → returns worker-error with accumulated cost from prior attempts", async () => {
  const git = async (bin, args) => {
    if (bin === "git" && args[0] === "apply") throw new Error("patch failed");
    if (bin === "patch") throw new Error("fuzz failed");
    return { stdout: "", stderr: "" };
  };
  const worker = {
    calls: [],
    async work(ctx) {
      this.calls.push(ctx);
      if (this.calls.length === 1) {
        // First call returns a (bad) patch.
        return workerOutcome({ patch: BAD_PATCH, costUsd: 0.21 });
      }
      throw new Error("anthropic 500");
    },
  };
  const fix = await runPerBlocker(baseInput(), baseDeps({ worker, git }));
  assert.equal(fix.status, "worker-error");
  assert.match(fix.reason, /anthropic 500/);
  // Cost from the first (failed-validate) call should still be reported.
  assert.ok(fix.costUsd >= 0.2, `expected cost from prior attempt to surface; got ${fix.costUsd}`);
});

test("runPerBlocker: previousAttempts grows per retry (each attempt sees ALL prior rejections)", async () => {
  const git = async (bin, args) => {
    if (bin === "git" && args[0] === "apply") throw new Error("patch failed");
    if (bin === "patch") throw new Error("fuzz failed");
    return { stdout: "", stderr: "" };
  };
  const worker = makeWorker([
    workerOutcome({ patch: "patch-A" + BAD_PATCH }),
    workerOutcome({ patch: "patch-B" + BAD_PATCH }),
    workerOutcome({ patch: "patch-C" + BAD_PATCH }),
  ]);
  await runPerBlocker(baseInput(), baseDeps({ worker, git }));
  assert.equal(worker.calls.length, 3);
  // Call 1: no history.
  assert.equal(worker.calls[0].previousAttempts, undefined);
  // Call 2: 1 prior.
  assert.equal(worker.calls[1].previousAttempts.length, 1);
  // Call 3: 2 priors (A and B both visible to the worker so it can
  // see the trend, not just the most recent failure).
  assert.equal(worker.calls[2].previousAttempts.length, 2);
  assert.match(worker.calls[2].previousAttempts[0].patch, /patch-A/);
  assert.match(worker.calls[2].previousAttempts[1].patch, /patch-B/);
});
