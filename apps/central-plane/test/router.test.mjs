import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../dist/router.js";

// ---- mock D1 -------------------------------------------------------------
//
// Captures every prepared-statement call and satisfies the subset of the
// D1 interface our routes touch. Returns simple JS objects; nothing here
// pretends to be a real SQL engine — that's what the Worker acceptance
// path (wrangler dev + real D1) covers once OAuth lands.

function makeMockDb(seed = new Map()) {
  const state = { installs: new Map(seed) };
  const calls = [];
  return {
    state,
    calls,
    prepare(sql) {
      calls.push({ sql });
      let bound = [];
      return {
        bind: (...args) => {
          bound = args;
          calls[calls.length - 1].bound = args;
          return {
            async first() {
              if (/SELECT \* FROM installs WHERE repo_slug = \?/.test(sql)) {
                const slug = bound[0];
                const row = state.installs.get(slug);
                return row
                  ? {
                      id: row.id,
                      repo_slug: row.repoSlug,
                      token_hash: row.tokenHash,
                      created_at: row.createdAt,
                      last_seen_at: row.lastSeenAt,
                      status: row.status,
                    }
                  : null;
              }
              return null;
            },
            async run() {
              if (/INSERT INTO installs/.test(sql)) {
                const [id, repoSlug, tokenHash, createdAt, lastSeenAt] = bound;
                state.installs.set(repoSlug, {
                  id,
                  repoSlug,
                  tokenHash,
                  createdAt,
                  lastSeenAt,
                  status: "active",
                });
              }
              return { success: true };
            },
          };
        },
      };
    },
  };
}

function makeEnv(overrides = {}) {
  return { DB: makeMockDb(), ENVIRONMENT: "test", ...overrides };
}

async function fetchApp(app, path, init = {}, env = makeEnv()) {
  const url = `http://localhost${path}`;
  const req = new Request(url, init);
  return app.fetch(req, env);
}

// ---- /health -------------------------------------------------------------

test("GET /health: returns service identity + version + env", async () => {
  const app = createApp();
  const res = await fetchApp(app, "/health");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.service, "conclave-central-plane");
  assert.ok(body.version.startsWith("0.4"));
  assert.equal(body.environment, "test");
  assert.ok(body.time);
});

test("GET /health: never touches the DB", async () => {
  const app = createApp();
  const env = makeEnv();
  await fetchApp(app, "/health", {}, env);
  assert.equal(env.DB.calls.length, 0);
});

// ---- /register -----------------------------------------------------------

test("POST /register: happy path — creates install + returns placeholder token", async () => {
  const app = createApp();
  const env = makeEnv();
  const res = await fetchApp(
    app,
    "/register",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "acme/service" }),
    },
    env,
  );
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.repo, "acme/service");
  assert.ok(body.token.startsWith("c_placeholder_"), `unexpected token: ${body.token}`);
  assert.ok(body.id.startsWith("c_"));
  // DB was written
  assert.ok(env.DB.state.installs.has("acme/service"));
});

test("POST /register: 400 on missing body", async () => {
  const app = createApp();
  const res = await fetchApp(app, "/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(res.status, 400);
});

test("POST /register: 400 on malformed slug", async () => {
  const app = createApp();
  const res = await fetchApp(app, "/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repo: "no-slash" }),
  });
  assert.equal(res.status, 400);
});

test("POST /register: 400 on path-traversal attempt", async () => {
  const app = createApp();
  const res = await fetchApp(app, "/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repo: "../evil/thing" }),
  });
  assert.equal(res.status, 400);
});

test("POST /register: 409 when install already exists for repo", async () => {
  const app = createApp();
  const env = makeEnv({
    DB: makeMockDb([
      ["acme/service", {
        id: "c_existing",
        repoSlug: "acme/service",
        tokenHash: "hash",
        createdAt: "2026-04-20T00:00:00Z",
        lastSeenAt: "2026-04-20T00:00:00Z",
        status: "active",
      }],
    ]),
  });
  const res = await fetchApp(
    app,
    "/register",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "acme/service" }),
    },
    env,
  );
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.id, "c_existing");
});

test("POST /register: token hash is stored, raw token is not", async () => {
  const app = createApp();
  const env = makeEnv();
  const res = await fetchApp(
    app,
    "/register",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "acme/x" }),
    },
    env,
  );
  const body = await res.json();
  const stored = env.DB.state.installs.get("acme/x");
  assert.ok(stored, "install not stored");
  assert.notEqual(stored.tokenHash, body.token, "token_hash must not equal raw token");
  assert.equal(stored.tokenHash.length, 64, "SHA-256 hex is 64 chars");
});

// ---- /episodic/push ------------------------------------------------------

test("POST /episodic/push: acknowledges a list of hashes", async () => {
  const app = createApp();
  const res = await fetchApp(app, "/episodic/push", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hashes: ["a", "b", "c"] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.accepted, 3);
  assert.equal(body.stored, 0);
});

test("POST /episodic/push: 400 when hashes is missing", async () => {
  const app = createApp();
  const res = await fetchApp(app, "/episodic/push", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});

// ---- /memory/pull --------------------------------------------------------

test("GET /memory/pull: returns empty frequency stub for valid repo", async () => {
  const app = createApp();
  const res = await fetchApp(app, "/memory/pull?repo=acme/service");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.repo, "acme/service");
  assert.deepEqual(body.frequencies, []);
});

test("GET /memory/pull: 400 when repo query is missing", async () => {
  const app = createApp();
  const res = await fetchApp(app, "/memory/pull");
  assert.equal(res.status, 400);
});

test("GET /memory/pull: 400 when repo query is malformed", async () => {
  const app = createApp();
  const res = await fetchApp(app, "/memory/pull?repo=no-slash");
  assert.equal(res.status, 400);
});

// ---- 404 + error handler -------------------------------------------------

test("unknown path: JSON 404 with the path echoed back", async () => {
  const app = createApp();
  const res = await fetchApp(app, "/nope");
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error, "not found");
  assert.equal(body.path, "/nope");
});
