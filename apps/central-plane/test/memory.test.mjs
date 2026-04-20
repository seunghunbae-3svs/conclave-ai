import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createApp } from "../dist/router.js";

// ---- mock D1 covering installs + episodic_aggregates --------------------

function makeMockDb({ installs = new Map(), aggregates = new Map() } = {}) {
  const state = {
    installs: new Map(installs),
    aggregates: new Map(aggregates),
  };
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
          if (/SELECT \* FROM installs WHERE token_hash = \? AND status = 'active'/.test(sql)) {
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
          return null;
        },
        async all() {
          if (/SELECT \* FROM episodic_aggregates/.test(sql)) {
            let rows = [...state.aggregates.values()];
            // parse `WHERE kind = ? AND domain = ? AND count >= ?` binds
            // and ORDER BY count DESC LIMIT ?
            const binds = [...bound];
            const limit = binds[binds.length - 1];
            const filters = binds.slice(0, -1);
            const filterLabels = [];
            if (/WHERE kind = \?/.test(sql)) filterLabels.push("kind");
            if (/domain = \?/.test(sql)) filterLabels.push("domain");
            if (/count >= \?/.test(sql)) filterLabels.push("minCount");

            for (let i = 0; i < filterLabels.length; i += 1) {
              const label = filterLabels[i];
              const val = filters[i];
              if (label === "kind") rows = rows.filter((r) => r.kind === val);
              if (label === "domain") rows = rows.filter((r) => r.domain === val);
              if (label === "minCount") rows = rows.filter((r) => r.count >= val);
            }
            rows.sort((a, b) => b.count - a.count);
            rows = rows.slice(0, limit);
            return {
              results: rows.map((r) => ({
                content_hash: r.contentHash,
                kind: r.kind,
                domain: r.domain,
                category: r.category,
                severity: r.severity,
                tags: r.tags,
                count: r.count,
                first_seen_at: r.firstSeenAt,
                last_seen_at: r.lastSeenAt,
              })),
            };
          }
          return { results: [] };
        },
        async run() {
          if (/UPDATE installs SET last_seen_at/.test(sql)) {
            const [lastSeenAt, id] = bound;
            for (const v of state.installs.values()) {
              if (v.id === id) v.lastSeenAt = lastSeenAt;
            }
          } else if (/INSERT INTO episodic_aggregates/.test(sql)) {
            // ON CONFLICT DO UPDATE — emulate upsert semantics
            const [contentHash, kind, domain, category, severity, tags, firstSeenAt, lastSeenAt] = bound;
            const existing = state.aggregates.get(contentHash);
            if (existing) {
              existing.count += 1;
              existing.lastSeenAt = lastSeenAt;
            } else {
              state.aggregates.set(contentHash, {
                contentHash,
                kind,
                domain,
                category,
                severity,
                tags,
                count: 1,
                firstSeenAt,
                lastSeenAt,
              });
            }
          }
          return { success: true };
        },
      };
      return wrap;
    },
  };
}

function sha256(s) {
  return createHash("sha256").update(s).digest("hex");
}

function makeAuthedEnv({ token = "c_test_token_xyz", repoSlug = "acme/service" } = {}) {
  const tokenHash = sha256(token);
  const installs = new Map([[
    repoSlug,
    {
      id: "c_install_1",
      repoSlug,
      tokenHash,
      createdAt: "2026-04-20T00:00:00Z",
      lastSeenAt: "2026-04-20T00:00:00Z",
      status: "active",
    },
  ]]);
  return {
    env: {
      DB: makeMockDb({ installs }),
      ENVIRONMENT: "test",
      GITHUB_CLIENT_ID: "Iv1.testclient",
    },
    token,
  };
}

async function fetchApp(app, path, init = {}, env) {
  const ctx = {
    waitUntil: (_p) => {},
    passThroughOnException: () => {},
  };
  const req = new Request(`http://localhost${path}`, init);
  const res = await app.fetch(req, env, ctx);
  return { res, body: await res.json().catch(() => null) };
}

// ---- auth middleware -----------------------------------------------------

test("POST /episodic/push: 401 when no Authorization header", async () => {
  const app = createApp();
  const { env } = makeAuthedEnv();
  const { res } = await fetchApp(app, "/episodic/push", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items: [] }),
  }, env);
  assert.equal(res.status, 401);
});

test("POST /episodic/push: 401 when token doesn't match any install", async () => {
  const app = createApp();
  const { env } = makeAuthedEnv();
  const { res } = await fetchApp(app, "/episodic/push", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": "Bearer c_nonexistent_token",
    },
    body: JSON.stringify({ items: [] }),
  }, env);
  assert.equal(res.status, 401);
});

test("POST /episodic/push: 401 when token doesn't start with c_", async () => {
  const app = createApp();
  const { env } = makeAuthedEnv();
  const { res } = await fetchApp(app, "/episodic/push", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": "Bearer ghp_pretending_to_be_conclave",
    },
    body: JSON.stringify({ items: [] }),
  }, env);
  assert.equal(res.status, 401);
});

// ---- episodic/push happy paths -------------------------------------------

test("POST /episodic/push: stores valid items and ignores malformed ones", async () => {
  const app = createApp();
  const { env, token } = makeAuthedEnv();
  const { res, body } = await fetchApp(app, "/episodic/push", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({
      items: [
        {
          contentHash: "a".repeat(64),
          kind: "failure-catalog",
          domain: "code",
          category: "type-error",
          severity: "blocker",
          tags: ["react", "typescript"],
        },
        {
          contentHash: "b".repeat(64),
          kind: "answer-key",
          domain: "design",
        },
        { totally: "malformed" },
        { contentHash: "short", kind: "answer-key", domain: "code" }, // too-short hash
      ],
    }),
  }, env);
  assert.equal(res.status, 200);
  assert.equal(body.accepted, 4);
  assert.equal(body.stored, 2);
  assert.equal(body.skipped, 2);
  assert.equal(body.repo, "acme/service");
  assert.ok(env.DB.state.aggregates.has("a".repeat(64)));
  assert.ok(env.DB.state.aggregates.has("b".repeat(64)));
  assert.equal(env.DB.state.aggregates.size, 2);
});

test("POST /episodic/push: duplicate content_hash increments count (upsert)", async () => {
  const app = createApp();
  const { env, token } = makeAuthedEnv();
  const hash = "c".repeat(64);
  const item = {
    contentHash: hash,
    kind: "failure-catalog",
    domain: "code",
    category: "security",
    severity: "blocker",
  };
  // First push: count = 1
  await fetchApp(app, "/episodic/push", {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": `Bearer ${token}` },
    body: JSON.stringify({ items: [item] }),
  }, env);
  // Second push (same hash): count should become 2
  await fetchApp(app, "/episodic/push", {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": `Bearer ${token}` },
    body: JSON.stringify({ items: [item] }),
  }, env);
  const agg = env.DB.state.aggregates.get(hash);
  assert.equal(agg.count, 2);
});

test("POST /episodic/push: 413 when items exceeds 500", async () => {
  const app = createApp();
  const { env, token } = makeAuthedEnv();
  const items = Array.from({ length: 501 }, (_, i) => ({
    contentHash: `x${i}`.padEnd(64, "0"),
    kind: "answer-key",
    domain: "code",
  }));
  const { res } = await fetchApp(app, "/episodic/push", {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": `Bearer ${token}` },
    body: JSON.stringify({ items }),
  }, env);
  assert.equal(res.status, 413);
});

test("POST /episodic/push: 400 when body missing items", async () => {
  const app = createApp();
  const { env, token } = makeAuthedEnv();
  const { res } = await fetchApp(app, "/episodic/push", {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": `Bearer ${token}` },
    body: JSON.stringify({}),
  }, env);
  assert.equal(res.status, 400);
});

// ---- memory/pull ---------------------------------------------------------

function makeEnvWithAggregates(rows) {
  const { env, token } = makeAuthedEnv();
  for (const r of rows) {
    env.DB.state.aggregates.set(r.contentHash, r);
  }
  return { env, token };
}

test("GET /memory/pull: 401 when no Authorization header", async () => {
  const app = createApp();
  const { env } = makeEnvWithAggregates([]);
  const { res } = await fetchApp(app, "/memory/pull", {}, env);
  assert.equal(res.status, 401);
});

test("GET /memory/pull: returns aggregates ordered by count desc", async () => {
  const app = createApp();
  const { env, token } = makeEnvWithAggregates([
    { contentHash: "h-a", kind: "failure-catalog", domain: "code", category: "x", severity: "b", tags: "[]", count: 7, firstSeenAt: "t", lastSeenAt: "t" },
    { contentHash: "h-b", kind: "failure-catalog", domain: "code", category: "y", severity: "b", tags: "[]", count: 2, firstSeenAt: "t", lastSeenAt: "t" },
    { contentHash: "h-c", kind: "answer-key",      domain: "code", category: null, severity: null, tags: "[\"react\"]", count: 99, firstSeenAt: "t", lastSeenAt: "t" },
  ]);
  const { res, body } = await fetchApp(app, "/memory/pull", {
    headers: { "authorization": `Bearer ${token}` },
  }, env);
  assert.equal(res.status, 200);
  assert.equal(body.total, 3);
  assert.equal(body.entries[0].contentHash, "h-c"); // count=99, highest
  assert.equal(body.entries[1].contentHash, "h-a");
  assert.equal(body.entries[2].contentHash, "h-b");
  assert.deepEqual(body.entries[0].tags, ["react"]);
});

test("GET /memory/pull: kind + domain filters work", async () => {
  const app = createApp();
  const { env, token } = makeEnvWithAggregates([
    { contentHash: "h-1", kind: "failure-catalog", domain: "code",   category: null, severity: null, tags: "[]", count: 5, firstSeenAt: "t", lastSeenAt: "t" },
    { contentHash: "h-2", kind: "answer-key",      domain: "code",   category: null, severity: null, tags: "[]", count: 5, firstSeenAt: "t", lastSeenAt: "t" },
    { contentHash: "h-3", kind: "failure-catalog", domain: "design", category: null, severity: null, tags: "[]", count: 5, firstSeenAt: "t", lastSeenAt: "t" },
  ]);
  const { body } = await fetchApp(app, "/memory/pull?kind=failure-catalog&domain=code", {
    headers: { "authorization": `Bearer ${token}` },
  }, env);
  assert.equal(body.total, 1);
  assert.equal(body.entries[0].contentHash, "h-1");
});

test("GET /memory/pull: min_count filters below-threshold patterns", async () => {
  const app = createApp();
  const { env, token } = makeEnvWithAggregates([
    { contentHash: "low",  kind: "failure-catalog", domain: "code", category: null, severity: null, tags: "[]", count: 1,  firstSeenAt: "t", lastSeenAt: "t" },
    { contentHash: "high", kind: "failure-catalog", domain: "code", category: null, severity: null, tags: "[]", count: 10, firstSeenAt: "t", lastSeenAt: "t" },
  ]);
  const { body } = await fetchApp(app, "/memory/pull?min_count=5", {
    headers: { "authorization": `Bearer ${token}` },
  }, env);
  assert.equal(body.total, 1);
  assert.equal(body.entries[0].contentHash, "high");
});

test("GET /memory/pull: 400 on invalid kind", async () => {
  const app = createApp();
  const { env, token } = makeEnvWithAggregates([]);
  const { res } = await fetchApp(app, "/memory/pull?kind=nonsense", {
    headers: { "authorization": `Bearer ${token}` },
  }, env);
  assert.equal(res.status, 400);
});

test("GET /memory/pull: 400 on invalid min_count", async () => {
  const app = createApp();
  const { env, token } = makeEnvWithAggregates([]);
  const { res } = await fetchApp(app, "/memory/pull?min_count=-1", {
    headers: { "authorization": `Bearer ${token}` },
  }, env);
  assert.equal(res.status, 400);
});

test("GET /memory/pull: 400 on limit outside 1..1000", async () => {
  const app = createApp();
  const { env, token } = makeEnvWithAggregates([]);
  const { res } = await fetchApp(app, "/memory/pull?limit=99999", {
    headers: { "authorization": `Bearer ${token}` },
  }, env);
  assert.equal(res.status, 400);
});
