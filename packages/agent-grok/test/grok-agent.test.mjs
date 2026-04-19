import { test } from "node:test";
import assert from "node:assert/strict";
import { GrokAgent } from "../dist/index.js";
import { EfficiencyGate } from "../../core/dist/index.js";

function stubClient(responses) {
  let i = 0;
  const calls = [];
  const client = {
    chat: {
      completions: {
        create: async (params) => {
          calls.push(params);
          const r = responses[Math.min(i, responses.length - 1)];
          i += 1;
          if (r.throws) throw r.throws;
          return r;
        },
      },
    },
  };
  return { client, calls };
}

function approveResponse() {
  return {
    id: "resp-1",
    model: "grok-code-fast-1",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: JSON.stringify({
            agent: "grok",
            verdict: "approve",
            blockers: [],
            summary: "ok",
          }),
        },
      },
    ],
    usage: { prompt_tokens: 200, completion_tokens: 50 },
  };
}

const ctx = { diff: "small diff", repo: "acme/x", pullNumber: 1, newSha: "abc" };

test("GrokAgent: missing XAI_API_KEY throws", () => {
  const orig = process.env["XAI_API_KEY"];
  delete process.env["XAI_API_KEY"];
  try {
    assert.throws(() => new GrokAgent());
  } finally {
    if (orig !== undefined) process.env["XAI_API_KEY"] = orig;
  }
});

test("GrokAgent: constructs cleanly with injected client", () => {
  const { client } = stubClient([approveResponse()]);
  const agent = new GrokAgent({ client, gate: new EfficiencyGate() });
  assert.equal(agent.id, "grok");
  assert.equal(agent.displayName, "Grok");
});

test("GrokAgent: parses approve through the gate", async () => {
  const { client } = stubClient([approveResponse()]);
  const agent = new GrokAgent({ client, gate: new EfficiencyGate() });
  const res = await agent.review(ctx);
  assert.equal(res.verdict, "approve");
  assert.equal(res.agent, "grok");
});

test("GrokAgent: parses rework with blockers", async () => {
  const { client } = stubClient([
    {
      ...approveResponse(),
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: JSON.stringify({
              agent: "grok",
              verdict: "rework",
              blockers: [{ severity: "major", category: "correctness", message: "bug" }],
              summary: "fix",
            }),
          },
        },
      ],
    },
  ]);
  const agent = new GrokAgent({ client, gate: new EfficiencyGate() });
  const res = await agent.review(ctx);
  assert.equal(res.verdict, "rework");
  assert.equal(res.blockers.length, 1);
});

test("GrokAgent: cost uses Grok pricing table, not OpenAI's", async () => {
  const { client } = stubClient([
    {
      ...approveResponse(),
      model: "grok-code-fast-1",
      usage: { prompt_tokens: 1_000, completion_tokens: 500 },
    },
  ]);
  const agent = new GrokAgent({
    client,
    gate: new EfficiencyGate(),
    model: "grok-code-fast-1",
    apiKey: "xai-test",
  });
  const res = await agent.review(ctx);
  // 1000 * 0.20 + 500 * 1.50 = 950 per 1M = 0.00095
  assert.ok(res.costUsd < 0.001);
  assert.ok(res.costUsd > 0.0009);
});
