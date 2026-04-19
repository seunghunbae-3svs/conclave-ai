import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeVisionJudge } from "../dist/index.js";

function mockClient(responses) {
  let i = 0;
  const calls = [];
  return {
    calls,
    messages: {
      create: async (params) => {
        calls.push(params);
        const r = responses[Math.min(i, responses.length - 1)];
        i += 1;
        if (r.throw) throw new Error(r.throw);
        return r.response;
      },
    },
  };
}

function toolUseResponse(input) {
  return {
    response: {
      content: [{ type: "tool_use", id: "tu-1", name: "submit_visual_judgment", input }],
      stop_reason: "tool_use",
      usage: { input_tokens: 100, output_tokens: 50 },
    },
  };
}

const pngA = new Uint8Array([1, 2, 3, 4, 5]);
const pngB = new Uint8Array([6, 7, 8, 9, 10]);

test("ClaudeVisionJudge: missing API key AND no client throws in constructor", () => {
  const orig = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    assert.throws(() => new ClaudeVisionJudge());
  } finally {
    if (orig !== undefined) process.env.ANTHROPIC_API_KEY = orig;
  }
});

test("ClaudeVisionJudge: parses intentional judgment", async () => {
  const client = mockClient([
    toolUseResponse({
      category: "intentional",
      confidence: 0.92,
      summary: "Login page redesigned with new brand colors — consistent, polished.",
      concerns: [],
    }),
  ]);
  const judge = new ClaudeVisionJudge({ apiKey: "test", client });
  const result = await judge.judge(pngA, pngB);
  assert.equal(result.category, "intentional");
  assert.equal(result.confidence, 0.92);
  assert.equal(result.concerns.length, 0);
  assert.match(result.summary, /redesigned/);
});

test("ClaudeVisionJudge: parses regression with concerns", async () => {
  const client = mockClient([
    toolUseResponse({
      category: "regression",
      confidence: 0.85,
      summary: "Header CTA button got cropped; text below fold.",
      concerns: [
        { kind: "layout-shift", severity: "blocker", message: "Hero section pushed below viewport" },
        { kind: "cropped-text", severity: "major", message: "Sign-up button text cut off at right edge" },
      ],
    }),
  ]);
  const judge = new ClaudeVisionJudge({ apiKey: "test", client });
  const result = await judge.judge(pngA, pngB);
  assert.equal(result.category, "regression");
  assert.equal(result.concerns.length, 2);
  assert.equal(result.concerns[0].severity, "blocker");
  assert.equal(result.concerns[0].kind, "layout-shift");
});

test("ClaudeVisionJudge: filters malformed concerns individually", async () => {
  const client = mockClient([
    toolUseResponse({
      category: "mixed",
      confidence: 0.7,
      summary: "Some good, some not",
      concerns: [
        { kind: "contrast", severity: "major", message: "body text contrast dropped" },
        { severity: "blocker", message: "missing kind" },
        { kind: "no-severity", message: "whatever" },
        { kind: "no-message", severity: "minor" },
        { kind: "good-one", severity: "minor", message: "ok" },
      ],
    }),
  ]);
  const judge = new ClaudeVisionJudge({ apiKey: "test", client });
  const result = await judge.judge(pngA, pngB);
  assert.equal(result.concerns.length, 2); // only the two well-formed ones
  const kinds = result.concerns.map((c) => c.kind).sort();
  assert.deepEqual(kinds, ["contrast", "good-one"]);
});

test("ClaudeVisionJudge: sends base64 image blocks in correct order", async () => {
  const client = mockClient([
    toolUseResponse({ category: "intentional", confidence: 0.9, summary: "ok", concerns: [] }),
  ]);
  const judge = new ClaudeVisionJudge({ apiKey: "test", client });
  await judge.judge(pngA, pngB);
  const params = client.calls[0];
  const blocks = params.messages[0].content;
  const imageBlocks = blocks.filter((b) => b.type === "image");
  assert.equal(imageBlocks.length, 2);
  // both use base64 / image/png
  for (const b of imageBlocks) {
    assert.equal(b.source.type, "base64");
    assert.equal(b.source.media_type, "image/png");
  }
  // text labels BEFORE / AFTER before each image
  const textBlocks = blocks.filter((b) => b.type === "text");
  assert.ok(textBlocks.some((t) => t.text === "BEFORE:"));
  assert.ok(textBlocks.some((t) => t.text === "AFTER:"));
});

test("ClaudeVisionJudge: forces submit_visual_judgment tool via tool_choice", async () => {
  const client = mockClient([
    toolUseResponse({ category: "intentional", confidence: 0.9, summary: "ok", concerns: [] }),
  ]);
  const judge = new ClaudeVisionJudge({ apiKey: "test", client });
  await judge.judge(pngA, pngB);
  const params = client.calls[0];
  assert.equal(params.tool_choice.type, "tool");
  assert.equal(params.tool_choice.name, "submit_visual_judgment");
  assert.equal(params.tools[0].name, "submit_visual_judgment");
});

test("ClaudeVisionJudge: judgeContext.changeHint + codeReviewContext injected into prompt", async () => {
  const client = mockClient([
    toolUseResponse({ category: "intentional", confidence: 0.9, summary: "ok", concerns: [] }),
  ]);
  const judge = new ClaudeVisionJudge({ apiKey: "test", client });
  await judge.judge(pngA, pngB, {
    changeHint: "new login flow",
    codeReviewContext: { repo: "acme/app", pullNumber: 7, diff: "diff --git a/foo b/foo\n+bar" },
  });
  const userText = client.calls[0].messages[0].content.find((b) => b.type === "text" && b.text.includes("Change hint"));
  assert.ok(userText);
  assert.match(userText.text, /new login flow/);
  assert.match(userText.text, /acme\/app #7/);
  assert.match(userText.text, /diff --git/);
});

test("ClaudeVisionJudge: response without submit tool_use returns unreviewable", async () => {
  const client = {
    messages: {
      create: async () => ({
        content: [{ type: "text", text: "I couldn't decide" }],
        stop_reason: "end_turn",
      }),
    },
  };
  const judge = new ClaudeVisionJudge({ apiKey: "test", client });
  const result = await judge.judge(pngA, pngB);
  assert.equal(result.category, "unreviewable");
  assert.equal(result.confidence, 0);
  assert.match(result.summary, /did not call/i);
});

test("ClaudeVisionJudge: invalid category coerces to unreviewable", async () => {
  const client = mockClient([
    toolUseResponse({
      category: "kaboom",
      confidence: 0.5,
      summary: "weird",
      concerns: [],
    }),
  ]);
  const judge = new ClaudeVisionJudge({ apiKey: "test", client });
  const result = await judge.judge(pngA, pngB);
  assert.equal(result.category, "unreviewable");
});

test("ClaudeVisionJudge: confidence clamped to [0, 1]", async () => {
  const clientLow = mockClient([
    toolUseResponse({ category: "intentional", confidence: -0.5, summary: "", concerns: [] }),
  ]);
  const clientHigh = mockClient([
    toolUseResponse({ category: "intentional", confidence: 2.5, summary: "", concerns: [] }),
  ]);
  const judgeLow = new ClaudeVisionJudge({ apiKey: "k", client: clientLow });
  const judgeHigh = new ClaudeVisionJudge({ apiKey: "k", client: clientHigh });
  assert.equal((await judgeLow.judge(pngA, pngB)).confidence, 0);
  assert.equal((await judgeHigh.judge(pngA, pngB)).confidence, 1);
});

test("ClaudeVisionJudge: NaN confidence → 0", async () => {
  const client = mockClient([
    toolUseResponse({ category: "intentional", confidence: Number.NaN, summary: "", concerns: [] }),
  ]);
  const judge = new ClaudeVisionJudge({ apiKey: "k", client });
  const r = await judge.judge(pngA, pngB);
  assert.equal(r.confidence, 0);
});
