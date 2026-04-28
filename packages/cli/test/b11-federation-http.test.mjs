/**
 * Phase B.11 — federation HTTP transport, fake-server round-trip.
 *
 * Spins up a real node:http server on localhost, points
 * HttpFederatedSyncTransport at it, and verifies:
 *   - POST /baselines accepts a JSON body, returns { accepted: N }
 *   - GET /baselines returns { baselines: [...] }
 *   - GET /baselines?since=<iso> propagates the query
 *   - Bearer token rides in the Authorization header
 *   - 4xx/5xx errors throw with actionable messages
 *   - Auth failure (401/403) gets a distinct error
 *   - Schema mismatch (server returns wrong shape) throws cleanly
 *   - Empty push (0 baselines) is a no-op (no network call)
 *   - Trailing slash in endpoint is normalized
 *
 * Coverage target: every line in the transport that interacts with
 * the wire.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { HttpFederatedSyncTransport } from "@conclave-ai/core";

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        await handler(req, res, body);
      } catch (err) {
        res.statusCode = 500;
        res.end(String(err));
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

const sampleBaseline = (kind = "answer-key") => ({
  version: 1,
  kind,
  contentHash: "0".repeat(64),
  domain: "code",
  ...(kind === "failure" ? { category: "regression", severity: "major" } : {}),
  tags: ["x"],
  dayBucket: "2026-04-29",
});

test("B.11: push round-trip — POST /baselines with bearer token + JSON body", async () => {
  let receivedAuth = "";
  let receivedBody = null;
  let receivedMethod = "";
  let receivedPath = "";
  const server = await startServer((req, res, body) => {
    receivedMethod = req.method;
    receivedPath = req.url;
    receivedAuth = req.headers.authorization ?? "";
    receivedBody = JSON.parse(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ accepted: 2 }));
  });
  try {
    const transport = new HttpFederatedSyncTransport({
      endpoint: server.url,
      apiToken: "bearer-token-xyz",
    });
    const result = await transport.push([sampleBaseline("answer-key"), sampleBaseline("failure")]);
    assert.equal(result.accepted, 2);
    assert.equal(receivedMethod, "POST");
    assert.equal(receivedPath, "/baselines");
    assert.equal(receivedAuth, "Bearer bearer-token-xyz");
    assert.equal(receivedBody.baselines.length, 2);
    assert.equal(receivedBody.baselines[0].kind, "answer-key");
  } finally {
    await server.close();
  }
});

test("B.11: push with 0 baselines → no network call (early return)", async () => {
  let serverHit = false;
  const server = await startServer((_req, res) => {
    serverHit = true;
    res.writeHead(200);
    res.end(JSON.stringify({ accepted: 0 }));
  });
  try {
    const transport = new HttpFederatedSyncTransport({ endpoint: server.url });
    const result = await transport.push([]);
    assert.equal(result.accepted, 0);
    assert.equal(serverHit, false, "empty push must NOT touch the network");
  } finally {
    await server.close();
  }
});

test("B.11: pull round-trip — GET /baselines, no since, server returns 3", async () => {
  let receivedPath = "";
  const server = await startServer((req, res) => {
    receivedPath = req.url;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ baselines: [sampleBaseline(), sampleBaseline(), sampleBaseline()] }),
    );
  });
  try {
    const transport = new HttpFederatedSyncTransport({ endpoint: server.url });
    const baselines = await transport.pull();
    assert.equal(baselines.length, 3);
    assert.equal(receivedPath, "/baselines");
  } finally {
    await server.close();
  }
});

test("B.11: pull with since → since param URL-encoded into query", async () => {
  let receivedPath = "";
  const server = await startServer((req, res) => {
    receivedPath = req.url;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ baselines: [] }));
  });
  try {
    const transport = new HttpFederatedSyncTransport({ endpoint: server.url });
    const since = "2026-04-29T10:00:00.000Z";
    await transport.pull(since);
    assert.equal(receivedPath, `/baselines?since=${encodeURIComponent(since)}`);
  } finally {
    await server.close();
  }
});

test("B.11: trailing slash endpoint is normalized (no double slash in URL)", async () => {
  let receivedPath = "";
  const server = await startServer((req, res) => {
    receivedPath = req.url;
    res.writeHead(200);
    res.end(JSON.stringify({ accepted: 0 }));
  });
  try {
    const transport = new HttpFederatedSyncTransport({ endpoint: server.url + "/" });
    await transport.push([sampleBaseline()]);
    assert.equal(receivedPath, "/baselines", "no double slash in path");
  } finally {
    await server.close();
  }
});

test("B.11: 401 → auth-failed error message (separate from generic 4xx)", async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(401);
    res.end("token expired");
  });
  try {
    const transport = new HttpFederatedSyncTransport({ endpoint: server.url, apiToken: "bad" });
    await assert.rejects(
      transport.push([sampleBaseline()]),
      (err) => err.message.includes("auth failed") && err.message.includes("401"),
    );
  } finally {
    await server.close();
  }
});

test("B.11: 403 → auth-failed error message", async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(403);
    res.end("forbidden");
  });
  try {
    const transport = new HttpFederatedSyncTransport({ endpoint: server.url });
    await assert.rejects(
      transport.pull(),
      (err) => err.message.includes("auth failed") && err.message.includes("403"),
    );
  } finally {
    await server.close();
  }
});

test("B.11: 5xx → generic error preserves status + body", async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(503);
    res.end("service unavailable: maintenance");
  });
  try {
    const transport = new HttpFederatedSyncTransport({ endpoint: server.url });
    await assert.rejects(transport.push([sampleBaseline()]), (err) => {
      return err.message.includes("503") && err.message.includes("maintenance");
    });
  } finally {
    await server.close();
  }
});

test("B.11: server returns malformed JSON shape → Zod throws clean", async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ wrong: "shape" }));
  });
  try {
    const transport = new HttpFederatedSyncTransport({ endpoint: server.url });
    await assert.rejects(
      transport.push([sampleBaseline()]),
      // Zod parse error.
      (err) => err.message.length > 0,
    );
  } finally {
    await server.close();
  }
});

test("B.11: pull on a server that returns a baseline with FORBIDDEN extra field → Zod accepts (passthrough) or strips", async () => {
  const server = await startServer((_req, res) => {
    const tampered = {
      ...sampleBaseline(),
      // Server slipping in a non-allowed field — Zod schema should
      // strip or accept gracefully.
      lesson: "leaked content from server",
      repo: "leaked repo",
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ baselines: [tampered] }));
  });
  try {
    const transport = new HttpFederatedSyncTransport({ endpoint: server.url });
    const baselines = await transport.pull();
    assert.equal(baselines.length, 1);
    // Zod by default strips unknown fields. The transport must NOT
    // expose lesson/repo on the returned baseline.
    assert.equal(baselines[0].lesson, undefined, "extra fields must not pass through");
    assert.equal(baselines[0].repo, undefined);
  } finally {
    await server.close();
  }
});

test("B.11: missing endpoint at construction → clean error", () => {
  assert.throws(() => new HttpFederatedSyncTransport({ endpoint: "" }), /endpoint required/);
});

test("B.11: no apiToken → no Authorization header sent (anonymous push allowed)", async () => {
  let receivedAuth = "no";
  const server = await startServer((req, res) => {
    receivedAuth = req.headers.authorization;
    res.writeHead(200);
    res.end(JSON.stringify({ accepted: 1 }));
  });
  try {
    const transport = new HttpFederatedSyncTransport({ endpoint: server.url });
    await transport.push([sampleBaseline()]);
    assert.equal(receivedAuth, undefined, "anonymous client must not send auth header");
  } finally {
    await server.close();
  }
});
