/**
 * OP-6 — episodic anchor concurrency + reuse safety.
 *
 * The central plane stores episodic anchors via D1 with
 * ON CONFLICT(install_id, episodic_id) DO UPDATE — pin down that the
 * CLI's pushEpisodicAnchor side respects the same idempotency
 * contract (same anchor pushed twice = upsert, not error).
 *
 * Concurrency test: many PRs anchoring different episodics in
 * parallel doesn't lose data. Reuse test: same episodic anchored
 * twice (e.g., a retry) overwrites cleanly without throwing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pushEpisodicAnchor } from "../dist/lib/episodic-anchor.js";

const ep = (id, prNumber = 1) => ({
  id,
  createdAt: new Date().toISOString(),
  repo: "acme/app",
  pullNumber: prNumber,
  sha: "sha",
  diffSha256: "0".repeat(64),
  reviews: [],
  councilVerdict: "approve",
  outcome: "pending",
  costUsd: 0,
  cycleNumber: 1,
  solutionPatches: [],
});

test("OP-6: pushEpisodicAnchor with no CONCLAVE_TOKEN → silent no-op (v0.3-compat path)", async () => {
  // Save and clear env.
  const orig = process.env["CONCLAVE_TOKEN"];
  delete process.env["CONCLAVE_TOKEN"];
  try {
    const r = await pushEpisodicAnchor(ep("ep-1"), { fetch: async () => new Response("nope") });
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /token|CONCLAVE_TOKEN|env/i);
  } finally {
    if (orig !== undefined) process.env["CONCLAVE_TOKEN"] = orig;
  }
});

test("OP-6: pushEpisodicAnchor with token → POSTs to /episodic/anchor with Bearer", async () => {
  process.env["CONCLAVE_TOKEN"] = "test-token";
  try {
    let receivedAuth = "";
    let receivedPath = "";
    const fakeFetch = async (url, init) => {
      receivedPath = String(url);
      receivedAuth = init?.headers?.["Authorization"] ?? init?.headers?.authorization ?? "";
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const r = await pushEpisodicAnchor(ep("ep-anchor"), { fetch: fakeFetch });
    assert.equal(r.ok, true);
    assert.match(receivedPath, /\/episodic\/anchor$/);
    assert.equal(receivedAuth, "Bearer test-token");
  } finally {
    delete process.env["CONCLAVE_TOKEN"];
  }
});

test("OP-6: pushEpisodicAnchor twice with same id → server's UPSERT handles it; client treats both as ok", async () => {
  process.env["CONCLAVE_TOKEN"] = "test-token";
  try {
    let calls = 0;
    const fakeFetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const e = ep("ep-re-anchor");
    const r1 = await pushEpisodicAnchor(e, { fetch: fakeFetch });
    const r2 = await pushEpisodicAnchor(e, { fetch: fakeFetch });
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    assert.equal(calls, 2, "client makes both calls; server-side UPSERT dedupes");
  } finally {
    delete process.env["CONCLAVE_TOKEN"];
  }
});

test("OP-6: pushEpisodicAnchor — many PRs in parallel anchor distinct ids without losing data", async () => {
  process.env["CONCLAVE_TOKEN"] = "test-token";
  try {
    const seen = new Set();
    const fakeFetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      // Payload shape: { episodic_id, repo_slug, pr_number, payload }
      seen.add(body.episodic_id);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        pushEpisodicAnchor(ep(`ep-parallel-${i}`, i), { fetch: fakeFetch }),
      ),
    );
    assert.ok(results.every((r) => r.ok));
    assert.equal(seen.size, 12, "every id reaches server distinctly (no dedup-loss client side)");
  } finally {
    delete process.env["CONCLAVE_TOKEN"];
  }
});

test("OP-6: server returns 5xx → client surfaces ok=false + reason, never throws", async () => {
  process.env["CONCLAVE_TOKEN"] = "test-token";
  try {
    const fakeFetch = async () =>
      new Response("server boom", { status: 503 });
    const r = await pushEpisodicAnchor(ep("ep-fail"), { fetch: fakeFetch });
    assert.equal(r.ok, false);
    assert.ok(r.reason);
    assert.match(r.reason, /503|server|fail/i);
  } finally {
    delete process.env["CONCLAVE_TOKEN"];
  }
});

test("OP-6: network error (fetch throws) → client returns ok=false, never propagates", async () => {
  process.env["CONCLAVE_TOKEN"] = "test-token";
  try {
    const fakeFetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const r = await pushEpisodicAnchor(ep("ep-net"), { fetch: fakeFetch });
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /ECONNREFUSED|network|fetch/i);
  } finally {
    delete process.env["CONCLAVE_TOKEN"];
  }
});

test("OP-6: payload includes episodic.id at top level so server's UPSERT key (install_id, episodic_id) works", async () => {
  process.env["CONCLAVE_TOKEN"] = "test-token";
  try {
    let captured = null;
    const fakeFetch = async (_url, init) => {
      captured = JSON.parse(init.body);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    await pushEpisodicAnchor(ep("ep-key-test", 42), { fetch: fakeFetch });
    assert.ok(captured);
    // The server's INSERT INTO episodic_anchors needs episodic_id +
    // repo_slug + pr_number. Confirm they're present at the top level
    // of the body (matching the lib's flat shape).
    assert.equal(captured.episodic_id, "ep-key-test");
    assert.equal(captured.repo_slug, "acme/app");
    assert.equal(captured.pr_number, 42);
    // Full episodic carried in `payload`.
    assert.ok(captured.payload);
    assert.equal(captured.payload.id, "ep-key-test");
  } finally {
    delete process.env["CONCLAVE_TOKEN"];
  }
});
