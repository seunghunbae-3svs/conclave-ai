import { test } from "node:test";
import assert from "node:assert/strict";
import { EfficiencyGate } from "@conclave-ai/core";
import {
  DesignAgent,
  REVIEW_TOOL_NAME,
  diffTouchesUi,
  isUiPath,
  extractUiDiff,
  MAX_UI_DIFF_CHARS,
  buildTextUIPrompt,
  TEXT_UI_SYSTEM_PROMPT,
} from "../dist/index.js";

// ---- helpers -------------------------------------------------------------

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
  verdict = "rework",
  blockers = [],
  summary = "text-ui review",
  inputTokens = 800,
  outputTokens = 300,
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
  repo: "acme/x",
  pullNumber: 101,
  newSha: "abc123",
};

const tinyPng = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

// Synthetic diff builders
function diffFor(path, added) {
  return [
    `diff --git a/${path} b/${path}`,
    `index 0000000..1111111 100644`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -0,0 +1,${added.length} @@`,
    ...added.map((l) => `+${l}`),
  ].join("\n");
}

// ---- pure helpers tests --------------------------------------------------

test("isUiPath: classifies common UI extensions and fragments", () => {
  assert.equal(isUiPath("src/ui/Button.tsx"), true);
  assert.equal(isUiPath("pages/index.jsx"), true);
  assert.equal(isUiPath("theme/tokens.ts"), true);
  assert.equal(isUiPath("src/components/Card.ts"), true);
  assert.equal(isUiPath("styles/global.css"), true);
  assert.equal(isUiPath("src/lib/foo.ts"), false);
  assert.equal(isUiPath("server/db.ts"), false);
  assert.equal(isUiPath("README.md"), false);
});

test("diffTouchesUi: true on UI file, false on logic-only diff", () => {
  const uiDiff = diffFor("src/ui/Button.tsx", [`<button>Click</button>`]);
  const logicDiff = diffFor("src/lib/calc.ts", [`export const x = 1;`]);
  assert.equal(diffTouchesUi(uiDiff), true);
  assert.equal(diffTouchesUi(logicDiff), false);
});

test("extractUiDiff: drops non-UI hunks, keeps UI hunks, lists UI files", () => {
  const mixed = [
    diffFor("src/lib/calc.ts", [`export const x = 1;`]),
    diffFor("src/ui/Hero.tsx", [`<img src="x.png" />`]),
    diffFor("server/db.ts", [`const q = sql\`...\`;`]),
    diffFor("src/ui/Card.tsx", [`<div className="text-red">hi</div>`]),
  ].join("\n");
  const ex = extractUiDiff(mixed);
  assert.equal(ex.truncated, false);
  assert.deepEqual(ex.files, ["src/ui/Hero.tsx", "src/ui/Card.tsx"]);
  assert.match(ex.text, /src\/ui\/Hero\.tsx/);
  assert.match(ex.text, /src\/ui\/Card\.tsx/);
  assert.doesNotMatch(ex.text, /src\/lib\/calc\.ts/);
  assert.doesNotMatch(ex.text, /server\/db\.ts/);
});

test("extractUiDiff: truncates when UI content exceeds 8000 chars", () => {
  const bigBody = Array.from({ length: 2000 }, (_, i) => `<div>line ${i} — lots of text</div>`);
  const big = diffFor("src/ui/Huge.tsx", bigBody);
  // Force truncation by feeding oversize diff.
  const ex = extractUiDiff(big);
  assert.equal(ex.truncated, true);
  assert.ok(ex.originalChars > MAX_UI_DIFF_CHARS);
  assert.match(ex.text, /truncated/i);
  assert.ok(ex.text.length <= MAX_UI_DIFF_CHARS + 512, "truncated output stays near the budget");
});

test("buildTextUIPrompt: includes UI files, truncation note, and diff fence", () => {
  const diff = diffFor("src/ui/X.tsx", [`<div />`]);
  const ex = extractUiDiff(diff);
  const prompt = buildTextUIPrompt(
    { ...baseCtx, diff },
    ex.text,
    ex.files,
    { truncated: false },
  );
  assert.match(prompt, /text-UI mode/);
  assert.match(prompt, /src\/ui\/X\.tsx/);
  assert.match(prompt, /```diff/);
  assert.match(prompt, /submit_review/);
});

test("TEXT_UI_SYSTEM_PROMPT: covers all five focus areas + non-goals", () => {
  assert.match(TEXT_UI_SYSTEM_PROMPT, /[Ss]emantic HTML/);
  assert.match(TEXT_UI_SYSTEM_PROMPT, /[Aa]ccessibility/);
  assert.match(TEXT_UI_SYSTEM_PROMPT, /token/i);
  assert.match(TEXT_UI_SYSTEM_PROMPT, /[Ll]ayout/);
  assert.match(TEXT_UI_SYSTEM_PROMPT, /[Ii]nteraction state/);
  assert.match(TEXT_UI_SYSTEM_PROMPT, /do NOT re-check/i);
  assert.match(TEXT_UI_SYSTEM_PROMPT, /[Ss]ecurity/);
});

// ---- DesignAgent.review integration tests -------------------------------

test("Mode B: <img> missing alt → a11y blocker surfaced via Mode B", async () => {
  const client = makeMockClient([
    toolUseResponse({
      verdict: "rework",
      blockers: [
        {
          severity: "blocker",
          category: "accessibility",
          message: "src/ui/Hero.tsx: `<img src=\"x.png\" />` missing alt — screen-reader users skip content.",
          file: "src/ui/Hero.tsx",
        },
      ],
      summary: "1 a11y blocker: hero image lacks alt text.",
    }),
  ]);
  const agent = new DesignAgent({
    apiKey: "test-key",
    gate: new EfficiencyGate({ perPrUsd: 1 }),
    client,
  });
  const diff = diffFor("src/ui/Hero.tsx", [`<img src="x.png" />`]);
  const result = await agent.review({
    ...baseCtx,
    domain: "design",
    diff,
  });
  assert.equal(result.agent, "design");
  assert.equal(result.verdict, "rework");
  assert.equal(result.blockers.length, 1);
  assert.equal(result.blockers[0].severity, "blocker");
  assert.equal(result.blockers[0].category, "accessibility");
  assert.match(result.blockers[0].message, /alt/i);

  // Verify Mode B shape: no image content blocks, text-only user content,
  // TEXT_UI_SYSTEM_PROMPT in system.
  assert.equal(client.calls.length, 1);
  const params = client.calls[0];
  assert.ok(Array.isArray(params.system));
  assert.equal(params.system[0].text, TEXT_UI_SYSTEM_PROMPT);
  const userContent = params.messages[0].content;
  const imageBlocks = userContent.filter((b) => b.type === "image");
  assert.equal(imageBlocks.length, 0, "Mode B must not attach images");
  const textBlocks = userContent.filter((b) => b.type === "text");
  assert.ok(textBlocks.some((b) => /Hero\.tsx/.test(b.text)));
});

test("Mode B: hardcoded #ff0000 in tokenized repo → minor token blocker", async () => {
  const client = makeMockClient([
    toolUseResponse({
      verdict: "rework",
      blockers: [
        {
          severity: "minor",
          category: "token-adherence",
          message:
            "src/ui/Card.tsx: hardcoded color `#ff0000` — repo defines `theme.ts` with token `var(--color-danger)`; use that.",
          file: "src/ui/Card.tsx",
        },
      ],
      summary: "One minor: hardcoded color bypasses theme token.",
    }),
  ]);
  const agent = new DesignAgent({
    apiKey: "test-key",
    gate: new EfficiencyGate({ perPrUsd: 1 }),
    client,
  });
  const diff = [
    diffFor("src/theme.ts", [`export const tokens = { danger: "var(--color-danger)" };`]),
    diffFor("src/ui/Card.tsx", [`<div style={{ color: "#ff0000" }}>hi</div>`]),
  ].join("\n");
  const result = await agent.review({
    ...baseCtx,
    domain: "design",
    diff,
  });
  assert.equal(result.verdict, "rework");
  assert.equal(result.blockers.length, 1);
  assert.equal(result.blockers[0].severity, "minor");
  assert.match(result.blockers[0].category, /token/);
});

test("Mode C: pure logic-only diff → graceful skip-approve, no API call", async () => {
  const client = {
    calls: [],
    messages: {
      create: async () => {
        throw new Error("Mode C must not hit the API");
      },
    },
  };
  const agent = new DesignAgent({
    apiKey: "test-key",
    gate: new EfficiencyGate({ perPrUsd: 1 }),
    client,
  });
  const diff = [
    diffFor("src/lib/calc.ts", [`export const x = 1;`]),
    diffFor("server/db.ts", [`const q = 1;`]),
    diffFor("package.json", [`"version": "1.0.0"`]),
  ].join("\n");
  const result = await agent.review({
    ...baseCtx,
    domain: "code",
    diff,
  });
  assert.equal(result.verdict, "approve");
  assert.equal(result.blockers.length, 0);
  assert.match(result.summary, /no UI-relevant/i);
  assert.equal(client.calls.length, 0);
});

test("Mode A wins over Mode B when both visualArtifacts and UI files are present", async () => {
  const client = makeMockClient([
    toolUseResponse({ verdict: "approve", summary: "vision LGTM" }),
  ]);
  const agent = new DesignAgent({
    apiKey: "test-key",
    gate: new EfficiencyGate({ perPrUsd: 1 }),
    client,
  });
  const diff = diffFor("src/ui/Hero.tsx", [`<img src="x.png" alt="hero" />`]);
  const result = await agent.review({
    ...baseCtx,
    domain: "design",
    diff,
    visualArtifacts: [{ route: "/", before: tinyPng, after: tinyPng }],
  });
  assert.equal(result.verdict, "approve");
  // Vision mode sends image blocks; Mode B does not.
  const params = client.calls[0];
  const imageBlocks = params.messages[0].content.filter((b) => b.type === "image");
  assert.equal(imageBlocks.length, 2, "Mode A must attach before + after images");
});

test("Mode B: invalid tool_use response → error-shaped blocker (no throw)", async () => {
  const client = {
    calls: [],
    messages: {
      create: async () => ({
        id: "msg_bad",
        model: "claude-opus-4-7",
        content: [{ type: "text", text: "oops plain text" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 50, output_tokens: 5 },
      }),
    },
  };
  const agent = new DesignAgent({
    apiKey: "test-key",
    gate: new EfficiencyGate({ perPrUsd: 1 }),
    client,
  });
  const diff = diffFor("src/ui/Hero.tsx", [`<img src="x" />`]);
  const result = await agent.review({ ...baseCtx, diff });
  assert.equal(result.verdict, "rework");
  assert.equal(result.blockers[0].category, "agent-error");
});

test("Mode B: large UI diff → truncated, prompt contains truncation note", async () => {
  const client = makeMockClient([
    toolUseResponse({ verdict: "approve", summary: "ok" }),
  ]);
  const agent = new DesignAgent({
    apiKey: "test-key",
    gate: new EfficiencyGate({ perPrUsd: 10 }),
    client,
  });
  const bigBody = Array.from({ length: 3000 }, (_, i) => `<div data-row="${i}">row ${i} filler text</div>`);
  const diff = diffFor("src/ui/Huge.tsx", bigBody);
  const result = await agent.review({ ...baseCtx, diff });
  assert.equal(result.verdict, "approve");
  const params = client.calls[0];
  const userText = params.messages[0].content.find((b) => b.type === "text").text;
  assert.match(userText, /diff-truncated: yes/);
  assert.match(userText, /truncated/i);
  // Full raw diff is NOT inlined.
  assert.ok(
    userText.length < 12_000,
    `prompt must stay bounded; got ${userText.length} chars`,
  );
});
