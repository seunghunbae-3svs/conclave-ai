import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pushEpisodicAnchor,
  fetchEpisodicAnchor,
} from "../dist/lib/episodic-anchor.js";

/**
 * v0.12.x — episodic-anchor CLI helper tests.
 *
 * Covers push-side and fetch-side as separate units. The route-side
 * contract is exercised in apps/central-plane/test/episodic-anchor.test.mjs.
 */

const sampleEpisodic = {
  id: "ep-anchor-cli-1",
  createdAt: "2026-04-26T00:00:00Z",
  repo: "acme/foo",
  pullNumber: 7,
  sha: "deadbeef",
  diffSha256: "abc",
  reviews: [],
  outcome: "pending",
};

function withEnv(mutations, fn) {
  const originals = {};
  for (const [k, v] of Object.entries(mutations)) {
    originals[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(originals)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ---- 1. push --------------------------------------------------------------

test("pushEpisodicAnchor: skip when CONCLAVE_TOKEN absent (v0.3-compat path)", async () => {
  await withEnv({ CONCLAVE_TOKEN: undefined }, async () => {
    const calls = [];
    const fetchFn = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
    };
    const result = await pushEpisodicAnchor(sampleEpisodic, { fetch: fetchFn });
    assert.equal(result.ok, false);
    assert.match(result.reason, /CONCLAVE_TOKEN not set/);
    assert.equal(calls.length, 0);
  });
});

test("pushEpisodicAnchor: POSTs to /episodic/anchor with bearer + body", async () => {
  await withEnv({ CONCLAVE_TOKEN: "c_test123", CONCLAVE_CENTRAL_URL: "https://central.test" }, async () => {
    const calls = [];
    const fetchFn = async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, episodic_id: sampleEpisodic.id, bytes: 100 }),
        text: async () => "{}",
      };
    };
    const result = await pushEpisodicAnchor(sampleEpisodic, { fetch: fetchFn });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/episodic\/anchor$/);
    assert.equal(calls[0].init.headers.authorization, "Bearer c_test123");
    assert.equal(calls[0].body.episodic_id, sampleEpisodic.id);
    assert.equal(calls[0].body.repo_slug, sampleEpisodic.repo);
    assert.equal(calls[0].body.pr_number, 7);
    assert.deepEqual(calls[0].body.payload, sampleEpisodic);
  });
});

test("pushEpisodicAnchor: HTTP 5xx → ok=false, reason includes status, never throws", async () => {
  await withEnv({ CONCLAVE_TOKEN: "c_test123", CONCLAVE_CENTRAL_URL: "https://central.test" }, async () => {
    const fetchFn = async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
      text: async () => "downstream unavailable",
    });
    let logged = "";
    const result = await pushEpisodicAnchor(sampleEpisodic, {
      fetch: fetchFn,
      log: (m) => {
        logged += m;
      },
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /HTTP 503/);
    assert.match(logged, /HTTP 503/);
  });
});

test("pushEpisodicAnchor: network error → ok=false, never throws", async () => {
  await withEnv({ CONCLAVE_TOKEN: "c_test123", CONCLAVE_CENTRAL_URL: "https://central.test" }, async () => {
    const fetchFn = async () => {
      throw new Error("ECONNRESET");
    };
    const result = await pushEpisodicAnchor(sampleEpisodic, { fetch: fetchFn });
    assert.equal(result.ok, false);
    assert.match(result.reason, /ECONNRESET/);
  });
});

// ---- 2. fetch --------------------------------------------------------------

test("fetchEpisodicAnchor: returns null when CONCLAVE_TOKEN absent", async () => {
  await withEnv({ CONCLAVE_TOKEN: undefined }, async () => {
    const calls = [];
    const fetchFn = async (...args) => {
      calls.push(args);
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const result = await fetchEpisodicAnchor("ep-x", { fetch: fetchFn });
    assert.equal(result, null);
    assert.equal(calls.length, 0);
  });
});

test("fetchEpisodicAnchor: 404 returns null (not throw)", async () => {
  await withEnv({ CONCLAVE_TOKEN: "c_test", CONCLAVE_CENTRAL_URL: "https://central.test" }, async () => {
    const fetchFn = async () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: "no episodic anchor" }),
      text: async () => "{}",
    });
    const result = await fetchEpisodicAnchor("ep-missing", { fetch: fetchFn });
    assert.equal(result, null);
  });
});

test("fetchEpisodicAnchor: 200 returns payload object", async () => {
  await withEnv({ CONCLAVE_TOKEN: "c_test", CONCLAVE_CENTRAL_URL: "https://central.test" }, async () => {
    const fetchFn = async (url, init) => {
      assert.match(url, /\/episodic\/anchor\/ep-anchor-cli-1$/);
      assert.equal(init.headers.authorization, "Bearer c_test");
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, payload: sampleEpisodic }),
      };
    };
    const result = await fetchEpisodicAnchor(sampleEpisodic.id, { fetch: fetchFn });
    assert.deepEqual(result, sampleEpisodic);
  });
});

test("fetchEpisodicAnchor: handles payload_raw fallback (parse on the fly)", async () => {
  await withEnv({ CONCLAVE_TOKEN: "c_test", CONCLAVE_CENTRAL_URL: "https://central.test" }, async () => {
    const fetchFn = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, payload_raw: JSON.stringify(sampleEpisodic) }),
    });
    const result = await fetchEpisodicAnchor("ep-x", { fetch: fetchFn });
    assert.deepEqual(result, sampleEpisodic);
  });
});

test("fetchEpisodicAnchor: network error returns null", async () => {
  await withEnv({ CONCLAVE_TOKEN: "c_test", CONCLAVE_CENTRAL_URL: "https://central.test" }, async () => {
    const fetchFn = async () => {
      throw new Error("ECONNRESET");
    };
    const result = await fetchEpisodicAnchor("ep-x", { fetch: fetchFn });
    assert.equal(result, null);
  });
});
