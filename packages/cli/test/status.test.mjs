import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runStatus,
  formatStatusOneLine,
  formatStatusVerbose,
} from "../dist/commands/status.js";

/**
 * v0.13.16 H1 #2 — `conclave status` tests.
 *
 * The command is a thin renderer over /admin/install-summary. We
 * test (1) the rendering functions directly and (2) the runStatus
 * orchestrator with an injected fetch.
 */

const HEALTHY_SUMMARY = {
  ok: true,
  install: { id: "c_test", repo: "acme/x" },
  bot: { id: 12345, username: "Conclave_AI", firstName: "Conclave" },
  webhook: {
    outcome: "bound",
    expected: "https://conclave-ai.example/telegram/webhook",
    actual: "https://conclave-ai.example/telegram/webhook",
    pendingUpdates: 0,
    lastErrorMessage: null,
    lastErrorDate: null,
  },
  linkedChats: 1,
  recentCycles: [
    { pr: 35, episodic: "ep-abc12345", at: "2026-04-27T03:39:35Z" },
    { pr: 32, episodic: "ep-def67890", at: "2026-04-27T00:19:41Z" },
  ],
};

// ---- formatStatusOneLine -------------------------------------------------

test("formatStatusOneLine: healthy install renders all 5 segments", () => {
  const line = formatStatusOneLine(HEALTHY_SUMMARY);
  assert.match(line, /acme\/x/);
  assert.match(line, /bot=@Conclave_AI/);
  assert.match(line, /webhook=bound/);
  assert.match(line, /1 chat\b/);
  assert.match(line, /2 recent cycles/);
});

test("formatStatusOneLine: dropped webhook surfaces the outcome", () => {
  const s = { ...HEALTHY_SUMMARY, webhook: { ...HEALTHY_SUMMARY.webhook, outcome: "dropped", actual: "", pendingUpdates: 5 } };
  const line = formatStatusOneLine(s);
  assert.match(line, /webhook=dropped/);
  assert.doesNotMatch(line, /webhook=bound/);
});

test("formatStatusOneLine: bot=NOT-CONFIGURED when no bot info", () => {
  const s = { ...HEALTHY_SUMMARY, bot: null };
  const line = formatStatusOneLine(s);
  assert.match(line, /bot=NOT-CONFIGURED/);
});

test("formatStatusOneLine: zero linked chats / zero cycles render with correct singular/plural", () => {
  const s = { ...HEALTHY_SUMMARY, linkedChats: 0, recentCycles: [] };
  const line = formatStatusOneLine(s);
  assert.match(line, /0 chats/);
  assert.match(line, /0 recent cycles/);
});

// ---- formatStatusVerbose -------------------------------------------------

test("formatStatusVerbose: includes install id and bot details", () => {
  const out = formatStatusVerbose(HEALTHY_SUMMARY);
  assert.match(out, /install id:.*c_test/);
  assert.match(out, /bot:.*@Conclave_AI/);
  assert.match(out, /webhook:.*bound/);
});

test("formatStatusVerbose: lists each recent cycle's PR", () => {
  const out = formatStatusVerbose(HEALTHY_SUMMARY);
  assert.match(out, /PR #35/);
  assert.match(out, /PR #32/);
});

test("formatStatusVerbose: shows 'none yet' when no cycles", () => {
  const out = formatStatusVerbose({ ...HEALTHY_SUMMARY, recentCycles: [] });
  assert.match(out, /recent cycles: none yet/);
});

test("formatStatusVerbose: surfaces last error with relative timestamp", () => {
  const tenMinAgo = Math.floor(Date.now() / 1000) - 600;
  const s = {
    ...HEALTHY_SUMMARY,
    webhook: {
      ...HEALTHY_SUMMARY.webhook,
      lastErrorMessage: "Wrong response from the webhook: 401 Unauthorized",
      lastErrorDate: tenMinAgo,
    },
  };
  const out = formatStatusVerbose(s);
  assert.match(out, /401 Unauthorized/);
  assert.match(out, /\(\d+m ago\)/);
});

// ---- runStatus end-to-end ------------------------------------------------

function makeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  fn.calls = calls;
  return fn;
}

test("runStatus: 401 — surfaces token-not-recognised error and exits 1", async () => {
  const errBuf = [];
  const stderr = (s) => errBuf.push(s);
  const stdout = () => {};
  const fetchImpl = makeFetch(async () => ({
    ok: false,
    status: 401,
    json: async () => ({}),
  }));
  const r = await runStatus([], {
    env: { CONCLAVE_TOKEN: "wrong-token" },
    fetch: fetchImpl,
    stderr,
    stdout,
  });
  assert.equal(r.code, 1);
  assert.match(errBuf.join(""), /401/);
});

test("runStatus: 404 — points at worker redeploy", async () => {
  const errBuf = [];
  const fetchImpl = makeFetch(async () => ({
    ok: false,
    status: 404,
    json: async () => ({}),
  }));
  const r = await runStatus([], {
    env: { CONCLAVE_TOKEN: "tok" },
    fetch: fetchImpl,
    stderr: (s) => errBuf.push(s),
    stdout: () => {},
  });
  assert.equal(r.code, 1);
  assert.match(errBuf.join(""), /Redeploy the worker/i);
});

test("runStatus: missing CONCLAVE_TOKEN — prints config hint, exits 1", async () => {
  const errBuf = [];
  const r = await runStatus([], {
    env: {},
    fetch: makeFetch(async () => { throw new Error("should not be called"); }),
    stderr: (s) => errBuf.push(s),
    stdout: () => {},
  });
  assert.equal(r.code, 1);
  assert.match(errBuf.join(""), /CONCLAVE_TOKEN not set/);
  assert.match(errBuf.join(""), /conclave config/);
});

test("runStatus: happy path — prints headline + returns summary", async () => {
  const outBuf = [];
  const fetchImpl = makeFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => HEALTHY_SUMMARY,
  }));
  const r = await runStatus([], {
    env: { CONCLAVE_TOKEN: "tok" },
    fetch: fetchImpl,
    stderr: () => {},
    stdout: (s) => outBuf.push(s),
  });
  assert.equal(r.code, 0);
  assert.deepEqual(r.summary, HEALTHY_SUMMARY);
  assert.match(outBuf.join(""), /acme\/x/);
  assert.match(outBuf.join(""), /webhook=bound/);
  // Non-verbose by default — must NOT include the breakdown.
  assert.doesNotMatch(outBuf.join(""), /install id:/);
});

test("runStatus: --verbose appends the breakdown", async () => {
  const outBuf = [];
  const fetchImpl = makeFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => HEALTHY_SUMMARY,
  }));
  const r = await runStatus(["--verbose"], {
    env: { CONCLAVE_TOKEN: "tok" },
    fetch: fetchImpl,
    stderr: () => {},
    stdout: (s) => outBuf.push(s),
  });
  assert.equal(r.code, 0);
  const out = outBuf.join("");
  assert.match(out, /install id:.*c_test/);
  assert.match(out, /PR #35/);
});

test("runStatus: --json emits raw summary without prose", async () => {
  const outBuf = [];
  const fetchImpl = makeFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => HEALTHY_SUMMARY,
  }));
  const r = await runStatus(["--json"], {
    env: { CONCLAVE_TOKEN: "tok" },
    fetch: fetchImpl,
    stderr: () => {},
    stdout: (s) => outBuf.push(s),
  });
  assert.equal(r.code, 0);
  const parsed = JSON.parse(outBuf.join(""));
  assert.deepEqual(parsed, HEALTHY_SUMMARY);
});

test("runStatus: passes Bearer token in header (not URL)", async () => {
  const fetchImpl = makeFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => HEALTHY_SUMMARY,
  }));
  await runStatus([], {
    env: { CONCLAVE_TOKEN: "secret-tok-123" },
    fetch: fetchImpl,
    stderr: () => {},
    stdout: () => {},
  });
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].init.headers.authorization, "Bearer secret-tok-123");
  assert.doesNotMatch(fetchImpl.calls[0].url, /secret-tok-123/, "token must NOT appear in the URL");
});
