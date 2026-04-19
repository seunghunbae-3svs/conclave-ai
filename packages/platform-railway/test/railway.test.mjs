import { test } from "node:test";
import assert from "node:assert/strict";
import { RailwayPlatform } from "../dist/index.js";

function mockFetch(responses) {
  let i = 0;
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => r.json,
      text: async () => r.text ?? JSON.stringify(r.json),
    };
  };
  fn.calls = calls;
  return fn;
}

const BASE_OPTS = {
  apiToken: "tok",
  projectId: "proj-123",
};

function deployment({ id, sha, status = "SUCCESS", staticUrl, url, createdAt }) {
  return {
    node: {
      id,
      status,
      staticUrl: staticUrl ?? null,
      url: url ?? null,
      createdAt,
      meta: { commitHash: sha },
    },
  };
}

test("RailwayPlatform: missing token / projectId throws", () => {
  const origT = process.env.RAILWAY_API_TOKEN;
  const origP = process.env.RAILWAY_PROJECT_ID;
  delete process.env.RAILWAY_API_TOKEN;
  delete process.env.RAILWAY_PROJECT_ID;
  try {
    assert.throws(() => new RailwayPlatform());
    assert.throws(() => new RailwayPlatform({ apiToken: "t" }));
  } finally {
    if (origT !== undefined) process.env.RAILWAY_API_TOKEN = origT;
    if (origP !== undefined) process.env.RAILWAY_PROJECT_ID = origP;
  }
});

test("RailwayPlatform: newest success deployment matching commit wins", async () => {
  const f = mockFetch([
    {
      json: {
        data: {
          deployments: {
            edges: [
              deployment({
                id: "rw-older",
                sha: "sha-head",
                staticUrl: "older.up.railway.app",
                createdAt: "2026-04-19T10:00:00Z",
              }),
              deployment({
                id: "rw-newer",
                sha: "sha-head",
                staticUrl: "newer.up.railway.app",
                createdAt: "2026-04-19T11:00:00Z",
              }),
            ],
          },
        },
      },
    },
  ]);
  const p = new RailwayPlatform({ ...BASE_OPTS, fetch: f });
  const out = await p.resolve({ repo: "a/b", sha: "sha-head" });
  assert.ok(out);
  assert.equal(out.url, "https://newer.up.railway.app");
  assert.equal(out.deploymentId, "rw-newer");
  assert.equal(out.provider, "railway");
});

test("RailwayPlatform: non-matching commit filtered", async () => {
  const f = mockFetch([
    {
      json: {
        data: {
          deployments: {
            edges: [
              deployment({
                id: "d1",
                sha: "other-sha",
                staticUrl: "x.up.railway.app",
                createdAt: "2026-04-19T10:00:00Z",
              }),
            ],
          },
        },
      },
    },
  ]);
  const p = new RailwayPlatform({ ...BASE_OPTS, fetch: f });
  assert.equal(await p.resolve({ repo: "a/b", sha: "sha-head" }), null);
});

test("RailwayPlatform: non-SUCCESS status filtered", async () => {
  const f = mockFetch([
    {
      json: {
        data: {
          deployments: {
            edges: [
              deployment({
                id: "d1",
                sha: "sha-head",
                status: "BUILDING",
                staticUrl: "x.up.railway.app",
                createdAt: "2026-04-19T10:00:00Z",
              }),
            ],
          },
        },
      },
    },
  ]);
  const p = new RailwayPlatform({ ...BASE_OPTS, fetch: f });
  assert.equal(await p.resolve({ repo: "a/b", sha: "sha-head" }), null);
});

test("RailwayPlatform: GraphQL errors throw with message", async () => {
  const f = mockFetch([
    {
      json: {
        errors: [{ message: "project not found" }],
      },
    },
  ]);
  const p = new RailwayPlatform({ ...BASE_OPTS, fetch: f });
  await assert.rejects(
    () => p.resolve({ repo: "a/b", sha: "sha-head" }),
    /project not found/,
  );
});

test("RailwayPlatform: bearer auth + POST + GraphQL body", async () => {
  const f = mockFetch([{ json: { data: { deployments: { edges: [] } } } }]);
  const p = new RailwayPlatform({ ...BASE_OPTS, fetch: f });
  await p.resolve({ repo: "a/b", sha: "x" });
  const call = f.calls[0];
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers.authorization, "Bearer tok");
  assert.equal(call.init.headers["content-type"], "application/json");
  assert.equal(call.url, "https://backboard.railway.com/graphql/v2");
  const body = JSON.parse(call.init.body);
  assert.match(body.query, /deployments\(/);
  assert.equal(body.variables.projectId, "proj-123");
  assert.equal(body.variables.environmentId, null);
});

test("RailwayPlatform: environmentId forwarded when provided", async () => {
  const f = mockFetch([{ json: { data: { deployments: { edges: [] } } } }]);
  const p = new RailwayPlatform({ ...BASE_OPTS, environmentId: "env-prod", fetch: f });
  await p.resolve({ repo: "a/b", sha: "x" });
  const body = JSON.parse(f.calls[0].init.body);
  assert.equal(body.variables.environmentId, "env-prod");
});

test("RailwayPlatform: 401 → auth error throw", async () => {
  const f = mockFetch([{ ok: false, status: 401, json: {}, text: "unauthorized" }]);
  const p = new RailwayPlatform({ ...BASE_OPTS, fetch: f });
  await assert.rejects(() => p.resolve({ repo: "a/b", sha: "x" }), /auth failed/);
});

test("RailwayPlatform: 404 → null", async () => {
  const f = mockFetch([{ ok: false, status: 404, json: {}, text: "not found" }]);
  const p = new RailwayPlatform({ ...BASE_OPTS, fetch: f });
  assert.equal(await p.resolve({ repo: "a/b", sha: "x" }), null);
});

test("RailwayPlatform: 500 → server error throw", async () => {
  const f = mockFetch([{ ok: false, status: 500, json: {}, text: "oops internal" }]);
  const p = new RailwayPlatform({ ...BASE_OPTS, fetch: f });
  await assert.rejects(() => p.resolve({ repo: "a/b", sha: "x" }), /server error 500/);
});

test("RailwayPlatform: falls back to url when staticUrl missing", async () => {
  const f = mockFetch([
    {
      json: {
        data: {
          deployments: {
            edges: [
              deployment({
                id: "d1",
                sha: "sha-head",
                url: "custom.example.com",
                createdAt: "2026-04-19T10:00:00Z",
              }),
            ],
          },
        },
      },
    },
  ]);
  const p = new RailwayPlatform({ ...BASE_OPTS, fetch: f });
  const out = await p.resolve({ repo: "a/b", sha: "sha-head" });
  assert.ok(out);
  assert.equal(out.url, "https://custom.example.com");
});

test("RailwayPlatform: deployment without any URL → null", async () => {
  const f = mockFetch([
    {
      json: {
        data: {
          deployments: {
            edges: [
              deployment({
                id: "d1",
                sha: "sha-head",
                createdAt: "2026-04-19T10:00:00Z",
              }),
            ],
          },
        },
      },
    },
  ]);
  const p = new RailwayPlatform({ ...BASE_OPTS, fetch: f });
  assert.equal(await p.resolve({ repo: "a/b", sha: "sha-head" }), null);
});
