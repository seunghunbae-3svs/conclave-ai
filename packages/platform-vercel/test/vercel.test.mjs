import { test } from "node:test";
import assert from "node:assert/strict";
import { VercelPlatform } from "../dist/index.js";

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

test("VercelPlatform: missing token throws in constructor", () => {
  const orig = process.env.VERCEL_TOKEN;
  delete process.env.VERCEL_TOKEN;
  try {
    assert.throws(() => new VercelPlatform());
  } finally {
    if (orig !== undefined) process.env.VERCEL_TOKEN = orig;
  }
});

test("VercelPlatform: returns null when no deployment matches sha", async () => {
  const f = mockFetch([{ json: { deployments: [] } }]);
  const p = new VercelPlatform({ token: "t", fetch: f });
  const out = await p.resolve({ repo: "a/b", sha: "sha-head" });
  assert.equal(out, null);
});

test("VercelPlatform: returns newest READY deployment url", async () => {
  const f = mockFetch([
    {
      json: {
        deployments: [
          {
            uid: "dep-old",
            url: "old.vercel.app",
            readyState: "READY",
            created: 1_700_000_000_000,
            meta: { githubCommitSha: "sha-head" },
          },
          {
            uid: "dep-new",
            url: "new.vercel.app",
            readyState: "READY",
            created: 1_700_000_500_000,
            meta: { githubCommitSha: "sha-head" },
          },
        ],
      },
    },
  ]);
  const p = new VercelPlatform({ token: "t", fetch: f });
  const out = await p.resolve({ repo: "a/b", sha: "sha-head" });
  assert.ok(out);
  assert.equal(out.url, "https://new.vercel.app");
  assert.equal(out.deploymentId, "dep-new");
  assert.equal(out.provider, "vercel");
});

test("VercelPlatform: BUILDING deployments are ignored", async () => {
  const f = mockFetch([
    {
      json: {
        deployments: [
          {
            uid: "dep-b",
            url: "b.vercel.app",
            readyState: "BUILDING",
            created: 1_700_000_500_000,
            meta: { githubCommitSha: "sha-head" },
          },
        ],
      },
    },
  ]);
  const p = new VercelPlatform({ token: "t", fetch: f });
  const out = await p.resolve({ repo: "a/b", sha: "sha-head" });
  assert.equal(out, null);
});

test("VercelPlatform: URL with full https prefix passes through", async () => {
  const f = mockFetch([
    {
      json: {
        deployments: [
          {
            uid: "d1",
            url: "https://already-prefixed.vercel.app",
            readyState: "READY",
            created: 1,
            meta: { githubCommitSha: "sha-head" },
          },
        ],
      },
    },
  ]);
  const p = new VercelPlatform({ token: "t", fetch: f });
  const out = await p.resolve({ repo: "a/b", sha: "sha-head" });
  assert.equal(out.url, "https://already-prefixed.vercel.app");
});

test("VercelPlatform: auth failure (401) throws", async () => {
  const f = mockFetch([{ ok: false, status: 401, json: {}, text: "unauthorized" }]);
  const p = new VercelPlatform({ token: "t", fetch: f });
  await assert.rejects(() => p.resolve({ repo: "a/b", sha: "x" }), /auth failed/);
});

test("VercelPlatform: 5xx throws with body snippet", async () => {
  const f = mockFetch([{ ok: false, status: 503, json: {}, text: "service down" }]);
  const p = new VercelPlatform({ token: "t", fetch: f });
  await assert.rejects(() => p.resolve({ repo: "a/b", sha: "x" }), /server error 503.*service down/);
});

test("VercelPlatform: 404 returns null (no repo/sha)", async () => {
  const f = mockFetch([{ ok: false, status: 404, json: {}, text: "not found" }]);
  const p = new VercelPlatform({ token: "t", fetch: f });
  const out = await p.resolve({ repo: "a/b", sha: "x" });
  assert.equal(out, null);
});

test("VercelPlatform: teamId + projectId propagate to query", async () => {
  const f = mockFetch([{ json: { deployments: [] } }]);
  const p = new VercelPlatform({
    token: "t",
    teamId: "team-xxx",
    projectId: "proj-yyy",
    fetch: f,
  });
  await p.resolve({ repo: "a/b", sha: "sha-head" });
  const url = f.calls[0].url;
  assert.match(url, /teamId=team-xxx/);
  assert.match(url, /projectId=proj-yyy/);
  assert.match(url, /meta-githubCommitSha=sha-head/);
});

test("VercelPlatform: bearer auth header wired", async () => {
  const f = mockFetch([{ json: { deployments: [] } }]);
  const p = new VercelPlatform({ token: "tok-123", fetch: f });
  await p.resolve({ repo: "a/b", sha: "sha-head" });
  assert.equal(f.calls[0].init.headers.authorization, "Bearer tok-123");
});

test("VercelPlatform: waitSeconds polls until READY", async () => {
  // First poll: BUILDING, second: READY
  const f = mockFetch([
    { json: { deployments: [{ readyState: "BUILDING", meta: { githubCommitSha: "sha-head" } }] } },
    {
      json: {
        deployments: [
          {
            uid: "d2",
            url: "ok.vercel.app",
            readyState: "READY",
            created: 1,
            meta: { githubCommitSha: "sha-head" },
          },
        ],
      },
    },
  ]);
  const p = new VercelPlatform({ token: "t", fetch: f });
  const out = await p.resolve({ repo: "a/b", sha: "sha-head", waitSeconds: 2 });
  assert.ok(out);
  assert.equal(out.url, "https://ok.vercel.app");
  assert.ok(f.calls.length >= 2);
});
