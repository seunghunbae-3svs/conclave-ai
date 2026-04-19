import { test } from "node:test";
import assert from "node:assert/strict";
import { DeploymentStatusPlatform } from "../dist/index.js";

function mockRunner(endpoints) {
  const calls = [];
  const fn = async (bin, args) => {
    assert.equal(bin, "gh");
    const endpoint = args[1]; // ["api", "<endpoint>"]
    calls.push(endpoint);
    const match = endpoints.find((e) => endpoint.includes(e.match));
    if (!match) throw new Error(`unexpected endpoint: ${endpoint}`);
    if (match.throw) throw new Error(match.throw);
    return { stdout: JSON.stringify(match.json) };
  };
  fn.calls = calls;
  return fn;
}

test("DeploymentStatusPlatform: happy path — success state + environment_url", async () => {
  const run = mockRunner([
    {
      match: "/deployments?sha=",
      json: [
        { id: 77, sha: "sha-head", environment: "preview", created_at: "2026-04-19T10:00:00Z" },
      ],
    },
    {
      match: "/deployments/77/statuses",
      json: [
        {
          state: "success",
          environment_url: "https://preview.example.com/sha-head",
          created_at: "2026-04-19T10:05:00Z",
        },
      ],
    },
  ]);
  const p = new DeploymentStatusPlatform({ run });
  const out = await p.resolve({ repo: "acme/app", sha: "sha-head" });
  assert.ok(out);
  assert.equal(out.url, "https://preview.example.com/sha-head");
  assert.equal(out.deploymentId, "77");
  assert.equal(out.provider, "deployment-status");
});

test("DeploymentStatusPlatform: environment filter keeps matching, drops others", async () => {
  const run = mockRunner([
    {
      match: "/deployments?sha=",
      json: [
        { id: 10, sha: "sha-head", environment: "production", created_at: "2026-04-19T12:00:00Z" },
        { id: 11, sha: "sha-head", environment: "preview", created_at: "2026-04-19T10:00:00Z" },
      ],
    },
    {
      match: "/deployments/11/statuses",
      json: [
        {
          state: "success",
          environment_url: "https://preview.example.com/match",
          created_at: "2026-04-19T10:05:00Z",
        },
      ],
    },
  ]);
  const p = new DeploymentStatusPlatform({ environment: "preview", run });
  const out = await p.resolve({ repo: "acme/app", sha: "sha-head" });
  assert.equal(out.url, "https://preview.example.com/match");
  assert.equal(out.deploymentId, "11");
});

test("DeploymentStatusPlatform: non-accepted state skipped", async () => {
  const run = mockRunner([
    {
      match: "/deployments?sha=",
      json: [{ id: 1, sha: "sha-head", environment: "preview", created_at: "2026-04-19T10:00:00Z" }],
    },
    {
      match: "/deployments/1/statuses",
      json: [
        {
          state: "failure",
          environment_url: "https://broken.example.com",
          created_at: "2026-04-19T10:05:00Z",
        },
      ],
    },
  ]);
  const p = new DeploymentStatusPlatform({ run });
  assert.equal(await p.resolve({ repo: "acme/app", sha: "sha-head" }), null);
});

test("DeploymentStatusPlatform: falls back to target_url when environment_url absent", async () => {
  const run = mockRunner([
    {
      match: "/deployments?sha=",
      json: [{ id: 1, sha: "sha-head", environment: "preview", created_at: "2026-04-19T10:00:00Z" }],
    },
    {
      match: "/deployments/1/statuses",
      json: [
        { state: "success", target_url: "https://fallback.example.com", created_at: "2026-04-19T10:05:00Z" },
      ],
    },
  ]);
  const p = new DeploymentStatusPlatform({ run });
  const out = await p.resolve({ repo: "acme/app", sha: "sha-head" });
  assert.equal(out.url, "https://fallback.example.com");
});

test("DeploymentStatusPlatform: picks newest status when multiple present", async () => {
  const run = mockRunner([
    {
      match: "/deployments?sha=",
      json: [{ id: 1, sha: "sha-head", environment: "preview", created_at: "2026-04-19T10:00:00Z" }],
    },
    {
      match: "/deployments/1/statuses",
      json: [
        { state: "in_progress", target_url: "https://ignored", created_at: "2026-04-19T10:03:00Z" },
        { state: "success", environment_url: "https://newest.example.com", created_at: "2026-04-19T10:07:00Z" },
        { state: "pending", target_url: "https://older", created_at: "2026-04-19T10:01:00Z" },
      ],
    },
  ]);
  const p = new DeploymentStatusPlatform({ run });
  const out = await p.resolve({ repo: "acme/app", sha: "sha-head" });
  assert.equal(out.url, "https://newest.example.com");
});

test("DeploymentStatusPlatform: acceptedStates override", async () => {
  const run = mockRunner([
    {
      match: "/deployments?sha=",
      json: [{ id: 1, sha: "sha-head", environment: "preview", created_at: "2026-04-19T10:00:00Z" }],
    },
    {
      match: "/deployments/1/statuses",
      json: [
        { state: "queued", environment_url: "https://queued.example.com", created_at: "2026-04-19T10:05:00Z" },
      ],
    },
  ]);
  const p = new DeploymentStatusPlatform({ run, acceptedStates: ["queued", "success"] });
  const out = await p.resolve({ repo: "acme/app", sha: "sha-head" });
  assert.equal(out.url, "https://queued.example.com");
});

test("DeploymentStatusPlatform: empty deployments returns null", async () => {
  const run = mockRunner([{ match: "/deployments?sha=", json: [] }]);
  const p = new DeploymentStatusPlatform({ run });
  assert.equal(await p.resolve({ repo: "acme/app", sha: "missing" }), null);
});

test("DeploymentStatusPlatform: gh auth error surfaces as actionable message", async () => {
  const run = mockRunner([{ match: "/deployments?sha=", throw: "HTTP 401: Bad credentials" }]);
  const p = new DeploymentStatusPlatform({ run });
  await assert.rejects(() => p.resolve({ repo: "acme/app", sha: "x" }), /gh auth failed/);
});

test("DeploymentStatusPlatform: gh 404 returns null (not thrown)", async () => {
  const run = mockRunner([{ match: "/deployments?sha=", throw: "HTTP 404: Not Found" }]);
  const p = new DeploymentStatusPlatform({ run });
  assert.equal(await p.resolve({ repo: "acme/app", sha: "x" }), null);
});

test("DeploymentStatusPlatform: URL-encodes SHA in query string", async () => {
  const run = mockRunner([{ match: "/deployments?sha=sha%2Fwith%2Fslashes&", json: [] }]);
  const p = new DeploymentStatusPlatform({ run });
  await p.resolve({ repo: "acme/app", sha: "sha/with/slashes" });
  assert.ok(run.calls[0].includes("sha%2Fwith%2Fslashes"));
});
