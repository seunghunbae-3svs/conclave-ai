import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createApp } from "../dist/router.js";

/**
 * v0.12.x — episodic anchor route tests.
 *
 * Closes Bug A from v0.11 dogfood: local-only episodics weren't
 * visible to CI rework. The anchor route lets the local CLI push the
 * full episodic JSON post-review, and the CI rework workflow fetches
 * it back when the local store misses.
 */

function sha256(s) {
  return createHash("sha256").update(s).digest("hex");
}

function makeMockDb({ installs = new Map(), anchors = new Map() } = {}) {
  const state = { installs: new Map(installs), anchors: new Map(anchors) };
  return {
    state,
    prepare(sql) {
      let bound = [];
      const wrap = {
        bind: (...args) => {
          bound = args;
          return wrap;
        },
        async first() {
          if (/SELECT \* FROM installs WHERE token_hash = \?/.test(sql)) {
            for (const v of state.installs.values()) {
              if (v.tokenHash === bound[0] && v.status === "active") {
                return {
                  id: v.id,
                  repo_slug: v.repoSlug,
                  token_hash: v.tokenHash,
                  created_at: v.createdAt,
                  last_seen_at: v.lastSeenAt,
                  status: v.status,
                };
              }
            }
            return null;
          }
          if (/SELECT \* FROM episodic_anchors/.test(sql)) {
            const [installId, episodicId] = bound;
            const row = state.anchors.get(`${installId}|${episodicId}`);
            return row ?? null;
          }
          return null;
        },
        async run() {
          if (/UPDATE installs SET last_seen_at/.test(sql)) {
            // touch — no-op for the mock
          } else if (/INSERT INTO episodic_anchors/.test(sql)) {
            const [
              install_id,
              episodic_id,
              repo_slug,
              pr_number,
              payload,
              created_at,
              updated_at,
            ] = bound;
            const key = `${install_id}|${episodic_id}`;
            const existing = state.anchors.get(key);
            state.anchors.set(key, {
              install_id,
              episodic_id,
              repo_slug,
              pr_number,
              payload,
              created_at: existing ? existing.created_at : created_at,
              updated_at,
            });
          }
          return { success: true };
        },
      };
      return wrap;
    },
  };
}

function makeEnv({ token = "c_anchor_ok", repo = "acme/golf-now" } = {}) {
  const tokenHash = sha256(token);
  const installId = "c_install_anchor";
  const installs = new Map([[
    repo,
    {
      id: installId,
      repoSlug: repo,
      tokenHash,
      createdAt: "2026-04-26T00:00:00Z",
      lastSeenAt: "2026-04-26T00:00:00Z",
      status: "active",
    },
  ]]);
  return {
    db: makeMockDb({ installs }),
    token,
    installId,
    repo,
  };
}

async function postJson(app, path, body, env, token) {
  const req = new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });
  return { res, body: await res.json().catch(() => null) };
}

async function getJson(app, path, env, token) {
  const req = new Request(`http://localhost${path}`, {
    method: "GET",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });
  return { res, body: await res.json().catch(() => null) };
}

const sampleEpisodic = {
  id: "ep-anchor-1",
  createdAt: "2026-04-26T00:00:00Z",
  repo: "acme/golf-now",
  pullNumber: 42,
  sha: "deadbeef",
  diffSha256: "abc",
  reviews: [
    {
      agent: "claude",
      verdict: "rework",
      blockers: [{ severity: "blocker", category: "correctness", message: "off-by-one", file: "lib/x.js", line: 1 }],
      summary: "needs fix",
      tokensUsed: 100,
      costUsd: 0.01,
    },
  ],
  outcome: "pending",
};

// ---- 1. push happy path ---------------------------------------------------

test("/episodic/anchor: POST stores payload + GET retrieves it", async () => {
  const app = createApp();
  const { db, token, installId, repo } = makeEnv();
  const env = { DB: db, ENVIRONMENT: "test" };
  const r1 = await postJson(
    app,
    "/episodic/anchor",
    {
      episodic_id: sampleEpisodic.id,
      repo_slug: repo,
      pr_number: 42,
      payload: sampleEpisodic,
    },
    env,
    token,
  );
  assert.equal(r1.res.status, 200);
  assert.equal(r1.body.ok, true);
  assert.equal(r1.body.episodic_id, sampleEpisodic.id);
  assert.ok(typeof r1.body.bytes === "number" && r1.body.bytes > 0);
  // Storage check
  const stored = db.state.anchors.get(`${installId}|${sampleEpisodic.id}`);
  assert.ok(stored);
  // Now GET it back
  const r2 = await getJson(app, `/episodic/anchor/${sampleEpisodic.id}`, env, token);
  assert.equal(r2.res.status, 200);
  assert.equal(r2.body.ok, true);
  assert.equal(r2.body.episodic_id, sampleEpisodic.id);
  assert.equal(r2.body.repo_slug, repo);
  assert.equal(r2.body.pr_number, 42);
  assert.deepEqual(r2.body.payload, sampleEpisodic);
});

// ---- 2. validation --------------------------------------------------------

test("/episodic/anchor: POST without bearer → 401", async () => {
  const app = createApp();
  const { db } = makeEnv();
  const env = { DB: db, ENVIRONMENT: "test" };
  const req = new Request(`http://localhost/episodic/anchor`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ episodic_id: "x", repo_slug: "y", payload: {} }),
  });
  const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });
  assert.equal(res.status, 401);
});

test("/episodic/anchor: POST with empty episodic_id → 400", async () => {
  const app = createApp();
  const { db, token } = makeEnv();
  const env = { DB: db, ENVIRONMENT: "test" };
  const r = await postJson(
    app,
    "/episodic/anchor",
    { episodic_id: "", repo_slug: "acme/x", payload: {} },
    env,
    token,
  );
  assert.equal(r.res.status, 400);
  assert.match(r.body.error, /episodic_id/);
});

test("/episodic/anchor: POST with non-object payload → 400", async () => {
  const app = createApp();
  const { db, token } = makeEnv();
  const env = { DB: db, ENVIRONMENT: "test" };
  const r = await postJson(
    app,
    "/episodic/anchor",
    { episodic_id: "x", repo_slug: "acme/x", payload: 123 },
    env,
    token,
  );
  assert.equal(r.res.status, 400);
  assert.match(r.body.error, /payload/);
});

test("/episodic/anchor: GET 404 when anchor doesn't exist for this install", async () => {
  const app = createApp();
  const { db, token } = makeEnv();
  const env = { DB: db, ENVIRONMENT: "test" };
  const r = await getJson(app, `/episodic/anchor/never-existed`, env, token);
  assert.equal(r.res.status, 404);
  assert.match(r.body.error, /no episodic anchor/);
});

test("/episodic/anchor: GET without bearer → 401", async () => {
  const app = createApp();
  const { db } = makeEnv();
  const env = { DB: db, ENVIRONMENT: "test" };
  const r = await getJson(app, `/episodic/anchor/some-id`, env, undefined);
  assert.equal(r.res.status, 401);
});

// ---- 3. cross-install isolation ------------------------------------------

test("/episodic/anchor: install A's anchor is invisible to install B (cross-install isolation)", async () => {
  const app = createApp();
  // Two installs in the same DB
  const tokenA = "c_install_a_tok";
  const tokenB = "c_install_b_tok";
  const installs = new Map([
    [
      "acme/a",
      {
        id: "c_inst_a",
        repoSlug: "acme/a",
        tokenHash: sha256(tokenA),
        createdAt: "",
        lastSeenAt: "",
        status: "active",
      },
    ],
    [
      "acme/b",
      {
        id: "c_inst_b",
        repoSlug: "acme/b",
        tokenHash: sha256(tokenB),
        createdAt: "",
        lastSeenAt: "",
        status: "active",
      },
    ],
  ]);
  const db = makeMockDb({ installs });
  const env = { DB: db, ENVIRONMENT: "test" };
  await postJson(
    app,
    "/episodic/anchor",
    {
      episodic_id: "ep-shared-id",
      repo_slug: "acme/a",
      payload: sampleEpisodic,
    },
    env,
    tokenA,
  );
  // Install B trying to read same id → 404 (not 200 with A's data)
  const r = await getJson(app, "/episodic/anchor/ep-shared-id", env, tokenB);
  assert.equal(r.res.status, 404);
});

// ---- 4. payload size cap --------------------------------------------------

test("/episodic/anchor: POST 413 when payload exceeds 256KB", async () => {
  const app = createApp();
  const { db, token } = makeEnv();
  const env = { DB: db, ENVIRONMENT: "test" };
  const huge = { ...sampleEpisodic, fluff: "x".repeat(300 * 1024) };
  const r = await postJson(
    app,
    "/episodic/anchor",
    {
      episodic_id: "ep-huge",
      repo_slug: "acme/x",
      payload: huge,
    },
    env,
    token,
  );
  assert.equal(r.res.status, 413);
  assert.match(r.body.error, /too large/);
});
