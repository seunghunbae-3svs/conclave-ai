import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../dist/router.js";

// ---- mock D1 + oauth_devices table ---------------------------------------

function makeMockDb(installsSeed = new Map(), devicesSeed = new Map()) {
  const state = {
    installs: new Map(installsSeed),
    devices: new Map(devicesSeed),
  };
  return {
    state,
    prepare(sql) {
      let bound = [];
      return {
        bind: (...args) => {
          bound = args;
          return {
            async first() {
              if (/SELECT \* FROM installs WHERE repo_slug = \?/.test(sql)) {
                const row = state.installs.get(bound[0]);
                return row ? toInstallRow(row) : null;
              }
              if (/SELECT \* FROM oauth_devices WHERE device_code_id = \?/.test(sql)) {
                const row = state.devices.get(bound[0]);
                return row ? toDeviceRow(row) : null;
              }
              return null;
            },
            async run() {
              if (/INSERT INTO installs/.test(sql)) {
                const [id, repoSlug, tokenHash, createdAt, lastSeenAt] = bound;
                state.installs.set(repoSlug, {
                  id, repoSlug, tokenHash, createdAt, lastSeenAt, status: "active",
                });
              } else if (/UPDATE installs SET token_hash/.test(sql)) {
                const [tokenHash, lastSeenAt, id] = bound;
                for (const v of state.installs.values()) {
                  if (v.id === id) {
                    v.tokenHash = tokenHash;
                    v.lastSeenAt = lastSeenAt;
                  }
                }
              } else if (/INSERT INTO oauth_devices/.test(sql)) {
                const [deviceCodeId, deviceCode, userCode, repoSlug, intervalSec, expiresAt, createdAt] = bound;
                state.devices.set(deviceCodeId, {
                  deviceCodeId, deviceCode, userCode, repoSlug, intervalSec, expiresAt, createdAt, consumed: 0,
                });
              } else if (/UPDATE oauth_devices SET consumed = \?/.test(sql)) {
                const [flag, id] = bound;
                const d = state.devices.get(id);
                if (d) d.consumed = flag;
              }
              return { success: true };
            },
          };
        },
      };
    },
  };
}

function toInstallRow(r) {
  return {
    id: r.id, repo_slug: r.repoSlug, token_hash: r.tokenHash,
    created_at: r.createdAt, last_seen_at: r.lastSeenAt, status: r.status,
  };
}

function toDeviceRow(r) {
  return {
    device_code_id: r.deviceCodeId, device_code: r.deviceCode, user_code: r.userCode,
    repo_slug: r.repoSlug, interval_sec: r.intervalSec, expires_at: r.expiresAt,
    created_at: r.createdAt, consumed: r.consumed,
  };
}

function makeEnv(overrides = {}) {
  return {
    DB: makeMockDb(),
    ENVIRONMENT: "test",
    GITHUB_CLIENT_ID: "Iv1.testclient",
    ...overrides,
  };
}

// ---- mock GitHub fetch ----------------------------------------------------

function makeFetch(handlers) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const urlStr = typeof url === "string" ? url : url.url;
    calls.push({ url: urlStr, init });
    for (const h of handlers) {
      if (h.match(urlStr, init)) {
        return h.respond(urlStr, init);
      }
    }
    throw new Error(`unexpected fetch: ${urlStr}`);
  };
  fn.calls = calls;
  return fn;
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function fetchApp(app, path, init = {}, env = makeEnv()) {
  const req = new Request(`http://localhost${path}`, init);
  const res = await app.fetch(req, env);
  return { res, body: await res.json().catch(() => null) };
}

// ---- /oauth/device/start -------------------------------------------------

test("POST /oauth/device/start: returns user_code + verification_uri + device_code_id", async () => {
  const fetchMock = makeFetch([
    {
      match: (u) => u === "https://github.com/login/device/code",
      respond: () => jsonResponse(200, {
        device_code: "gh-device-1234",
        user_code: "ABCD-EFGH",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 5,
      }),
    },
  ]);
  const app = createApp({ fetch: fetchMock });
  const env = makeEnv();
  const { res, body } = await fetchApp(app, "/oauth/device/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repo: "acme/service" }),
  }, env);
  assert.equal(res.status, 200);
  assert.equal(body.user_code, "ABCD-EFGH");
  assert.equal(body.verification_uri, "https://github.com/login/device");
  assert.ok(body.device_code_id.startsWith("c_"));
  assert.equal(body.interval_sec, 5);
  // Device row stored with GitHub device_code (secret) NOT returned
  const stored = env.DB.state.devices.get(body.device_code_id);
  assert.ok(stored);
  assert.equal(stored.deviceCode, "gh-device-1234");
  assert.equal(stored.repoSlug, "acme/service");
  assert.notEqual(body.device_code_id, stored.deviceCode, "internal pointer must not equal GitHub device_code");
});

test("POST /oauth/device/start: 400 on malformed slug", async () => {
  const fetchMock = makeFetch([]);
  const app = createApp({ fetch: fetchMock });
  const { res } = await fetchApp(app, "/oauth/device/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repo: "../evil" }),
  });
  assert.equal(res.status, 400);
  assert.equal(fetchMock.calls.length, 0, "GitHub must not be called for malformed input");
});

test("POST /oauth/device/start: 503 when GITHUB_CLIENT_ID is placeholder", async () => {
  const app = createApp({ fetch: makeFetch([]) });
  const { res, body } = await fetchApp(app, "/oauth/device/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repo: "acme/service" }),
  }, makeEnv({ GITHUB_CLIENT_ID: "REPLACE_WITH_GITHUB_OAUTH_APP_CLIENT_ID" }));
  assert.equal(res.status, 503);
  assert.ok(/GITHUB_CLIENT_ID/.test(body.error));
});

// ---- /oauth/device/poll --------------------------------------------------

test("POST /oauth/device/poll: pending status while user hasn't authorized yet", async () => {
  const fetchMock = makeFetch([
    {
      match: (u) => u === "https://github.com/login/oauth/access_token",
      respond: () => jsonResponse(200, { error: "authorization_pending" }),
    },
  ]);
  const app = createApp({ fetch: fetchMock });
  const env = makeEnv({
    DB: makeMockDb(new Map(), new Map([["c_dev_1", {
      deviceCodeId: "c_dev_1", deviceCode: "gh-xyz", userCode: "ABCD-EFGH",
      repoSlug: "acme/x", intervalSec: 5,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      createdAt: new Date().toISOString(), consumed: 0,
    }]])),
  });
  const { res, body } = await fetchApp(app, "/oauth/device/poll", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_code_id: "c_dev_1" }),
  }, env);
  assert.equal(res.status, 200);
  assert.equal(body.status, "pending");
});

test("POST /oauth/device/poll: slow_down bumps interval", async () => {
  const fetchMock = makeFetch([
    {
      match: (u) => u === "https://github.com/login/oauth/access_token",
      respond: () => jsonResponse(200, { error: "slow_down" }),
    },
  ]);
  const app = createApp({ fetch: fetchMock });
  const env = makeEnv({
    DB: makeMockDb(new Map(), new Map([["c_dev_2", {
      deviceCodeId: "c_dev_2", deviceCode: "gh-xyz", userCode: "X",
      repoSlug: "acme/x", intervalSec: 5,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      createdAt: "t", consumed: 0,
    }]])),
  });
  const { body } = await fetchApp(app, "/oauth/device/poll", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_code_id: "c_dev_2" }),
  }, env);
  assert.equal(body.status, "slow_down");
  assert.equal(body.interval_sec, 10);
});

test("POST /oauth/device/poll: expired token marks device consumed=2", async () => {
  const fetchMock = makeFetch([
    {
      match: (u) => u === "https://github.com/login/oauth/access_token",
      respond: () => jsonResponse(200, { error: "expired_token" }),
    },
  ]);
  const app = createApp({ fetch: fetchMock });
  const env = makeEnv({
    DB: makeMockDb(new Map(), new Map([["c_dev_3", {
      deviceCodeId: "c_dev_3", deviceCode: "gh-xyz", userCode: "X",
      repoSlug: "acme/x", intervalSec: 5,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      createdAt: "t", consumed: 0,
    }]])),
  });
  const { body } = await fetchApp(app, "/oauth/device/poll", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_code_id: "c_dev_3" }),
  }, env);
  assert.equal(body.status, "expired");
  assert.equal(env.DB.state.devices.get("c_dev_3").consumed, 2);
});

test("POST /oauth/device/poll: success creates install and returns CONCLAVE_TOKEN", async () => {
  const fetchMock = makeFetch([
    {
      match: (u) => u === "https://github.com/login/oauth/access_token",
      respond: () => jsonResponse(200, { access_token: "gho_abcd", scope: "repo" }),
    },
    {
      match: (u) => u === "https://api.github.com/repos/acme/service",
      respond: () => jsonResponse(200, { permissions: { admin: true, push: true } }),
    },
  ]);
  const app = createApp({ fetch: fetchMock });
  const env = makeEnv({
    DB: makeMockDb(new Map(), new Map([["c_dev_4", {
      deviceCodeId: "c_dev_4", deviceCode: "gh-xyz", userCode: "X",
      repoSlug: "acme/service", intervalSec: 5,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      createdAt: "t", consumed: 0,
    }]])),
  });
  const { res, body } = await fetchApp(app, "/oauth/device/poll", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_code_id: "c_dev_4" }),
  }, env);
  assert.equal(res.status, 200);
  assert.equal(body.status, "success");
  assert.ok(body.token.startsWith("c_"));
  assert.equal(body.repo, "acme/service");
  assert.equal(body.rotated, false);
  // Install row created with token_hash
  const install = env.DB.state.installs.get("acme/service");
  assert.ok(install);
  assert.equal(install.tokenHash.length, 64);
  assert.notEqual(install.tokenHash, body.token);
  // Device marked consumed=1
  assert.equal(env.DB.state.devices.get("c_dev_4").consumed, 1);
});

test("POST /oauth/device/poll: success on existing repo rotates the token (same install id)", async () => {
  const fetchMock = makeFetch([
    {
      match: (u) => u === "https://github.com/login/oauth/access_token",
      respond: () => jsonResponse(200, { access_token: "gho_new", scope: "repo" }),
    },
    {
      match: (u) => u === "https://api.github.com/repos/acme/service",
      respond: () => jsonResponse(200, { permissions: { admin: true, push: true } }),
    },
  ]);
  const app = createApp({ fetch: fetchMock });
  const env = makeEnv({
    DB: makeMockDb(
      new Map([["acme/service", {
        id: "c_existing", repoSlug: "acme/service", tokenHash: "old-hash",
        createdAt: "2026-01-01T00:00:00Z", lastSeenAt: "2026-01-01T00:00:00Z", status: "active",
      }]]),
      new Map([["c_dev_5", {
        deviceCodeId: "c_dev_5", deviceCode: "gh-xyz", userCode: "X",
        repoSlug: "acme/service", intervalSec: 5,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        createdAt: "t", consumed: 0,
      }]]),
    ),
  });
  const { body } = await fetchApp(app, "/oauth/device/poll", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_code_id: "c_dev_5" }),
  }, env);
  assert.equal(body.status, "success");
  assert.equal(body.rotated, true);
  const install = env.DB.state.installs.get("acme/service");
  assert.equal(install.id, "c_existing", "install id must be stable across rotation");
  assert.notEqual(install.tokenHash, "old-hash", "tokenHash must be updated on rotation");
});

test("POST /oauth/device/poll: success but no repo push access → 403 denied", async () => {
  const fetchMock = makeFetch([
    {
      match: (u) => u === "https://github.com/login/oauth/access_token",
      respond: () => jsonResponse(200, { access_token: "gho_read_only", scope: "repo" }),
    },
    {
      match: (u) => u === "https://api.github.com/repos/other/secure",
      respond: () => jsonResponse(200, { permissions: { admin: false, push: false, pull: true } }),
    },
  ]);
  const app = createApp({ fetch: fetchMock });
  const env = makeEnv({
    DB: makeMockDb(new Map(), new Map([["c_dev_6", {
      deviceCodeId: "c_dev_6", deviceCode: "gh-xyz", userCode: "X",
      repoSlug: "other/secure", intervalSec: 5,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      createdAt: "t", consumed: 0,
    }]])),
  });
  const { res, body } = await fetchApp(app, "/oauth/device/poll", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_code_id: "c_dev_6" }),
  }, env);
  assert.equal(res.status, 403);
  assert.equal(body.status, "denied");
  assert.equal(env.DB.state.installs.has("other/secure"), false, "no install created when denied");
  assert.equal(env.DB.state.devices.get("c_dev_6").consumed, 2);
});

test("POST /oauth/device/poll: already-succeeded returns stable response", async () => {
  const fetchMock = makeFetch([]);
  const app = createApp({ fetch: fetchMock });
  const env = makeEnv({
    DB: makeMockDb(new Map(), new Map([["c_dev_7", {
      deviceCodeId: "c_dev_7", deviceCode: "gh-xyz", userCode: "X",
      repoSlug: "acme/x", intervalSec: 5,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      createdAt: "t", consumed: 1,
    }]])),
  });
  const { body } = await fetchApp(app, "/oauth/device/poll", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_code_id: "c_dev_7" }),
  }, env);
  assert.equal(body.status, "already_succeeded");
  assert.equal(fetchMock.calls.length, 0, "must not re-poll GitHub for consumed devices");
});

test("POST /oauth/device/poll: locally-expired device returns expired without calling GitHub", async () => {
  const fetchMock = makeFetch([]);
  const app = createApp({ fetch: fetchMock });
  const env = makeEnv({
    DB: makeMockDb(new Map(), new Map([["c_dev_8", {
      deviceCodeId: "c_dev_8", deviceCode: "gh-xyz", userCode: "X",
      repoSlug: "acme/x", intervalSec: 5,
      expiresAt: new Date(Date.now() - 1000).toISOString(),  // already expired
      createdAt: "t", consumed: 0,
    }]])),
  });
  const { body } = await fetchApp(app, "/oauth/device/poll", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_code_id: "c_dev_8" }),
  }, env);
  assert.equal(body.status, "expired");
  assert.equal(fetchMock.calls.length, 0);
  assert.equal(env.DB.state.devices.get("c_dev_8").consumed, 2);
});

test("POST /oauth/device/poll: 404 for unknown device_code_id", async () => {
  const fetchMock = makeFetch([]);
  const app = createApp({ fetch: fetchMock });
  const { res } = await fetchApp(app, "/oauth/device/poll", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_code_id: "c_missing" }),
  });
  assert.equal(res.status, 404);
});
