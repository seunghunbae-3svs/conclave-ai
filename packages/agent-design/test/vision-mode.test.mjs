import { test } from "node:test";
import assert from "node:assert/strict";
import { EfficiencyGate } from "@conclave-ai/core";
import { DesignAgent, REVIEW_TOOL_NAME } from "../dist/index.js";

// ---- shared helpers -----------------------------------------------------

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

// ---- Mode A (vision) expanded tests -------------------------------------

test("vision-mode: flags 'logo slop' as a regression-style blocker when model returns it", async () => {
  const client = makeMockClient([
    toolUseResponse({
      verdict: "reject",
      blockers: [
        {
          severity: "blocker",
          category: "brand-regression",
          message:
            "Hero logo reads as AI-generated slop — pixelated radial glow, extra vestigial strokes that aren't in the brand reference.",
          file: "/",
        },
      ],
      summary:
        "The after screenshot's logo is visibly a generated image, not the brand SVG. This is the exact 'AI slop' failure mode.",
    }),
  ]);
  const agent = new DesignAgent({
    apiKey: "test-key",
    gate: new EfficiencyGate({ perPrUsd: 1 }),
    client,
  });
  const r = await agent.review({
    ...baseCtx,
    domain: "design",
    visualArtifacts: [{ route: "/", before: tinyPng, after: tinyPng }],
  });
  assert.equal(r.verdict, "reject");
  assert.equal(r.blockers.length, 1);
  assert.match(r.blockers[0].message, /slop/i);
  assert.equal(r.blockers[0].category, "brand-regression");
});

test("vision-mode: multi-route artifacts send one (before,after) block pair per route", async () => {
  const client = makeMockClient([toolUseResponse({ verdict: "approve", summary: "LGTM" })]);
  const agent = new DesignAgent({
    apiKey: "test-key",
    gate: new EfficiencyGate({ perPrUsd: 1 }),
    client,
  });
  const routes = ["/", "/login", "/dashboard"];
  await agent.review({
    ...baseCtx,
    domain: "design",
    visualArtifacts: routes.map((route) => ({ route, before: tinyPng, after: tinyPng })),
  });
  assert.equal(client.calls.length, 1);
  const content = client.calls[0].messages[0].content;
  const images = content.filter((b) => b.type === "image");
  assert.equal(images.length, 6, "3 routes × 2 (before+after) = 6 image blocks");
  const texts = content.filter((b) => b.type === "text");
  for (const r of routes) {
    assert.ok(texts.some((t) => t.text.includes(`Route: ${r} — BEFORE`)), `before label for ${r}`);
    assert.ok(texts.some((t) => t.text.includes(`Route: ${r} — AFTER`)), `after label for ${r}`);
  }
});

test("vision-mode: viewport-suffixed route label preserved in prompt ('/foo@mobile')", async () => {
  const client = makeMockClient([toolUseResponse({ verdict: "approve", summary: "LGTM" })]);
  const agent = new DesignAgent({
    apiKey: "test-key",
    gate: new EfficiencyGate({ perPrUsd: 1 }),
    client,
  });
  await agent.review({
    ...baseCtx,
    domain: "design",
    visualArtifacts: [
      { route: "/login@desktop", before: tinyPng, after: tinyPng },
      { route: "/login@mobile", before: tinyPng, after: tinyPng },
    ],
  });
  const texts = client.calls[0].messages[0].content.filter((b) => b.type === "text");
  assert.ok(texts.some((t) => t.text.includes("/login@desktop — BEFORE")));
  assert.ok(texts.some((t) => t.text.includes("/login@mobile — AFTER")));
});

test("vision-mode: brand reference images precede PR artifacts in content blocks", async () => {
  const client = makeMockClient([toolUseResponse({ verdict: "approve", summary: "LGTM" })]);
  const agent = new DesignAgent({
    apiKey: "test-key",
    gate: new EfficiencyGate({ perPrUsd: 1 }),
    client,
  });
  await agent.review({
    ...baseCtx,
    domain: "design",
    visualArtifacts: [{ route: "/", before: tinyPng, after: tinyPng }],
    designReferences: [{ filename: "brand-logo.png", bytes: tinyPng }],
  });
  const content = client.calls[0].messages[0].content;
  const brandTextIdx = content.findIndex(
    (b) => b.type === "text" && b.text.includes("Brand reference images"),
  );
  const routeTextIdx = content.findIndex(
    (b) => b.type === "text" && b.text.includes("Route: /"),
  );
  assert.ok(brandTextIdx >= 0, "brand header present");
  assert.ok(routeTextIdx >= 0, "route header present");
  assert.ok(brandTextIdx < routeTextIdx, "brand references come first");
});

test("vision-mode: passes deploy-status=failure context so DesignAgent sees the red-deploy signal", async () => {
  const client = makeMockClient([
    toolUseResponse({
      verdict: "rework",
      blockers: [
        {
          severity: "major",
          category: "deploy-red",
          message: "Deploy is red; not evaluating visuals beyond this.",
        },
      ],
      summary: "Deploy failed — short-circuited.",
    }),
  ]);
  const agent = new DesignAgent({
    apiKey: "test-key",
    gate: new EfficiencyGate({ perPrUsd: 1 }),
    client,
  });
  const r = await agent.review({
    ...baseCtx,
    domain: "design",
    deployStatus: "failure",
    visualArtifacts: [{ route: "/", before: tinyPng, after: tinyPng }],
  });
  const userText = client.calls[0].messages[0].content[0];
  assert.ok(userText.text.includes("deploy: FAILURE"), "deploy-failure wording propagated");
  assert.equal(r.verdict, "rework");
});

// ---- Design system baseline drift (v0.13.22) ---------------------------------

test("vision-mode: designBaselineDrift pairs appear in content blocks before PR artifacts", async () => {
  const client = makeMockClient([toolUseResponse({ verdict: "approve", summary: "LGTM" })]);
  const agent = new DesignAgent({
    apiKey: "test-key",
    gate: new EfficiencyGate({ perPrUsd: 1 }),
    client,
  });
  await agent.review({
    ...baseCtx,
    domain: "design",
    visualArtifacts: [{ route: "/", before: tinyPng, after: tinyPng }],
    designBaselineDrift: [{ route: "/", baseline: tinyPng, after: tinyPng }],
  });
  const content = client.calls[0].messages[0].content;
  const baselineHeaderIdx = content.findIndex(
    (b) => b.type === "text" && b.text.includes("Design system baseline comparison"),
  );
  const prBeforeIdx = content.findIndex(
    (b) => b.type === "text" && b.text.includes("Route: / — BEFORE"),
  );
  assert.ok(baselineHeaderIdx >= 0, "baseline section header present");
  assert.ok(prBeforeIdx >= 0, "PR before label present");
  assert.ok(baselineHeaderIdx < prBeforeIdx, "baseline section appears before PR artifacts");
});

test("vision-mode: baseline pair sends two images (BASELINE + CURRENT) per route", async () => {
  const client = makeMockClient([toolUseResponse({ verdict: "approve", summary: "LGTM" })]);
  const agent = new DesignAgent({
    apiKey: "test-key",
    gate: new EfficiencyGate({ perPrUsd: 1 }),
    client,
  });
  await agent.review({
    ...baseCtx,
    domain: "design",
    visualArtifacts: [{ route: "/", before: tinyPng, after: tinyPng }],
    designBaselineDrift: [
      { route: "/dashboard", baseline: tinyPng, after: tinyPng },
      { route: "/login", baseline: tinyPng, after: tinyPng },
    ],
  });
  const content = client.calls[0].messages[0].content;
  const baselineLabels = content.filter(
    (b) => b.type === "text" && b.text.includes("BASELINE (design system golden"),
  );
  // Use "— CURRENT" (em dash) to match only the per-route labels, not the
  // section header or the user prompt which also contain "CURRENT (after PR".
  const currentLabels = content.filter(
    (b) => b.type === "text" && b.text.includes("— CURRENT (after PR"),
  );
  assert.equal(baselineLabels.length, 2, "one BASELINE label per route");
  assert.equal(currentLabels.length, 2, "one CURRENT label per route");
  // Total images: 2 baseline routes × 2 + 1 PR route × 2 = 6
  const images = content.filter((b) => b.type === "image");
  assert.equal(images.length, 6, "2 baseline pairs × 2 images + 1 PR pair × 2 = 6");
});

test("vision-mode: diffRatio shown in BASELINE label when provided", async () => {
  const client = makeMockClient([toolUseResponse({ verdict: "approve", summary: "LGTM" })]);
  const agent = new DesignAgent({
    apiKey: "test-key",
    gate: new EfficiencyGate({ perPrUsd: 1 }),
    client,
  });
  await agent.review({
    ...baseCtx,
    domain: "design",
    visualArtifacts: [{ route: "/", before: tinyPng, after: tinyPng }],
    designBaselineDrift: [{ route: "/", baseline: tinyPng, after: tinyPng, diffRatio: 0.0523 }],
  });
  const content = client.calls[0].messages[0].content;
  const baselineLabel = content.find(
    (b) => b.type === "text" && b.text.includes("BASELINE") && b.text.includes("pixel diff:"),
  );
  assert.ok(baselineLabel, "pixel diff percentage shown in baseline label");
  assert.ok(baselineLabel.text.includes("5.23%"), "diffRatio formatted correctly");
});

test("vision-mode: no designBaselineDrift → no baseline section in content", async () => {
  const client = makeMockClient([toolUseResponse({ verdict: "approve", summary: "LGTM" })]);
  const agent = new DesignAgent({
    apiKey: "test-key",
    gate: new EfficiencyGate({ perPrUsd: 1 }),
    client,
  });
  await agent.review({
    ...baseCtx,
    domain: "design",
    visualArtifacts: [{ route: "/", before: tinyPng, after: tinyPng }],
  });
  const content = client.calls[0].messages[0].content;
  const baselineHeader = content.find(
    (b) => b.type === "text" && b.text.includes("Design system baseline comparison"),
  );
  assert.equal(baselineHeader, undefined, "no baseline section when no drift provided");
});

test("vision-mode: designBaselineDrift route mentioned in user prompt header", async () => {
  const client = makeMockClient([toolUseResponse({ verdict: "approve", summary: "LGTM" })]);
  const agent = new DesignAgent({
    apiKey: "test-key",
    gate: new EfficiencyGate({ perPrUsd: 1 }),
    client,
  });
  await agent.review({
    ...baseCtx,
    domain: "design",
    visualArtifacts: [{ route: "/", before: tinyPng, after: tinyPng }],
    designBaselineDrift: [{ route: "/dashboard", baseline: tinyPng, after: tinyPng }],
  });
  const userText = client.calls[0].messages[0].content[0];
  assert.ok(
    userText.text.includes("design-system-baseline"),
    "baseline section appears in user prompt",
  );
  assert.ok(userText.text.includes("/dashboard"), "drift route named in prompt");
});

test("vision-mode: blockers with file set to route can be autofixed by worker", async () => {
  const client = makeMockClient([
    toolUseResponse({
      verdict: "rework",
      blockers: [
        {
          severity: "major",
          category: "color-token-drift",
          message:
            "Primary button color drifted from design system baseline — current #3B82F6 vs baseline #2563EB.",
          file: "/dashboard",
        },
      ],
      summary: "Color token drift detected on /dashboard relative to design system baseline.",
    }),
  ]);
  const agent = new DesignAgent({
    apiKey: "test-key",
    gate: new EfficiencyGate({ perPrUsd: 1 }),
    client,
  });
  const r = await agent.review({
    ...baseCtx,
    domain: "design",
    visualArtifacts: [{ route: "/dashboard", before: tinyPng, after: tinyPng }],
    designBaselineDrift: [{ route: "/dashboard", baseline: tinyPng, after: tinyPng, diffRatio: 0.03 }],
  });
  assert.equal(r.verdict, "rework");
  assert.equal(r.blockers.length, 1);
  assert.equal(r.blockers[0].category, "color-token-drift");
  assert.equal(r.blockers[0].file, "/dashboard", "file set enables worker autofix");
});
