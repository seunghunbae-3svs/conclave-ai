import { test } from "node:test";
import assert from "node:assert/strict";
import { CloudflarePlatform } from "../dist/index.js";

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
  accountId: "acc",
  projectName: "proj",
};

test("CloudflarePlatform: missing token / account / project throws", () => {
  const origT = process.env.CLOUDFLARE_API_TOKEN;
  const origA = process.env.CLOUDFLARE_ACCOUNT_ID;
  const origP = process.env.CLOUDFLARE_PROJECT_NAME;
  delete process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_PROJECT_NAME;
  try {
    assert.throws(() => new CloudflarePlatform());
    assert.throws(() => new CloudflarePlatform({ apiToken: "t" }));
    assert.throws(() => new CloudflarePlatform({ apiToken: "t", accountId: "a" }));
  } finally {
    if (origT !== undefined) process.env.CLOUDFLARE_API_TOKEN = origT;
    if (origA !== undefined) process.env.CLOUDFLARE_ACCOUNT_ID = origA;
    if (origP !== undefined) process.env.CLOUDFLARE_PROJECT_NAME = origP;
  }
});

test("CloudflarePlatform: newest success deployment matching commit wins", async () => {
  const f = mockFetch([
    {
      json: {
        success: true,
        result: [
          {
            id: "cf-older",
            url: "https://old.pages.dev",
            latest_stage: { status: "success" },
            deployment_trigger: { metadata: { commit_hash: "sha-head" } },
            created_on: "2026-04-19T10:00:00Z",
          },
          {
            id: "cf-newer",
            url: "https://new.pages.dev",
            latest_stage: { status: "success" },
            deployment_trigger: { metadata: { commit_hash: "sha-head" } },
            created_on: "2026-04-19T11:00:00Z",
          },
        ],
      },
    },
  ]);
  const p = new CloudflarePlatform({ ...BASE_OPTS, fetch: f });
  const out = await p.resolve({ repo: "a/b", sha: "sha-head" });
  assert.ok(out);
  assert.equal(out.url, "https://new.pages.dev");
  assert.equal(out.deploymentId, "cf-newer");
});

test("CloudflarePlatform: non-matching commit filtered", async () => {
  const f = mockFetch([
    {
      json: {
        success: true,
        result: [
          {
            id: "d1",
            url: "https://x.pages.dev",
            latest_stage: { status: "success" },
            deployment_trigger: { metadata: { commit_hash: "other-sha" } },
            created_on: "2026-04-19T10:00:00Z",
          },
        ],
      },
    },
  ]);
  const p = new CloudflarePlatform({ ...BASE_OPTS, fetch: f });
  assert.equal(await p.resolve({ repo: "a/b", sha: "sha-head" }), null);
});

test("CloudflarePlatform: non-success stage filtered", async () => {
  const f = mockFetch([
    {
      json: {
        success: true,
        result: [
          {
            id: "d1",
            url: "https://x.pages.dev",
            latest_stage: { status: "building" },
            deployment_trigger: { metadata: { commit_hash: "sha-head" } },
            created_on: "2026-04-19T10:00:00Z",
          },
        ],
      },
    },
  ]);
  const p = new CloudflarePlatform({ ...BASE_OPTS, fetch: f });
  assert.equal(await p.resolve({ repo: "a/b", sha: "sha-head" }), null);
});

test("CloudflarePlatform: API success=false throws", async () => {
  const f = mockFetch([
    {
      json: {
        success: false,
        errors: [{ code: 7003, message: "Could not route to /projects" }],
        result: [],
      },
    },
  ]);
  const p = new CloudflarePlatform({ ...BASE_OPTS, fetch: f });
  await assert.rejects(
    () => p.resolve({ repo: "a/b", sha: "sha-head" }),
    /Could not route/,
  );
});

test("CloudflarePlatform: bearer auth + correct URL path", async () => {
  const f = mockFetch([{ json: { success: true, result: [] } }]);
  const p = new CloudflarePlatform({ ...BASE_OPTS, fetch: f });
  await p.resolve({ repo: "a/b", sha: "x" });
  assert.equal(f.calls[0].init.headers.authorization, "Bearer tok");
  assert.match(f.calls[0].url, /\/accounts\/acc\/pages\/projects\/proj\/deployments$/);
});

test("CloudflarePlatform: 401 → auth error throw", async () => {
  const f = mockFetch([{ ok: false, status: 401, json: {}, text: "unauthorized" }]);
  const p = new CloudflarePlatform({ ...BASE_OPTS, fetch: f });
  await assert.rejects(() => p.resolve({ repo: "a/b", sha: "x" }), /auth failed/);
});

test("CloudflarePlatform: 404 → null", async () => {
  const f = mockFetch([{ ok: false, status: 404, json: {}, text: "not found" }]);
  const p = new CloudflarePlatform({ ...BASE_OPTS, fetch: f });
  assert.equal(await p.resolve({ repo: "a/b", sha: "x" }), null);
});

test("CloudflarePlatform: project name with spaces gets URL-encoded", async () => {
  const f = mockFetch([{ json: { success: true, result: [] } }]);
  const p = new CloudflarePlatform({ ...BASE_OPTS, projectName: "my project", fetch: f });
  await p.resolve({ repo: "a/b", sha: "x" });
  assert.match(f.calls[0].url, /pages\/projects\/my%20project\/deployments$/);
});
