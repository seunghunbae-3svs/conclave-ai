import { test } from "node:test";
import assert from "node:assert/strict";
import { EfficiencyGate } from "@ai-conclave/core";
import { GeminiAgent } from "../dist/index.js";

function okResponse(payload, usage = {}) {
  return {
    candidates: [
      {
        content: { parts: [{ text: JSON.stringify(payload) }] },
        finishReason: "STOP",
      },
    ],
    usageMetadata: {
      promptTokenCount: usage.inputTokens ?? 1_000,
      candidatesTokenCount: usage.outputTokens ?? 100,
      cachedContentTokenCount: usage.cachedInputTokens,
    },
  };
}

function mockClient(responses) {
  let i = 0;
  const calls = [];
  return {
    calls,
    models: {
      generateContent: async (params) => {
        calls.push(params);
        const r = responses[Math.min(i, responses.length - 1)];
        i += 1;
        return r;
      },
    },
  };
}

const ctx = {
  diff: "diff --git a/x b/x\n+added",
  repo: "acme/x",
  pullNumber: 4,
  newSha: "head-sha",
};

test("GeminiAgent: parses approve through the gate", async () => {
  const gate = new EfficiencyGate({ perPrUsd: 1 });
  const client = mockClient([okResponse({ verdict: "approve", blockers: [], summary: "LGTM" })]);
  const agent = new GeminiAgent({ apiKey: "k", gate, client });
  const result = await agent.review(ctx);
  assert.equal(result.agent, "gemini");
  assert.equal(result.verdict, "approve");
  assert.equal(result.summary, "LGTM");
  assert.ok(typeof result.costUsd === "number" && result.costUsd > 0);
});

test("GeminiAgent: parses rework with blockers, drops malformed items", async () => {
  const gate = new EfficiencyGate({ perPrUsd: 1 });
  const client = mockClient([
    okResponse({
      verdict: "rework",
      blockers: [
        { severity: "blocker", category: "type-error", message: "ts2345", file: "x.ts", line: 7 },
        { severity: "minor", category: "dead-code", message: "unused", file: null, line: null },
        { garbage: true },
      ],
      summary: "1 blocker + 1 minor",
    }),
  ]);
  const agent = new GeminiAgent({ apiKey: "k", gate, client });
  const result = await agent.review(ctx);
  assert.equal(result.verdict, "rework");
  assert.equal(result.blockers.length, 2);
  assert.equal(result.blockers[0].line, 7);
});

test("GeminiAgent: wires responseMimeType + responseSchema", async () => {
  const gate = new EfficiencyGate({ perPrUsd: 1 });
  const client = mockClient([okResponse({ verdict: "approve", blockers: [], summary: "" })]);
  const agent = new GeminiAgent({ apiKey: "k", gate, client });
  await agent.review(ctx);
  const params = client.calls[0];
  assert.equal(params.config?.responseMimeType, "application/json");
  assert.ok(params.config?.responseSchema, "expected responseSchema set");
});

test("GeminiAgent: systemInstruction carries the cacheable prefix", async () => {
  const gate = new EfficiencyGate({ perPrUsd: 1 });
  const client = mockClient([okResponse({ verdict: "approve", blockers: [], summary: "" })]);
  const agent = new GeminiAgent({ apiKey: "k", gate, client });
  await agent.review(ctx);
  const sys = client.calls[0].config?.systemInstruction;
  assert.ok(sys && typeof sys === "object" && "parts" in sys);
});

test("GeminiAgent: cached-token discount applied in actualCost", async () => {
  const clientCached = mockClient([
    okResponse({ verdict: "approve", blockers: [], summary: "" }, { inputTokens: 10_000, cachedInputTokens: 9_000 }),
  ]);
  const clientFresh = mockClient([
    okResponse({ verdict: "approve", blockers: [], summary: "" }, { inputTokens: 10_000 }),
  ]);
  const cached = await new GeminiAgent({
    apiKey: "k",
    gate: new EfficiencyGate({ perPrUsd: 1 }),
    client: clientCached,
  }).review(ctx);
  const fresh = await new GeminiAgent({
    apiKey: "k",
    gate: new EfficiencyGate({ perPrUsd: 1 }),
    client: clientFresh,
  }).review(ctx);
  assert.ok(cached.costUsd < fresh.costUsd);
});

test("GeminiAgent: empty text response throws with finishReason", async () => {
  const client = {
    calls: [],
    models: {
      generateContent: async () => ({ candidates: [{ finishReason: "SAFETY" }] }),
    },
  };
  const agent = new GeminiAgent({ apiKey: "k", client, gate: new EfficiencyGate({ perPrUsd: 1 }) });
  await assert.rejects(() => agent.review(ctx), /finishReason=SAFETY/);
});

test("GeminiAgent: invalid JSON throws", async () => {
  const client = {
    calls: [],
    models: {
      generateContent: async () => ({
        candidates: [{ content: { parts: [{ text: "not json" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      }),
    },
  };
  const agent = new GeminiAgent({ apiKey: "k", client, gate: new EfficiencyGate({ perPrUsd: 1 }) });
  await assert.rejects(() => agent.review(ctx), /not valid JSON/);
});

test("GeminiAgent: invalid verdict throws", async () => {
  const client = mockClient([okResponse({ verdict: "yolo", blockers: [], summary: "" })]);
  const agent = new GeminiAgent({ apiKey: "k", client, gate: new EfficiencyGate({ perPrUsd: 1 }) });
  await assert.rejects(() => agent.review(ctx), /invalid verdict/);
});

test("GeminiAgent: missing API key + no client throws in constructor", () => {
  const g = process.env.GOOGLE_API_KEY;
  const m = process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    assert.throws(() => new GeminiAgent());
  } finally {
    if (g !== undefined) process.env.GOOGLE_API_KEY = g;
    if (m !== undefined) process.env.GEMINI_API_KEY = m;
  }
});

test("GeminiAgent: accepts GEMINI_API_KEY fallback when GOOGLE_API_KEY unset", () => {
  const g = process.env.GOOGLE_API_KEY;
  const m = process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  process.env.GEMINI_API_KEY = "fallback-key";
  try {
    const agent = new GeminiAgent();
    assert.ok(agent);
  } finally {
    if (g !== undefined) process.env.GOOGLE_API_KEY = g;
    if (m !== undefined) process.env.GEMINI_API_KEY = m;
    else delete process.env.GEMINI_API_KEY;
  }
});

test("GeminiAgent: pre-flight budget throws before network call", async () => {
  const gate = new EfficiencyGate({ perPrUsd: 0.00001 });
  const client = mockClient([okResponse({ verdict: "approve", blockers: [], summary: "" })]);
  const agent = new GeminiAgent({ apiKey: "k", gate, client });
  await assert.rejects(() => agent.review(ctx), /budget/);
  assert.equal(client.calls.length, 0);
});
