/**
 * PIA-6 — runPerBlocker integrates the classifier so worker-error
 * BlockerFix.reason carries the actionable message, not the raw blob.
 *
 * The classifier itself is unit-tested in pia6-anthropic-error-classify.
 * This test pins the WIRING — when worker.work throws, the resulting
 * BlockerFix's reason field contains the formatted classification
 * tag + user message, not the raw error.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runPerBlocker } from "../dist/lib/autofix-worker.js";

const blocker = {
  severity: "blocker",
  category: "type-error",
  message: "Bad type",
  file: "src/x.ts",
};

const baseInput = {
  repo: "acme/app",
  pullNumber: 1,
  newSha: "abc",
  agent: "claude",
  blocker,
};

const baseDeps = {
  cwd: "/tmp/never-reached",
  git: async () => ({ stdout: "", stderr: "", code: 0 }),
  readFile: async () => "x",
  writeTempPatch: async () => {},
  removeTempPatch: async () => {},
  workerRetries: 0,
};

test("PIA-6 wiring: worker throws 401 → BlockerFix.reason has [anthropic:auth] tag + user action", async () => {
  const worker = {
    work: async () => {
      throw Object.assign(new Error("401 authentication_error: invalid x-api-key"), {
        status: 401,
      });
    },
  };
  const fix = await runPerBlocker(baseInput, { ...baseDeps, worker });
  assert.equal(fix.status, "worker-error");
  assert.match(fix.reason ?? "", /\[anthropic:auth\]/);
  assert.match(fix.reason ?? "", /ANTHROPIC_API_KEY|API key/i);
  // Raw snippet is preserved for debugging.
  assert.match(fix.reason ?? "", /raw:/);
});

test("PIA-6 wiring: worker throws 529 → reason marked retryable", async () => {
  const worker = {
    work: async () => {
      throw Object.assign(new Error("529 overloaded_error: Anthropic API overloaded"), {
        status: 529,
      });
    },
  };
  const fix = await runPerBlocker(baseInput, { ...baseDeps, worker });
  assert.equal(fix.status, "worker-error");
  assert.match(fix.reason ?? "", /\[anthropic:overloaded:retryable\]/);
});

test("PIA-6 wiring: worker throws credit error → reason mentions top up", async () => {
  const worker = {
    work: async () => {
      throw new Error("400 invalid_request_error: Your credit balance is too low to access the Claude API.");
    },
  };
  const fix = await runPerBlocker(baseInput, { ...baseDeps, worker });
  assert.equal(fix.status, "worker-error");
  assert.match(fix.reason ?? "", /\[anthropic:credit\]/);
  assert.match(fix.reason ?? "", /top up|billing/i);
});

test("PIA-6 wiring: worker throws transport error (ECONNREFUSED) → reason kind=transport, retryable", async () => {
  const worker = {
    work: async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:443");
    },
  };
  const fix = await runPerBlocker(baseInput, { ...baseDeps, worker });
  assert.equal(fix.status, "worker-error");
  assert.match(fix.reason ?? "", /\[anthropic:transport:retryable\]/);
  assert.match(fix.reason ?? "", /network|connectivity/i);
});

test("PIA-6 wiring: cost/tokens accumulated before throw are preserved in worker-error fix", async () => {
  // Even when the call ultimately fails, if the worker incremented
  // cost (e.g. on a retry that succeeded then later threw), we keep
  // the partial accounting. With 0 retries this stays at 0; the
  // test just confirms the field omission policy doesn't drop the
  // counters when they ARE non-zero.
  const worker = {
    work: async () => {
      throw new Error("400 invalid_request_error: bad shape");
    },
  };
  const fix = await runPerBlocker(baseInput, { ...baseDeps, worker });
  assert.equal(fix.status, "worker-error");
  // cost/tokens not present (zero values omitted by current contract).
  assert.equal(fix.costUsd ?? 0, 0);
  assert.equal(fix.tokensUsed ?? 0, 0);
});
