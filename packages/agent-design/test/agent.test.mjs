import { test } from "node:test";
import assert from "node:assert/strict";
import { EfficiencyGate } from "@conclave-ai/core";
import { DesignAgent, REVIEW_TOOL_NAME } from "../dist/index.js";

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

function toolUseResponse({
  verdict = "approve",
  blockers = [],
  summary = "visuals look clean",
  inputTokens = 2_500,
  outputTokens = 200,
} = {}) {
  return {
    id: "msg_test",
    model: "claude-opus-4-7",
    content: [
      {
        type: "tool_use",
        id: "tool_1",
        name: REVIEW_TOOL_NAME,
        input: { verdict, blockers, summary },
      },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

const baseCtx = {
  diff: "diff --git a/x b/x\n+added",
  repo: "acme/x",
  pullNumber: 42,
  newSha: "abc123",
};

const tinyPng = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

test("DesignAgent: no visual artifacts → graceful approve skip", async () => {
  const agent = new DesignAgent({
    apiKey: "test-key",
    gate: new EfficiencyGate({ perPrUsd: 1 }),
    // No client needed — this path never touches it.
    client: {
      calls: [],
      messages: {
        create: async () => {
          throw new Error("DesignAgent should not hit the client when there are no visual artifacts");
        },
      },
    },
  });
  const result = await agent.review({ ...baseCtx, domain: "design" });
  assert.equal(result.agent, "design");
  assert.equal(result.verdict, "approve");
  assert.equal(result.blockers.length, 0);
  assert.match(result.summary, /no visual artifacts/i);
});

test("DesignAgent: artifacts present → sends vision content, parses tool_use into ReviewResult", async () => {
  const client = makeMockClient([
    toolUseResponse({
      verdict: "rework",
      blockers: [
        {
          severity: "major",
          category: "contrast",
          message: "Body text contrast dropped below WCAG AA on hero section",
          file: "/landing",
        },
        {
          severity: "minor",
          category: "layout-regression",
          message: "CTA button right-edge crops on 1280 width",
        },
        { invalid: "shape", ignored: true },
      ],
      summary: "2 visual issues — hero contrast + CTA crop on medium viewport.",
    }),
  ]);
  const agent = new DesignAgent({
    apiKey: "test-key",
    gate: new EfficiencyGate({ perPrUsd: 1 }),
    client,
  });
  const result = await agent.review({
    ...baseCtx,
    domain: "design",
    visualArtifacts: [{ route: "/landing", before: tinyPng, after: tinyPng }],
  });
  assert.equal(result.verdict, "rework");
  assert.equal(result.blockers.length, 2);
  assert.equal(result.blockers[0].category, "contrast");
  assert.equal(result.blockers[0].severity, "major");
  assert.equal(result.blockers[1].category, "layout-regression");
  assert.match(result.summary, /hero contrast/);

  // Verify the request shape: vision content blocks + tool_choice pin.
  assert.equal(client.calls.length, 1);
  const params = client.calls[0];
  assert.equal(params.tool_choice.type, "tool");
  assert.equal(params.tool_choice.name, REVIEW_TOOL_NAME);
  const userContent = params.messages[0].content;
  assert.ok(Array.isArray(userContent), "user content must be a vision blocks array");
  const imageBlocks = userContent.filter((b) => b.type === "image");
  assert.equal(imageBlocks.length, 2, "one before + one after image block");
  for (const ib of imageBlocks) {
    assert.equal(ib.source.type, "base64");
    assert.equal(ib.source.media_type, "image/png");
    assert.equal(typeof ib.source.data, "string");
    assert.ok(ib.source.data.length > 0);
  }
  // System prompt must be cache-controlled for prompt-cache hits on
  // repeat calls within the same PR deliberation.
  assert.ok(Array.isArray(params.system));
  assert.equal(params.system[0].cache_control?.type, "ephemeral");
});

test("DesignAgent: response missing tool_use → error-shaped ReviewResult (no throw)", async () => {
  const client = {
    calls: [],
    messages: {
      create: async () => ({
        id: "msg_bad",
        model: "claude-opus-4-7",
        content: [{ type: "text", text: "I decided to reply as plain text, oops." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 10 },
      }),
    },
  };
  const agent = new DesignAgent({
    apiKey: "test-key",
    gate: new EfficiencyGate({ perPrUsd: 1 }),
    client,
  });
  const result = await agent.review({
    ...baseCtx,
    domain: "design",
    visualArtifacts: [{ route: "/x", before: tinyPng, after: tinyPng }],
  });
  assert.equal(result.agent, "design");
  assert.equal(result.verdict, "rework");
  assert.equal(result.blockers.length, 1);
  assert.equal(result.blockers[0].category, "agent-error");
  assert.match(result.summary, /did not include/i);
});

test("DesignAgent: invalid verdict value → error-shaped ReviewResult (no throw)", async () => {
  const client = makeMockClient([toolUseResponse({ verdict: "ship-it-lol" })]);
  const agent = new DesignAgent({
    apiKey: "test-key",
    gate: new EfficiencyGate({ perPrUsd: 1 }),
    client,
  });
  const result = await agent.review({
    ...baseCtx,
    domain: "design",
    visualArtifacts: [{ route: "/x", before: tinyPng, after: tinyPng }],
  });
  assert.equal(result.verdict, "rework");
  assert.equal(result.blockers[0].category, "agent-error");
  assert.match(result.summary, /invalid verdict/i);
});

test("DesignAgent: constructor throws when no api key AND no client", () => {
  const orig = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    assert.throws(() => new DesignAgent());
  } finally {
    if (orig !== undefined) process.env.ANTHROPIC_API_KEY = orig;
  }
});

test("DesignAgent: accepts base64 string artifacts (not just Buffer)", async () => {
  const client = makeMockClient([toolUseResponse({ verdict: "approve", summary: "LGTM" })]);
  const agent = new DesignAgent({
    apiKey: "test-key",
    gate: new EfficiencyGate({ perPrUsd: 1 }),
    client,
  });
  const b64 = tinyPng.toString("base64");
  const result = await agent.review({
    ...baseCtx,
    domain: "design",
    visualArtifacts: [{ route: "/x", before: b64, after: b64 }],
  });
  assert.equal(result.verdict, "approve");
  const params = client.calls[0];
  const images = params.messages[0].content.filter((b) => b.type === "image");
  assert.equal(images.length, 2);
  assert.equal(images[0].source.data, b64);
});
