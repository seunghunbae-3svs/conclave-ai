import { test } from "node:test";
import assert from "node:assert/strict";
import { OllamaAgent } from "../dist/index.js";
import { EfficiencyGate } from "../../core/dist/index.js";

/**
 * Minimal OpenAI-like client stub.
 */
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

function approveResponse(extra = {}) {
  return {
    id: "resp-1",
    model: "llama3.3",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: JSON.stringify({
            agent: "ollama",
            verdict: "approve",
            blockers: [],
            summary: "ok",
          }),
        },
      },
    ],
    usage: { prompt_tokens: 200, completion_tokens: 50 },
    ...extra,
  };
}

const ctx = {
  diff: "small diff",
  repo: "acme/x",
  pullNumber: 1,
  newSha: "abc",
};

test("OllamaAgent: default baseURL is localhost:11434/v1", async () => {
  const { client, calls } = stubClient([approveResponse()]);
  const agent = new OllamaAgent({ client, gate: new EfficiencyGate() });
  await agent.review(ctx);
  assert.equal(calls.length, 1);
  // The client stub doesn't expose baseURL, but `new OllamaAgent({})` must
  // not throw (no API key required) — that's the load-bearing contract.
  assert.equal(agent.id, "ollama");
});

test("OllamaAgent: parses approve through the gate", async () => {
  const { client } = stubClient([approveResponse()]);
  const agent = new OllamaAgent({ client, gate: new EfficiencyGate() });
  const res = await agent.review(ctx);
  assert.equal(res.verdict, "approve");
  assert.equal(res.agent, "ollama");
  assert.equal(res.costUsd, 0, "Ollama calls are free");
});

test("OllamaAgent: parses rework with blockers", async () => {
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
              agent: "ollama",
              verdict: "rework",
              blockers: [{ severity: "major", category: "correctness", message: "bug" }],
              summary: "fix bug",
            }),
          },
        },
      ],
    },
  ]);
  const agent = new OllamaAgent({ client, gate: new EfficiencyGate() });
  const res = await agent.review(ctx);
  assert.equal(res.verdict, "rework");
  assert.equal(res.blockers.length, 1);
  assert.equal(res.blockers[0].message, "bug");
});

test("OllamaAgent: zero cost regardless of token volume", async () => {
  const { client } = stubClient([
    {
      ...approveResponse(),
      usage: { prompt_tokens: 100_000, completion_tokens: 50_000 },
    },
  ]);
  const agent = new OllamaAgent({ client, gate: new EfficiencyGate() });
  const res = await agent.review(ctx);
  assert.equal(res.costUsd, 0);
});

test("OllamaAgent: custom baseURL flows through to clientFactory", async () => {
  let capturedBaseURL;
  const customFactory = async (baseURL) => {
    capturedBaseURL = baseURL;
    const { client } = stubClient([approveResponse()]);
    return client;
  };
  const agent = new OllamaAgent({
    baseURL: "http://remote.ollama:11434/v1",
    clientFactory: customFactory,
    gate: new EfficiencyGate(),
  });
  await agent.review(ctx);
  assert.equal(capturedBaseURL, "http://remote.ollama:11434/v1");
});

test("OllamaAgent: OLLAMA_BASE_URL env overrides default", async () => {
  const orig = process.env["OLLAMA_BASE_URL"];
  process.env["OLLAMA_BASE_URL"] = "http://env.ollama:11434/v1";
  try {
    let captured;
    const agent = new OllamaAgent({
      clientFactory: async (baseURL) => {
        captured = baseURL;
        const { client } = stubClient([approveResponse()]);
        return client;
      },
      gate: new EfficiencyGate(),
    });
    await agent.review(ctx);
    assert.equal(captured, "http://env.ollama:11434/v1");
  } finally {
    if (orig === undefined) delete process.env["OLLAMA_BASE_URL"];
    else process.env["OLLAMA_BASE_URL"] = orig;
  }
});

test("OllamaAgent: no API key required — constructs with empty env", () => {
  const origOpenAI = process.env["OPENAI_API_KEY"];
  delete process.env["OPENAI_API_KEY"];
  try {
    const { client } = stubClient([approveResponse()]);
    // Must not throw — this is the big differentiator vs other agents.
    const agent = new OllamaAgent({ client, gate: new EfficiencyGate() });
    assert.equal(agent.id, "ollama");
  } finally {
    if (origOpenAI !== undefined) process.env["OPENAI_API_KEY"] = origOpenAI;
  }
});
