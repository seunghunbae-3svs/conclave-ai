import { test } from "node:test";
import assert from "node:assert/strict";
import { NetlifyPlatform } from "../dist/index.js";

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

test("NetlifyPlatform: missing token throws", () => {
  const origT = process.env.NETLIFY_TOKEN;
  delete process.env.NETLIFY_TOKEN;
  try {
    assert.throws(() => new NetlifyPlatform({ siteId: "s" }));
  } finally {
    if (origT !== undefined) process.env.NETLIFY_TOKEN = origT;
  }
});

test("NetlifyPlatform: missing siteId throws", () => {
  const origS = process.env.NETLIFY_SITE_ID;
  delete process.env.NETLIFY_SITE_ID;
  try {
    assert.throws(() => new NetlifyPlatform({ token: "t" }));
  } finally {
    if (origS !== undefined) process.env.NETLIFY_SITE_ID = origS;
  }
});

test("NetlifyPlatform: returns newest ready deploy matching commit_ref", async () => {
  const f = mockFetch([
    {
      json: [
        {
          id: "dep-old",
          deploy_ssl_url: "https://old.netlify.app",
          state: "ready",
          commit_ref: "sha-head",
          created_at: "2026-04-19T10:00:00.000Z",
        },
        {
          id: "dep-new",
          deploy_ssl_url: "https://new.netlify.app",
          state: "ready",
          commit_ref: "sha-head",
          created_at: "2026-04-19T11:00:00.000Z",
        },
      ],
    },
  ]);
  const p = new NetlifyPlatform({ token: "t", siteId: "s", fetch: f });
  const out = await p.resolve({ repo: "a/b", sha: "sha-head" });
  assert.ok(out);
  assert.equal(out.url, "https://new.netlify.app");
  assert.equal(out.deploymentId, "dep-new");
});

test("NetlifyPlatform: non-matching commit_ref filtered out", async () => {
  const f = mockFetch([
    {
      json: [
        {
          id: "d1",
          deploy_ssl_url: "https://x.netlify.app",
          state: "ready",
          commit_ref: "other-sha",
          created_at: "2026-04-19T10:00:00.000Z",
        },
      ],
    },
  ]);
  const p = new NetlifyPlatform({ token: "t", siteId: "s", fetch: f });
  const out = await p.resolve({ repo: "a/b", sha: "sha-head" });
  assert.equal(out, null);
});

test("NetlifyPlatform: non-ready state filtered out", async () => {
  const f = mockFetch([
    {
      json: [
        {
          id: "d1",
          deploy_ssl_url: "https://x.netlify.app",
          state: "building",
          commit_ref: "sha-head",
          created_at: "2026-04-19T10:00:00.000Z",
        },
      ],
    },
  ]);
  const p = new NetlifyPlatform({ token: "t", siteId: "s", fetch: f });
  const out = await p.resolve({ repo: "a/b", sha: "sha-head" });
  assert.equal(out, null);
});

test("NetlifyPlatform: falls back through deploy_ssl_url → ssl_url → deploy_url", async () => {
  const f = mockFetch([
    {
      json: [
        {
          id: "d1",
          ssl_url: "https://via-ssl.netlify.app",
          state: "ready",
          commit_ref: "sha-head",
          created_at: "2026-04-19T10:00:00.000Z",
        },
      ],
    },
  ]);
  const p = new NetlifyPlatform({ token: "t", siteId: "s", fetch: f });
  const out = await p.resolve({ repo: "a/b", sha: "sha-head" });
  assert.equal(out.url, "https://via-ssl.netlify.app");
});

test("NetlifyPlatform: bearer auth + siteId in URL", async () => {
  const f = mockFetch([{ json: [] }]);
  const p = new NetlifyPlatform({ token: "tok-x", siteId: "site-abc", fetch: f });
  await p.resolve({ repo: "a/b", sha: "x" });
  assert.match(f.calls[0].url, /\/sites\/site-abc\/deploys/);
  assert.equal(f.calls[0].init.headers.authorization, "Bearer tok-x");
});

test("NetlifyPlatform: 401 throws", async () => {
  const f = mockFetch([{ ok: false, status: 401, json: {}, text: "unauthorized" }]);
  const p = new NetlifyPlatform({ token: "t", siteId: "s", fetch: f });
  await assert.rejects(() => p.resolve({ repo: "a/b", sha: "x" }), /auth failed/);
});

test("NetlifyPlatform: 404 returns null", async () => {
  const f = mockFetch([{ ok: false, status: 404, json: {}, text: "nope" }]);
  const p = new NetlifyPlatform({ token: "t", siteId: "s", fetch: f });
  const out = await p.resolve({ repo: "a/b", sha: "x" });
  assert.equal(out, null);
});
