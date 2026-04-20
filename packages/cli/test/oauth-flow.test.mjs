import { test } from "node:test";
import assert from "node:assert/strict";
import { runOauthFlow } from "../dist/commands/init/oauth-flow.js";
import { CentralClient, DEFAULT_CENTRAL_URL } from "../dist/commands/init/central-client.js";

// ---- mock CentralClient ---------------------------------------------------
//
// The real client wraps fetch; we stub it with a scripted client that
// returns pre-programmed device start + poll responses. The OauthFlow
// code paths (pending → slow_down → success / expired / denied / error)
// are what we're asserting — not the HTTP layer.

class MockClient {
  constructor(opts) {
    this.baseUrl = opts.baseUrl ?? DEFAULT_CENTRAL_URL;
    this.startResponse = opts.startResponse;
    this.pollResponses = opts.pollResponses ?? [];
    this.startCalls = [];
    this.pollCalls = [];
  }
  async startDeviceFlow(repo) {
    this.startCalls.push(repo);
    if (this.startResponse instanceof Error) throw this.startResponse;
    return this.startResponse;
  }
  async pollDeviceFlow(id) {
    this.pollCalls.push(id);
    if (this.pollResponses.length === 0) {
      throw new Error("mock: poll responses exhausted");
    }
    const next = this.pollResponses.shift();
    if (next instanceof Error) throw next;
    return next;
  }
}

function baseStartResponse(overrides = {}) {
  return {
    device_code_id: "c_dev_1",
    user_code: "ABCD-EFGH",
    verification_uri: "https://github.com/login/device",
    interval_sec: 5,
    expires_at: new Date(Date.now() + 900_000).toISOString(), // 15 min in future
    ...overrides,
  };
}

function fakeSleep() {
  return Promise.resolve();
}

// ---- happy path ----------------------------------------------------------

test("runOauthFlow: pending → success writes CONCLAVE_TOKEN via setGhSecret", async () => {
  const client = new MockClient({
    startResponse: baseStartResponse(),
    pollResponses: [
      { status: "pending" },
      { status: "success", token: "c_granted_token_xyz", repo: "acme/service", rotated: false },
    ],
  });
  const setSecretCalls = [];
  const stdout = [];
  const stderr = [];
  const result = await runOauthFlow("acme/service", {
    client,
    setGhSecret: async (opts) => { setSecretCalls.push(opts); },
    sleep: fakeSleep,
    stdout: (s) => stdout.push(s),
    stderr: (s) => stderr.push(s),
  });
  assert.equal(result.kind, "success");
  assert.equal(result.token, "c_granted_token_xyz");
  assert.equal(result.rotated, false);
  assert.equal(setSecretCalls.length, 1);
  assert.deepEqual(setSecretCalls[0], {
    repoSlug: "acme/service",
    name: "CONCLAVE_TOKEN",
    value: "c_granted_token_xyz",
  });
  const out = stdout.join("");
  assert.ok(out.includes("ABCD-EFGH"), "user_code must be printed");
  assert.ok(out.includes("https://github.com/login/device"), "verification_uri must be printed");
  assert.ok(out.includes("CONCLAVE_TOKEN stored on acme/service"));
});

// ---- slow_down ----------------------------------------------------------

test("runOauthFlow: slow_down bumps interval and keeps polling", async () => {
  const client = new MockClient({
    startResponse: baseStartResponse({ interval_sec: 5 }),
    pollResponses: [
      { status: "slow_down", interval_sec: 10 },
      { status: "success", token: "c_tok", repo: "acme/x", rotated: false },
    ],
  });
  const result = await runOauthFlow("acme/x", {
    client,
    setGhSecret: async () => {},
    sleep: fakeSleep,
    stdout: () => {},
    stderr: () => {},
  });
  assert.equal(result.kind, "success");
  assert.equal(client.pollCalls.length, 2);
});

// ---- denied -------------------------------------------------------------

test("runOauthFlow: denied by GitHub → never calls setGhSecret", async () => {
  const client = new MockClient({
    startResponse: baseStartResponse(),
    pollResponses: [{ status: "denied", reason: "user rejected" }],
  });
  let setCalled = false;
  const result = await runOauthFlow("acme/x", {
    client,
    setGhSecret: async () => { setCalled = true; },
    sleep: fakeSleep,
    stdout: () => {},
    stderr: () => {},
  });
  assert.equal(result.kind, "denied");
  assert.equal(result.reason, "user rejected");
  assert.equal(setCalled, false);
});

// ---- expired ------------------------------------------------------------

test("runOauthFlow: server-side expired → expired result, no secret write", async () => {
  const client = new MockClient({
    startResponse: baseStartResponse(),
    pollResponses: [{ status: "expired" }],
  });
  const result = await runOauthFlow("acme/x", {
    client,
    setGhSecret: async () => { throw new Error("should not run"); },
    sleep: fakeSleep,
    stdout: () => {},
    stderr: () => {},
  });
  assert.equal(result.kind, "expired");
});

test("runOauthFlow: client-side expires_at reached before any poll returns terminal", async () => {
  const expired = new Date(Date.now() - 1000).toISOString();
  const client = new MockClient({
    startResponse: baseStartResponse({ expires_at: expired }),
    pollResponses: [],
  });
  const result = await runOauthFlow("acme/x", {
    client,
    setGhSecret: async () => {},
    sleep: fakeSleep,
    stdout: () => {},
    stderr: () => {},
  });
  assert.equal(result.kind, "expired");
  assert.equal(client.pollCalls.length, 0, "should not poll past server-side expiry");
});

// ---- poll transient error then success ----------------------------------

test("runOauthFlow: transient poll error is logged but retried", async () => {
  const client = new MockClient({
    startResponse: baseStartResponse(),
    pollResponses: [
      new Error("network hiccup"),
      { status: "pending" },
      { status: "success", token: "c_x", repo: "acme/x", rotated: true },
    ],
  });
  const stderr = [];
  const result = await runOauthFlow("acme/x", {
    client,
    setGhSecret: async () => {},
    sleep: fakeSleep,
    stdout: () => {},
    stderr: (s) => stderr.push(s),
  });
  assert.equal(result.kind, "success");
  assert.equal(result.rotated, true);
  assert.ok(stderr.join("").includes("poll warning"));
});

// ---- startDeviceFlow itself fails ---------------------------------------

test("runOauthFlow: start fails → error result with upstream message", async () => {
  const client = new MockClient({
    startResponse: new Error("HTTP 503 from central plane"),
    pollResponses: [],
  });
  const result = await runOauthFlow("acme/x", {
    client,
    setGhSecret: async () => {},
    sleep: fakeSleep,
    stdout: () => {},
    stderr: () => {},
  });
  assert.equal(result.kind, "error");
  assert.ok(result.message.includes("503"));
});

// ---- gh secret set failure does NOT tank the flow -----------------------

test("runOauthFlow: gh secret set failure warns but returns success", async () => {
  const client = new MockClient({
    startResponse: baseStartResponse(),
    pollResponses: [{ status: "success", token: "c_x", repo: "acme/x", rotated: false }],
  });
  const stderr = [];
  const result = await runOauthFlow("acme/x", {
    client,
    setGhSecret: async () => { throw new Error("gh CLI not authenticated"); },
    sleep: fakeSleep,
    stdout: () => {},
    stderr: (s) => stderr.push(s),
  });
  assert.equal(result.kind, "success");
  assert.equal(result.token, "c_x");
  // The flow returns success — the user still got a token — but stderr
  // tells them to set the secret manually.
  const err = stderr.join("");
  assert.ok(err.includes("gh secret set CONCLAVE_TOKEN"));
  assert.ok(err.includes("acme/x"));
});

// ---- CentralClient basic behavior ---------------------------------------

test("CentralClient: uses CONCLAVE_CENTRAL_URL env when no baseUrl passed", () => {
  const orig = process.env["CONCLAVE_CENTRAL_URL"];
  try {
    process.env["CONCLAVE_CENTRAL_URL"] = "https://custom.example.com/";
    const c = new CentralClient({ fetch: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" }) });
    // trailing slash stripped
    assert.equal(c.baseUrl, "https://custom.example.com");
  } finally {
    if (orig === undefined) delete process.env["CONCLAVE_CENTRAL_URL"];
    else process.env["CONCLAVE_CENTRAL_URL"] = orig;
  }
});

test("CentralClient: explicit baseUrl wins over env", () => {
  const orig = process.env["CONCLAVE_CENTRAL_URL"];
  try {
    process.env["CONCLAVE_CENTRAL_URL"] = "https://env.example.com";
    const c = new CentralClient({
      baseUrl: "https://override.example.com",
      fetch: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" }),
    });
    assert.equal(c.baseUrl, "https://override.example.com");
  } finally {
    if (orig === undefined) delete process.env["CONCLAVE_CENTRAL_URL"];
    else process.env["CONCLAVE_CENTRAL_URL"] = orig;
  }
});

test("CentralClient.startDeviceFlow: POSTs JSON body and parses response", async () => {
  const calls = [];
  const client = new CentralClient({
    baseUrl: "https://fake.com",
    fetch: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          device_code_id: "c_x",
          user_code: "UUUU-CCCC",
          verification_uri: "https://github.com/login/device",
          interval_sec: 5,
          expires_at: "2026-04-20T00:00:00Z",
        }),
        text: async () => "",
      };
    },
  });
  const resp = await client.startDeviceFlow("acme/x");
  assert.equal(resp.user_code, "UUUU-CCCC");
  assert.equal(calls[0].url, "https://fake.com/oauth/device/start");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(JSON.parse(calls[0].init.body).repo, "acme/x");
});

test("CentralClient.startDeviceFlow: throws on non-ok HTTP", async () => {
  const client = new CentralClient({
    baseUrl: "https://fake.com",
    fetch: async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
      text: async () => "upstream unavailable",
    }),
  });
  await assert.rejects(() => client.startDeviceFlow("acme/x"), /HTTP 503/);
});
