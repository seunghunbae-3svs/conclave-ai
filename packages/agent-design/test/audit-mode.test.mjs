import { test } from "node:test";
import assert from "node:assert/strict";
import { EfficiencyGate } from "@conclave-ai/core";
import {
  DesignAgent,
  REVIEW_TOOL_NAME,
  AUDIT_SYSTEM_PROMPT,
  buildAuditPrompt,
} from "../dist/index.js";

// ─── helpers ──────────────────────────────────────────────────────────

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
  summary = "audit clean",
  inputTokens = 1_500,
  outputTokens = 200,
} = {}) {
  return {
    id: "msg_audit",
    model: "claude-opus-4-7",
    content: [
      {
        type: "tool_use",
        id: "tool_audit_1",
        name: REVIEW_TOOL_NAME,
        input: { verdict, blockers, summary },
      },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

const baseAuditCtx = {
  repo: "acme/x",
  pullNumber: 0,
  newSha: "head-sha-1",
  mode: "audit",
};

// ─── Mode D (audit) — happy path ──────────────────────────────────────

test("Mode D (audit): UI files in batch → audit prompt + verdict from tool_use", async () => {
  const client = makeMockClient([
    toolUseResponse({
      verdict: "rework",
      blockers: [
        {
          severity: "blocker",
          category: "a11y",
          message: "src/ui/Hero.tsx: <img src={logo} /> missing alt",
          file: "src/ui/Hero.tsx",
        },
      ],
      summary: "audit found one a11y blocker",
    }),
  ]);

  const agent = new DesignAgent({ client, gate: new EfficiencyGate() });

  const result = await agent.review({
    ...baseAuditCtx,
    diff: [
      "// === src/ui/Hero.tsx ===",
      "export function Hero() { return <img src={logo} />; }",
      "// === src/lib/calc.ts ===",
      "export const add = (a, b) => a + b;",
    ].join("\n"),
    auditFiles: ["src/ui/Hero.tsx", "src/lib/calc.ts"],
  });

  assert.equal(result.verdict, "rework");
  assert.equal(result.blockers.length, 1);
  assert.equal(result.blockers[0].category, "a11y");
  assert.equal(result.agent, "design");

  // One API call dispatched.
  assert.equal(client.calls.length, 1);
  // System prompt is the AUDIT prompt, not the review/text-UI prompt.
  const sys = client.calls[0].system;
  const sysText = Array.isArray(sys) ? sys[0].text : sys;
  assert.equal(sysText, AUDIT_SYSTEM_PROMPT);
  // tool_choice forces submit_review.
  assert.deepEqual(client.calls[0].tool_choice, { type: "tool", name: REVIEW_TOOL_NAME });
});

test("Mode D (audit): only UI files passed to prompt; non-UI auditFiles are filtered out", async () => {
  const client = makeMockClient([toolUseResponse()]);
  const agent = new DesignAgent({ client, gate: new EfficiencyGate() });

  await agent.review({
    ...baseAuditCtx,
    diff: "(file contents pretend-bundle)",
    auditFiles: ["src/ui/Button.tsx", "src/lib/db.ts", "server/api.ts", "styles/app.css"],
  });

  const userBlock = client.calls[0].messages[0].content[0];
  assert.equal(userBlock.type, "text");
  // The prompt's "ui files in this batch" line should list only the UI subset.
  assert.match(userBlock.text, /ui files in this batch \(2\): src\/ui\/Button\.tsx, styles\/app\.css/);
  // Non-UI files should NOT appear in that header line.
  assert.doesNotMatch(userBlock.text, /ui files in this batch.*src\/lib\/db\.ts/);
});

// ─── Mode D (audit) — graceful skip ───────────────────────────────────

test("Mode D (audit): no UI files in batch → graceful approve, NO API call", async () => {
  const client = makeMockClient([toolUseResponse({ verdict: "rework" })]);
  const agent = new DesignAgent({ client, gate: new EfficiencyGate() });

  const result = await agent.review({
    ...baseAuditCtx,
    diff: "(server-only batch)",
    auditFiles: ["src/lib/db.ts", "server/api.ts", "scripts/migrate.ts"],
  });

  assert.equal(result.verdict, "approve");
  assert.equal(result.blockers.length, 0);
  assert.match(result.summary, /skipped/i);
  assert.match(result.summary, /no UI-relevant files/i);
  // Confirm the API was NOT called when the batch is logic-only.
  assert.equal(client.calls.length, 0);
});

test("Mode D (audit): missing auditFiles array → graceful approve (defensive default)", async () => {
  const client = makeMockClient([toolUseResponse()]);
  const agent = new DesignAgent({ client, gate: new EfficiencyGate() });

  const result = await agent.review({
    ...baseAuditCtx,
    diff: "(no audit files)",
  });

  assert.equal(result.verdict, "approve");
  assert.match(result.summary, /skipped/i);
  assert.equal(client.calls.length, 0);
});

// ─── Mode D (audit) — verdict / response handling ─────────────────────

test("Mode D (audit): malformed tool_use response → error-shaped rework (no throw)", async () => {
  const client = makeMockClient([
    {
      id: "msg_bad",
      model: "claude-opus-4-7",
      content: [{ type: "text", text: "I refuse to call the tool" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 50 },
    },
  ]);
  const agent = new DesignAgent({ client, gate: new EfficiencyGate() });

  const result = await agent.review({
    ...baseAuditCtx,
    diff: "(ui file batch)",
    auditFiles: ["src/ui/Button.tsx"],
  });

  assert.equal(result.verdict, "rework");
  assert.equal(result.blockers.length, 1);
  assert.equal(result.blockers[0].category, "agent-error");
});

test("Mode D (audit): invalid verdict in tool_use → error-shaped rework", async () => {
  const client = makeMockClient([
    {
      id: "msg_bad",
      model: "claude-opus-4-7",
      content: [
        {
          type: "tool_use",
          id: "tool_x",
          name: REVIEW_TOOL_NAME,
          input: { verdict: "lgtm", blockers: [], summary: "" },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 100, output_tokens: 50 },
    },
  ]);
  const agent = new DesignAgent({ client, gate: new EfficiencyGate() });

  const result = await agent.review({
    ...baseAuditCtx,
    diff: "(ui file batch)",
    auditFiles: ["src/ui/Button.tsx"],
  });

  assert.equal(result.verdict, "rework");
  assert.equal(result.blockers[0].category, "agent-error");
  assert.match(result.blockers[0].message, /invalid verdict/i);
});

// ─── Mode D (audit) — context plumbing ────────────────────────────────

test("Mode D (audit): projectContext + designContext flow into the audit prompt", async () => {
  const client = makeMockClient([toolUseResponse()]);
  const agent = new DesignAgent({ client, gate: new EfficiencyGate() });

  await agent.review({
    ...baseAuditCtx,
    diff: "(ui file batch)",
    auditFiles: ["src/ui/Button.tsx"],
    projectContext: "Pet-loss subscription product. Empathy is the brand.",
    designContext: "Soft palette; Pretendard 16px body; tokens in src/theme/tokens.ts.",
  });

  const userText = client.calls[0].messages[0].content[0].text;
  assert.match(userText, /# Project context/);
  assert.match(userText, /Pet-loss subscription/);
  assert.match(userText, /# Design intent/);
  assert.match(userText, /Pretendard/);
});

test("Mode D (audit): priors from previous round are quoted in the prompt", async () => {
  const client = makeMockClient([toolUseResponse()]);
  const agent = new DesignAgent({ client, gate: new EfficiencyGate() });

  await agent.review({
    ...baseAuditCtx,
    diff: "(ui file batch)",
    auditFiles: ["src/ui/Button.tsx"],
    round: 2,
    priors: [
      {
        agent: "claude",
        verdict: "rework",
        blockers: [
          { severity: "major", category: "logic", message: "off-by-one in handleClick" },
        ],
        summary: "one logic bug",
      },
    ],
  });

  const userText = client.calls[0].messages[0].content[0].text;
  assert.match(userText, /Round 2 — other agents'? audit findings/);
  assert.match(userText, /## claude: rework/);
  assert.match(userText, /\[major\/logic\] off-by-one/);
});

// ─── Mode D vs other modes — dispatch precedence ──────────────────────

test("audit mode wins over Mode A (vision) when mode='audit' even if visualArtifacts present", async () => {
  const client = makeMockClient([toolUseResponse({ summary: "audit ran, not vision" })]);
  const agent = new DesignAgent({ client, gate: new EfficiencyGate() });

  const tinyPng = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

  await agent.review({
    ...baseAuditCtx,
    diff: "(ui file batch)",
    auditFiles: ["src/ui/Button.tsx"],
    visualArtifacts: [{ before: tinyPng, after: tinyPng, route: "/" }],
  });

  // Only one call, and it must be the AUDIT system prompt — not the
  // vision SYSTEM_PROMPT — and its content must NOT contain image blocks.
  assert.equal(client.calls.length, 1);
  const sysText = Array.isArray(client.calls[0].system)
    ? client.calls[0].system[0].text
    : client.calls[0].system;
  assert.equal(sysText, AUDIT_SYSTEM_PROMPT);
  const content = client.calls[0].messages[0].content;
  // Audit dispatch sends a 2-element text-only content array.
  assert.ok(Array.isArray(content));
  assert.ok(content.every((b) => b.type === "text"));
});

// ─── buildAuditPrompt — unit coverage ─────────────────────────────────

test("buildAuditPrompt: includes repo + sha + ui files header + code fence", () => {
  const prompt = buildAuditPrompt(
    {
      repo: "acme/x",
      pullNumber: 0,
      newSha: "deadbeef",
      mode: "audit",
      diff: "irrelevant for unit",
    },
    "// === src/ui/Hero.tsx ===\nexport const x = 1;",
    ["src/ui/Hero.tsx"],
  );

  assert.match(prompt, /repo: acme\/x/);
  assert.match(prompt, /sha:\s+deadbeef/);
  assert.match(prompt, /ui files in this batch \(1\): src\/ui\/Hero\.tsx/);
  // Code fence wraps file contents
  assert.match(prompt, /```[\s\S]*export const x = 1;[\s\S]*```/);
  assert.match(prompt, /Audit the UI files above through the design lens/);
});

test("buildAuditPrompt: empty UI file list → '(empty batch)' placeholder, no priors section", () => {
  const prompt = buildAuditPrompt(
    {
      repo: "acme/x",
      pullNumber: 0,
      newSha: "abc",
      mode: "audit",
      diff: "",
    },
    "",
    [],
  );

  assert.match(prompt, /\(empty batch\)/);
  // No priors block when none provided.
  assert.doesNotMatch(prompt, /Round \d+ — other agents/);
});
