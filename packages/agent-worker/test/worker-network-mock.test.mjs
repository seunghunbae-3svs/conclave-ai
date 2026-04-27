import { test } from "node:test";
import assert from "node:assert/strict";
import { EfficiencyGate } from "@conclave-ai/core";
import { ClaudeWorker } from "../dist/index.js";

/**
 * v0.13.14 — network-level mocks for the Worker tests.
 *
 * The existing worker.test.mjs mocks at the SDK boundary (passing a
 * fake `client` object with `messages.create`). That covers the
 * worker's logic but NOT the SDK's serialization/deserialization
 * layer — if the SDK upgrade changed the request shape or response
 * envelope, those tests would still pass.
 *
 * These tests pass a real `@anthropic-ai/sdk` Anthropic client to
 * the worker, but inject a custom `fetch` that returns canned HTTP
 * responses matching the Anthropic Messages API shape. The full
 * code path is exercised:
 *   worker → SDK serialize → custom fetch → SDK deserialize → worker
 * If the SDK boundary is broken (wrong content-type, missing usage
 * field, schema drift), these catch it.
 *
 * P4.2 in the overnight handoff. No external libs (nock/msw) — uses
 * the SDK's first-class `fetch` injection point.
 */

const VALID_PATCH = `diff --git a/src/x.ts b/src/x.ts
index 1234567..89abcde 100644
--- a/src/x.ts
+++ b/src/x.ts
@@ -1,3 +1,3 @@
-export const x = 1;
+export const x: number = 1;
 export const y = 2;
 export const z = 3;
`;

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
}

function makeAnthropicResponse({
  patch = VALID_PATCH,
  commitMessage = "fix(x): annotate x as number",
  filesTouched = ["src/x.ts"],
  summary = "Resolves the type-error blocker.",
  inputTokens = 2_000,
  outputTokens = 400,
  cacheRead = 0,
} = {}) {
  return {
    id: "msg_network_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [
      {
        type: "tool_use",
        id: "toolu_01abc",
        name: "submit_patch",
        input: { patch, commitMessage, filesTouched, summary },
      },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: cacheRead,
    },
  };
}

const reviewCtx = {
  repo: "acme/x",
  pullNumber: 1,
  newSha: "abc123",
  reviews: [
    {
      agent: "claude",
      verdict: "rework",
      summary: "ts type missing",
      blockers: [
        { severity: "blocker", category: "type-error", message: "add explicit type annotation", file: "src/x.ts", line: 1 },
      ],
    },
  ],
  fileSnapshots: [
    { path: "src/x.ts", contents: "export const x = 1;\nexport const y = 2;\nexport const z = 3;\n" },
  ],
};

async function makeAnthropicClient(fetchImpl) {
  const mod = await import("@anthropic-ai/sdk");
  const Anthropic = mod.default;
  return new Anthropic({ apiKey: "sk-ant-test-fake-key", fetch: fetchImpl });
}

test("network-mock: SDK + custom fetch returns the patch tool_use through the worker", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: typeof url === "string" ? url : url.toString(), method: init?.method, body: init?.body });
    return jsonResponse(makeAnthropicResponse());
  };
  const client = await makeAnthropicClient(fetchImpl);
  const worker = new ClaudeWorker({ apiKey: "sk-ant-test-fake-key", client, gate: new EfficiencyGate({ perPrUsd: 1 }) });
  const outcome = await worker.work(reviewCtx);

  assert.equal(outcome.patch, VALID_PATCH);
  assert.equal(outcome.message, "fix(x): annotate x as number");
  assert.deepEqual(outcome.appliedFiles, ["src/x.ts"]);
  // SDK actually issued the HTTP call.
  assert.ok(calls.length >= 1, "expected at least one HTTP call");
  // Endpoint sanity: should be the messages API.
  assert.match(calls[0].url, /\/v1\/messages/);
  assert.equal(calls[0].method, "POST");
});

test("network-mock: request body includes the worker system prompt + submit_patch tool", async () => {
  let capturedBody = null;
  const fetchImpl = async (url, init) => {
    capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
    return jsonResponse(makeAnthropicResponse());
  };
  const client = await makeAnthropicClient(fetchImpl);
  const worker = new ClaudeWorker({ apiKey: "sk-ant-test", client, gate: new EfficiencyGate({ perPrUsd: 1 }) });
  await worker.work(reviewCtx);

  assert.ok(capturedBody, "body was not captured");
  // System prompt forms an array of cache-control blocks.
  assert.ok(Array.isArray(capturedBody.system) || typeof capturedBody.system === "string");
  // The submit_patch tool was advertised in the request.
  assert.ok(Array.isArray(capturedBody.tools), "tools must be an array");
  const toolNames = capturedBody.tools.map((t) => t.name);
  assert.ok(toolNames.includes("submit_patch"), `submit_patch missing; got ${toolNames.join(",")}`);
  // tool_choice forces submit_patch.
  assert.equal(capturedBody.tool_choice?.type, "tool");
  assert.equal(capturedBody.tool_choice?.name, "submit_patch");
});

test("network-mock: 4xx body bubbles up as a structured SDK error", async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "bad input" } }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  const client = await makeAnthropicClient(fetchImpl);
  const worker = new ClaudeWorker({ apiKey: "sk-ant-test", client, gate: new EfficiencyGate({ perPrUsd: 1 }) });
  await assert.rejects(() => worker.work(reviewCtx), /bad input|invalid_request_error/i);
});

test("network-mock: 429 rate-limit error surfaces", async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "rate limit hit" } }),
      { status: 429, headers: { "content-type": "application/json" } },
    );
  const client = await makeAnthropicClient(fetchImpl);
  const worker = new ClaudeWorker({ apiKey: "sk-ant-test", client, gate: new EfficiencyGate({ perPrUsd: 1 }) });
  await assert.rejects(() => worker.work(reviewCtx));
});

test("network-mock: missing tool_use in response → parse error reaches the worker", async () => {
  const fetchImpl = async () =>
    jsonResponse({
      id: "msg_no_tool",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "I refuse to call the tool" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    });
  const client = await makeAnthropicClient(fetchImpl);
  const worker = new ClaudeWorker({ apiKey: "sk-ant-test", client, gate: new EfficiencyGate({ perPrUsd: 1 }) });
  await assert.rejects(() => worker.work(reviewCtx), /submit_patch tool_use/i);
});

test("network-mock: cost computation respects the cache_read_input_tokens header", async () => {
  const fetchImpl = async () => jsonResponse(makeAnthropicResponse({ cacheRead: 1_500, inputTokens: 2_000 }));
  const client = await makeAnthropicClient(fetchImpl);
  const gate = new EfficiencyGate({ perPrUsd: 1 });
  const worker = new ClaudeWorker({ apiKey: "sk-ant-test", client, gate });
  const outcome = await worker.work(reviewCtx);
  // 1500 of the 2000 input tokens were cached → cheaper than the
  // all-fresh equivalent. Just sanity-check that the cost is non-zero
  // and finite (the actual pricing math is covered by pricing tests).
  assert.ok(typeof outcome.costUsd === "number" && outcome.costUsd > 0 && Number.isFinite(outcome.costUsd));
});

test("network-mock: API-key absent and no client → constructor throws (existing contract)", async () => {
  // This path doesn't touch fetch — verifies the constructor invariant
  // is preserved when the client option is absent.
  const orig = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    assert.throws(() => new ClaudeWorker());
  } finally {
    if (orig !== undefined) process.env.ANTHROPIC_API_KEY = orig;
  }
});
