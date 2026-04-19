import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HttpFederatedSyncTransport,
  NoopFederatedSyncTransport,
} from "../dist/index.js";

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

const BASELINE = {
  version: 1,
  kind: "failure",
  contentHash: "a".repeat(64),
  domain: "code",
  category: "security",
  severity: "blocker",
  tags: ["auth"],
  dayBucket: "2026-04-19",
};

test("HttpFederatedSyncTransport: constructor throws on empty endpoint", () => {
  assert.throws(() => new HttpFederatedSyncTransport({ endpoint: "" }));
});

test("HttpFederatedSyncTransport: trailing slash in endpoint is stripped", async () => {
  const f = mockFetch([{ json: { accepted: 1 } }]);
  const t = new HttpFederatedSyncTransport({ endpoint: "https://api.example.com/", fetch: f });
  await t.push([BASELINE]);
  assert.equal(f.calls[0].url, "https://api.example.com/baselines");
});

test("HttpFederatedSyncTransport: push POSTs JSON body with baselines array", async () => {
  const f = mockFetch([{ json: { accepted: 1 } }]);
  const t = new HttpFederatedSyncTransport({ endpoint: "https://api.example.com", apiToken: "tok", fetch: f });
  const out = await t.push([BASELINE]);
  assert.equal(out.accepted, 1);
  assert.equal(f.calls[0].init.method, "POST");
  assert.equal(f.calls[0].init.headers.authorization, "Bearer tok");
  assert.equal(f.calls[0].init.headers["content-type"], "application/json");
  const body = JSON.parse(f.calls[0].init.body);
  assert.equal(body.baselines.length, 1);
  assert.equal(body.baselines[0].contentHash, BASELINE.contentHash);
});

test("HttpFederatedSyncTransport: empty push skips network call", async () => {
  const f = mockFetch([{ json: { accepted: 999 } }]);
  const t = new HttpFederatedSyncTransport({ endpoint: "https://api.example.com", fetch: f });
  const out = await t.push([]);
  assert.equal(out.accepted, 0);
  assert.equal(f.calls.length, 0);
});

test("HttpFederatedSyncTransport: push response validated by Zod — bad shape throws", async () => {
  const f = mockFetch([{ json: { wrong: "shape" } }]);
  const t = new HttpFederatedSyncTransport({ endpoint: "https://api.example.com", fetch: f });
  await assert.rejects(() => t.push([BASELINE]));
});

test("HttpFederatedSyncTransport: pull returns baselines from response", async () => {
  const f = mockFetch([{ json: { baselines: [BASELINE] } }]);
  const t = new HttpFederatedSyncTransport({ endpoint: "https://api.example.com", fetch: f });
  const out = await t.pull();
  assert.equal(out.length, 1);
  assert.equal(out[0].contentHash, BASELINE.contentHash);
  assert.equal(f.calls[0].init.method, "GET");
});

test("HttpFederatedSyncTransport: pull with since URL-encodes the timestamp", async () => {
  const f = mockFetch([{ json: { baselines: [] } }]);
  const t = new HttpFederatedSyncTransport({ endpoint: "https://api.example.com", fetch: f });
  await t.pull("2026-04-19T00:00:00Z");
  assert.match(f.calls[0].url, /\/baselines\?since=2026-04-19T00%3A00%3A00Z$/);
});

test("HttpFederatedSyncTransport: 401 on push throws auth error", async () => {
  const f = mockFetch([{ ok: false, status: 401, json: {}, text: "no" }]);
  const t = new HttpFederatedSyncTransport({ endpoint: "https://api.example.com", fetch: f });
  await assert.rejects(() => t.push([BASELINE]), /auth failed during push/);
});

test("HttpFederatedSyncTransport: 500 on pull throws server error with snippet", async () => {
  const f = mockFetch([{ ok: false, status: 500, json: {}, text: "internal explode" }]);
  const t = new HttpFederatedSyncTransport({ endpoint: "https://api.example.com", fetch: f });
  await assert.rejects(() => t.pull(), /pull failed \(status 500\): internal explode/);
});

test("HttpFederatedSyncTransport: no apiToken → no authorization header", async () => {
  const f = mockFetch([{ json: { baselines: [] } }]);
  const t = new HttpFederatedSyncTransport({ endpoint: "https://api.example.com", fetch: f });
  await t.pull();
  assert.equal(f.calls[0].init.headers.authorization, undefined);
});

test("NoopFederatedSyncTransport: push reports full acceptance, pull is empty", async () => {
  const t = new NoopFederatedSyncTransport();
  assert.equal(t.id, "noop");
  const push = await t.push([BASELINE, BASELINE]);
  assert.equal(push.accepted, 2);
  assert.deepEqual(await t.pull(), []);
});
