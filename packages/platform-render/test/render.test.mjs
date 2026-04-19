import { test } from "node:test";
import assert from "node:assert/strict";
import { RenderPlatform } from "../dist/index.js";

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

const BASE_OPTS = { apiToken: "tok", serviceId: "srv-abc" };

const serviceResponse = (url = "https://my-app.onrender.com") => ({
  id: "srv-abc",
  name: "my-app",
  serviceDetails: { url },
});

const deployItem = (commitId, status = "live", id = "dep-1", createdAt = "2026-04-19T10:00:00Z") => ({
  deploy: {
    id,
    status,
    commit: { id: commitId },
    createdAt,
    finishedAt: createdAt,
  },
});

test("RenderPlatform: missing token / serviceId throws", () => {
  const origT = process.env.RENDER_API_TOKEN;
  const origS = process.env.RENDER_SERVICE_ID;
  delete process.env.RENDER_API_TOKEN;
  delete process.env.RENDER_SERVICE_ID;
  try {
    assert.throws(() => new RenderPlatform());
    assert.throws(() => new RenderPlatform({ apiToken: "t" }));
  } finally {
    if (origT !== undefined) process.env.RENDER_API_TOKEN = origT;
    if (origS !== undefined) process.env.RENDER_SERVICE_ID = origS;
  }
});

test("RenderPlatform: live deploy matching commit returns service URL", async () => {
  const f = mockFetch([
    { json: serviceResponse("https://my-app.onrender.com") },
    {
      json: [
        deployItem("sha-head", "live", "dep-newest", "2026-04-19T11:00:00Z"),
        deployItem("sha-older", "live", "dep-old", "2026-04-19T09:00:00Z"),
      ],
    },
  ]);
  const p = new RenderPlatform({ ...BASE_OPTS, fetch: f });
  const out = await p.resolve({ repo: "a/b", sha: "sha-head" });
  assert.ok(out);
  assert.equal(out.url, "https://my-app.onrender.com");
  assert.equal(out.provider, "render");
  assert.equal(out.deploymentId, "dep-newest");
  assert.equal(out.sha, "sha-head");
});

test("RenderPlatform: non-matching commit returns null", async () => {
  const f = mockFetch([
    { json: serviceResponse() },
    { json: [deployItem("other-sha", "live", "dep-1")] },
  ]);
  const p = new RenderPlatform({ ...BASE_OPTS, fetch: f });
  assert.equal(await p.resolve({ repo: "a/b", sha: "sha-head" }), null);
});

test("RenderPlatform: non-live status filtered (build_in_progress)", async () => {
  const f = mockFetch([
    { json: serviceResponse() },
    { json: [deployItem("sha-head", "build_in_progress")] },
  ]);
  const p = new RenderPlatform({ ...BASE_OPTS, fetch: f });
  assert.equal(await p.resolve({ repo: "a/b", sha: "sha-head" }), null);
});

test("RenderPlatform: newest matching deploy wins when multiple exist", async () => {
  const f = mockFetch([
    { json: serviceResponse() },
    {
      json: [
        deployItem("sha-head", "live", "dep-oldest", "2026-04-19T08:00:00Z"),
        deployItem("sha-head", "live", "dep-newest", "2026-04-19T12:00:00Z"),
        deployItem("sha-head", "live", "dep-middle", "2026-04-19T10:00:00Z"),
      ],
    },
  ]);
  const p = new RenderPlatform({ ...BASE_OPTS, fetch: f });
  const out = await p.resolve({ repo: "a/b", sha: "sha-head" });
  assert.equal(out.deploymentId, "dep-newest");
});

test("RenderPlatform: 404 on service → null", async () => {
  const f = mockFetch([{ ok: false, status: 404, json: {}, text: "not found" }]);
  const p = new RenderPlatform({ ...BASE_OPTS, fetch: f });
  assert.equal(await p.resolve({ repo: "a/b", sha: "x" }), null);
});

test("RenderPlatform: 401 on service → auth error throws", async () => {
  const f = mockFetch([{ ok: false, status: 401, json: {}, text: "unauth" }]);
  const p = new RenderPlatform({ ...BASE_OPTS, fetch: f });
  await assert.rejects(() => p.resolve({ repo: "a/b", sha: "x" }), /auth failed/);
});

test("RenderPlatform: 500 on deploys list → server error throws", async () => {
  const f = mockFetch([
    { json: serviceResponse() },
    { ok: false, status: 500, json: {}, text: "render is down" },
  ]);
  const p = new RenderPlatform({ ...BASE_OPTS, fetch: f });
  await assert.rejects(() => p.resolve({ repo: "a/b", sha: "x" }), /server error 500/);
});

test("RenderPlatform: sends Bearer auth + correct URL paths", async () => {
  const f = mockFetch([
    { json: serviceResponse() },
    { json: [deployItem("sha-head")] },
  ]);
  const p = new RenderPlatform({ ...BASE_OPTS, fetch: f });
  await p.resolve({ repo: "a/b", sha: "sha-head" });
  assert.equal(f.calls[0].init.headers.authorization, "Bearer tok");
  assert.match(f.calls[0].url, /\/services\/srv-abc$/);
  assert.match(f.calls[1].url, /\/services\/srv-abc\/deploys\?limit=20$/);
});

test("RenderPlatform: service without url field returns null", async () => {
  const f = mockFetch([{ json: { id: "srv-abc", name: "x" } }]);
  const p = new RenderPlatform({ ...BASE_OPTS, fetch: f });
  assert.equal(await p.resolve({ repo: "a/b", sha: "x" }), null);
});

test("RenderPlatform: serviceId with special chars gets URL-encoded", async () => {
  const f = mockFetch([
    { json: serviceResponse() },
    { json: [] },
  ]);
  const p = new RenderPlatform({ ...BASE_OPTS, serviceId: "srv with space", fetch: f });
  await p.resolve({ repo: "a/b", sha: "x" });
  assert.match(f.calls[0].url, /srv%20with%20space$/);
});

test("RenderPlatform: empty deploys list returns null", async () => {
  const f = mockFetch([
    { json: serviceResponse() },
    { json: [] },
  ]);
  const p = new RenderPlatform({ ...BASE_OPTS, fetch: f });
  assert.equal(await p.resolve({ repo: "a/b", sha: "x" }), null);
});
