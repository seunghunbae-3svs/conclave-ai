import { test } from "node:test";
import assert from "node:assert/strict";
import { EfficiencyGate } from "@conclave-ai/core";
import { ClaudeAgent } from "../dist/index.js";

function makeMockClient(responses) {
  let i = 0;
  const calls = [];
  return {
    calls,
    messages: {
      create: async (params) => {
        calls.push(params);
        const r = responses[Math.min(i, responses.length - 1)];
        i += 1;
        return r;
      },
    },
  };
}

function okResponse({ verdict = "approve", blockers = [], summary = "ok", inputTokens = 1_000, outputTokens = 100, cacheRead = 0 } = {}) {
  return {
    id: "msg_test",
    model: "claude-sonnet-4-6",
    content: [
      {
        type: "tool_use",
        id: "tool_1",
        name: "submit_review",
        input: { verdict, blockers, summary },
      },
    ],
    stop_reason: "tool_use",
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_input_tokens: cacheRead,
    },
  };
}

const ctx = {
  diff: "diff --git a/x b/x\n+added",
  repo: "acme/x",
  pullNumber: 1,
  newSha: "abc123",
};

test("ClaudeAgent: parses approve verdict through the efficiency gate", async () => {
  const gate = new EfficiencyGate({ perPrUsd: 1 });
  const client = makeMockClient([okResponse({ verdict: "approve", summary: "LGTM" })]);
  const agent = new ClaudeAgent({ apiKey: "test-key", gate, client });
  const result = await agent.review(ctx);
  assert.equal(result.agent, "claude");
  assert.equal(result.verdict, "approve");
  assert.equal(result.blockers.length, 0);
  assert.equal(result.summary, "LGTM");
  assert.ok(typeof result.costUsd === "number" && result.costUsd > 0);
  assert.ok(typeof result.tokensUsed === "number" && result.tokensUsed === 1_100);
});

test("ClaudeAgent: parses rework verdict with blockers", async () => {
  const gate = new EfficiencyGate({ perPrUsd: 1 });
  const client = makeMockClient([
    okResponse({
      verdict: "rework",
      blockers: [
        { severity: "blocker", category: "type-error", message: "ts2345 on line 7", file: "src/x.ts", line: 7 },
        { severity: "minor", category: "missing-test", message: "no test for new branch" },
        { invalid: "shape", should: "drop" },
      ],
      summary: "1 blocker, 1 minor",
    }),
  ]);
  const agent = new ClaudeAgent({ apiKey: "test-key", gate, client });
  const result = await agent.review(ctx);
  assert.equal(result.verdict, "rework");
  assert.equal(result.blockers.length, 2);
  assert.equal(result.blockers[0].severity, "blocker");
  assert.equal(result.blockers[0].file, "src/x.ts");
  assert.equal(result.blockers[0].line, 7);
  assert.equal(result.blockers[1].severity, "minor");
});

test("ClaudeAgent: throws when response has no tool_use block", async () => {
  const client = {
    calls: [],
    messages: {
      create: async () => ({
        id: "msg",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "I forgot to call the tool" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 10 },
      }),
    },
  };
  const agent = new ClaudeAgent({ apiKey: "k", client, gate: new EfficiencyGate({ perPrUsd: 1 }) });
  await assert.rejects(() => agent.review(ctx), /did not include a submit_review tool_use/);
});

test("ClaudeAgent: throws on invalid verdict value", async () => {
  const client = makeMockClient([okResponse({ verdict: "ship-it-lol" })]);
  const agent = new ClaudeAgent({ apiKey: "k", client, gate: new EfficiencyGate({ perPrUsd: 1 }) });
  await assert.rejects(() => agent.review(ctx), /invalid verdict/);
});

test("ClaudeAgent: records a metric on the shared gate", async () => {
  const gate = new EfficiencyGate({ perPrUsd: 1 });
  const client = makeMockClient([okResponse({ verdict: "approve", inputTokens: 5_000, outputTokens: 200 })]);
  const agent = new ClaudeAgent({ apiKey: "k", gate, client });
  await agent.review(ctx);
  const summary = gate.metrics.summary();
  assert.equal(summary.callCount, 1);
  assert.equal(summary.byAgent["claude"].calls, 1);
  assert.ok(summary.totalCostUsd > 0);
});

test("ClaudeAgent: sends system prompt with cache_control ephemeral", async () => {
  const gate = new EfficiencyGate({ perPrUsd: 1 });
  const client = makeMockClient([okResponse()]);
  const agent = new ClaudeAgent({ apiKey: "k", gate, client });
  await agent.review(ctx);
  const params = client.calls[0];
  assert.ok(Array.isArray(params.system), "system should be an array of blocks for cache control");
  assert.equal(params.system[0].cache_control?.type, "ephemeral");
});

test("ClaudeAgent: forces submit_review tool via tool_choice", async () => {
  const gate = new EfficiencyGate({ perPrUsd: 1 });
  const client = makeMockClient([okResponse()]);
  const agent = new ClaudeAgent({ apiKey: "k", gate, client });
  await agent.review(ctx);
  const params = client.calls[0];
  assert.equal(params.tool_choice.type, "tool");
  assert.equal(params.tool_choice.name, "submit_review");
});

test("ClaudeAgent: respects a shared budget cap across calls", async () => {
  const gate = new EfficiencyGate({ perPrUsd: 0.005 }); // tiny budget
  const client = makeMockClient([
    okResponse({ inputTokens: 10_000, outputTokens: 500 }), // ~$0.0375 → exceeds 0.005
  ]);
  const agent = new ClaudeAgent({ apiKey: "k", gate, client });
  await assert.rejects(() => agent.review(ctx), /budget/);
});

test("ClaudeAgent: missing API key AND no injected client throws in constructor", () => {
  const orig = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    assert.throws(() => new ClaudeAgent());
  } finally {
    if (orig !== undefined) process.env.ANTHROPIC_API_KEY = orig;
  }
});
