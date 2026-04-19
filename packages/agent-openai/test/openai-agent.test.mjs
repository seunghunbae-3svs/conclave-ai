import { test } from "node:test";
import assert from "node:assert/strict";
import { EfficiencyGate } from "@conclave-ai/core";
import { OpenAIAgent } from "../dist/index.js";

function jsonChoice(payload, usage = {}) {
  return {
    id: "chatcmpl-test",
    model: "gpt-5-mini",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: JSON.stringify(payload),
        },
      },
    ],
    usage: {
      prompt_tokens: usage.inputTokens ?? 1_000,
      completion_tokens: usage.outputTokens ?? 100,
      prompt_tokens_details: usage.cachedInputTokens !== undefined
        ? { cached_tokens: usage.cachedInputTokens }
        : undefined,
    },
  };
}

function mockClient(responses) {
  let i = 0;
  const calls = [];
  return {
    calls,
    chat: {
      completions: {
        create: async (params) => {
          calls.push(params);
          const r = responses[Math.min(i, responses.length - 1)];
          i += 1;
          return r;
        },
      },
    },
  };
}

const ctx = {
  diff: "diff --git a/x b/x\n+added",
  repo: "acme/x",
  pullNumber: 3,
  newSha: "sha-head",
};

test("OpenAIAgent: parses approve through the gate", async () => {
  const gate = new EfficiencyGate({ perPrUsd: 1 });
  const client = mockClient([jsonChoice({ verdict: "approve", blockers: [], summary: "LGTM" })]);
  const agent = new OpenAIAgent({ apiKey: "test", gate, client });
  const result = await agent.review(ctx);
  assert.equal(result.agent, "openai");
  assert.equal(result.verdict, "approve");
  assert.equal(result.summary, "LGTM");
  assert.ok(typeof result.costUsd === "number" && result.costUsd > 0);
});

test("OpenAIAgent: parses rework with structured blockers and ignores malformed items", async () => {
  const gate = new EfficiencyGate({ perPrUsd: 1 });
  const client = mockClient([
    jsonChoice({
      verdict: "rework",
      blockers: [
        { severity: "blocker", category: "type-error", message: "ts2345", file: "x.ts", line: 10 },
        { severity: "minor", category: "dead-code", message: "unused import", file: null, line: null },
        { invalid: "shape" },
      ],
      summary: "1 blocker + 1 minor",
    }),
  ]);
  const agent = new OpenAIAgent({ apiKey: "test", gate, client });
  const result = await agent.review(ctx);
  assert.equal(result.verdict, "rework");
  assert.equal(result.blockers.length, 2);
  assert.equal(result.blockers[0].file, "x.ts");
  assert.equal(result.blockers[0].line, 10);
});

test("OpenAIAgent: wires strict json_schema response_format", async () => {
  const gate = new EfficiencyGate({ perPrUsd: 1 });
  const client = mockClient([jsonChoice({ verdict: "approve", blockers: [], summary: "" })]);
  const agent = new OpenAIAgent({ apiKey: "test", gate, client });
  await agent.review(ctx);
  const params = client.calls[0];
  assert.equal(params.response_format?.type, "json_schema");
  assert.equal(params.response_format?.json_schema.strict, true);
  assert.equal(params.response_format?.json_schema.name, "conclave_review");
});

test("OpenAIAgent: applies cached-token discount to actualCost", async () => {
  const gate = new EfficiencyGate({ perPrUsd: 1 });
  const clientCached = mockClient([
    jsonChoice({ verdict: "approve", blockers: [], summary: "" }, { inputTokens: 10_000, cachedInputTokens: 9_000 }),
  ]);
  const clientFresh = mockClient([
    jsonChoice({ verdict: "approve", blockers: [], summary: "" }, { inputTokens: 10_000 }),
  ]);
  const agentCached = new OpenAIAgent({ apiKey: "test", gate: new EfficiencyGate({ perPrUsd: 1 }), client: clientCached });
  const agentFresh = new OpenAIAgent({ apiKey: "test", gate: new EfficiencyGate({ perPrUsd: 1 }), client: clientFresh });
  const cached = await agentCached.review(ctx);
  const fresh = await agentFresh.review(ctx);
  assert.ok(cached.costUsd < fresh.costUsd, `expected cached cheaper than fresh, got ${cached.costUsd} vs ${fresh.costUsd}`);
  void gate;
});

test("OpenAIAgent: refusal throws actionable error", async () => {
  const client = {
    calls: [],
    chat: {
      completions: {
        create: async () => ({
          id: "x",
          model: "gpt-5-mini",
          choices: [{ index: 0, finish_reason: "content_filter", message: { role: "assistant", content: null, refusal: "I cannot." } }],
        }),
      },
    },
  };
  const agent = new OpenAIAgent({ apiKey: "k", client, gate: new EfficiencyGate({ perPrUsd: 1 }) });
  await assert.rejects(() => agent.review(ctx), /model refused/);
});

test("OpenAIAgent: invalid JSON in content throws", async () => {
  const client = {
    calls: [],
    chat: {
      completions: {
        create: async () => ({
          id: "x",
          model: "gpt-5-mini",
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "not json" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      },
    },
  };
  const agent = new OpenAIAgent({ apiKey: "k", client, gate: new EfficiencyGate({ perPrUsd: 1 }) });
  await assert.rejects(() => agent.review(ctx), /not valid JSON/);
});

test("OpenAIAgent: invalid verdict value throws", async () => {
  const client = mockClient([jsonChoice({ verdict: "yolo", blockers: [], summary: "" })]);
  const agent = new OpenAIAgent({ apiKey: "k", client, gate: new EfficiencyGate({ perPrUsd: 1 }) });
  await assert.rejects(() => agent.review(ctx), /invalid verdict/);
});

test("OpenAIAgent: missing API key and no client throws in constructor", () => {
  const orig = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    assert.throws(() => new OpenAIAgent());
  } finally {
    if (orig !== undefined) process.env.OPENAI_API_KEY = orig;
  }
});

test("OpenAIAgent: metrics recorded on shared gate", async () => {
  const gate = new EfficiencyGate({ perPrUsd: 1 });
  const client = mockClient([jsonChoice({ verdict: "approve", blockers: [], summary: "" })]);
  const agent = new OpenAIAgent({ apiKey: "k", gate, client });
  await agent.review(ctx);
  const s = gate.metrics.summary();
  assert.equal(s.callCount, 1);
  assert.equal(s.byAgent["openai"].calls, 1);
});

test("OpenAIAgent: pre-flight budget throw prevents network call", async () => {
  const gate = new EfficiencyGate({ perPrUsd: 0.00001 });
  const client = mockClient([jsonChoice({ verdict: "approve", blockers: [], summary: "" })]);
  const agent = new OpenAIAgent({ apiKey: "k", gate, client });
  await assert.rejects(() => agent.review(ctx), /budget/);
  assert.equal(client.calls.length, 0);
});
