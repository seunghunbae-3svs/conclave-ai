import { test } from "node:test";
import assert from "node:assert/strict";
import { EfficiencyGate } from "@conclave-ai/core";
import { ClaudeWorker, looksLikeUnifiedDiff, parsePatchToolUse, WORKER_SYSTEM_PROMPT } from "../dist/index.js";

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

const VALID_PATCH = `diff --git a/src/x.ts b/src/x.ts
index 1234567..89abcde 100644
--- a/src/x.ts
+++ b/src/x.ts
@@ -1,3 +1,3 @@
-export const x = 1;
+export const x: number = 1;
 export const y = 2;
 export const z = 3;
`;

function patchResponse({
  patch = VALID_PATCH,
  commitMessage = "fix(x): annotate x as number",
  filesTouched = ["src/x.ts"],
  summary = "Addresses type-error blocker from Claude.",
  inputTokens = 2_000,
  outputTokens = 400,
  cacheRead = 0,
} = {}) {
  return {
    id: "msg_test",
    model: "claude-sonnet-4-6",
    content: [
      {
        type: "tool_use",
        id: "tool_1",
        name: "submit_patch",
        input: { patch, commitMessage, filesTouched, summary },
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

const reviewCtx = {
  repo: "acme/x",
  pullNumber: 1,
  newSha: "abc123",
  reviews: [
    {
      agent: "claude",
      verdict: "rework",
      summary: "ts type missing",
      blockers: [
        { severity: "blocker", category: "type-error", message: "add explicit type annotation", file: "src/x.ts", line: 1 },
      ],
    },
  ],
  fileSnapshots: [
    { path: "src/x.ts", contents: "export const x = 1;\nexport const y = 2;\nexport const z = 3;\n" },
  ],
};

test("ClaudeWorker: returns a WorkerOutcome with patch, message, and appliedFiles", async () => {
  const gate = new EfficiencyGate({ perPrUsd: 1 });
  const client = makeMockClient([patchResponse()]);
  const worker = new ClaudeWorker({ apiKey: "test-key", gate, client });
  const outcome = await worker.work(reviewCtx);
  assert.equal(outcome.patch, VALID_PATCH);
  assert.equal(outcome.message, "fix(x): annotate x as number");
  assert.deepEqual(outcome.appliedFiles, ["src/x.ts"]);
  assert.ok(typeof outcome.costUsd === "number" && outcome.costUsd > 0);
  assert.ok(typeof outcome.tokensUsed === "number" && outcome.tokensUsed === 2_400);
});

test("ClaudeWorker: preserves empty-patch signal when worker gives up", async () => {
  const gate = new EfficiencyGate({ perPrUsd: 1 });
  const client = makeMockClient([
    patchResponse({ patch: "", filesTouched: [], summary: "Need the contents of src/other.ts to proceed." }),
  ]);
  const worker = new ClaudeWorker({ apiKey: "k", gate, client });
  const outcome = await worker.work(reviewCtx);
  assert.equal(outcome.patch, "");
  assert.deepEqual(outcome.appliedFiles, []);
});

test("ClaudeWorker: trims whitespace from filesTouched entries and drops empties", async () => {
  const gate = new EfficiencyGate({ perPrUsd: 1 });
  const client = makeMockClient([
    patchResponse({ filesTouched: ["  src/x.ts  ", "", "src/y.ts"] }),
  ]);
  const worker = new ClaudeWorker({ apiKey: "k", gate, client });
  const outcome = await worker.work(reviewCtx);
  assert.deepEqual(outcome.appliedFiles, ["src/x.ts", "src/y.ts"]);
});

test("ClaudeWorker: throws when response has no submit_patch tool_use block", async () => {
  const client = {
    calls: [],
    messages: {
      create: async () => ({
        id: "msg",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "here is a patch in prose" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 10 },
      }),
    },
  };
  const worker = new ClaudeWorker({ apiKey: "k", client, gate: new EfficiencyGate({ perPrUsd: 1 }) });
  await assert.rejects(() => worker.work(reviewCtx), /did not include a submit_patch tool_use/);
});

test("ClaudeWorker: throws when patch does not look like a unified diff", async () => {
  const client = makeMockClient([
    patchResponse({ patch: "just some code, not a diff\nconst x = 1;\n" }),
  ]);
  const worker = new ClaudeWorker({ apiKey: "k", client, gate: new EfficiencyGate({ perPrUsd: 1 }) });
  await assert.rejects(() => worker.work(reviewCtx), /does not look like a unified diff/);
});

test("ClaudeWorker: throws when commitMessage is empty", async () => {
  const client = makeMockClient([patchResponse({ commitMessage: "   " })]);
  const worker = new ClaudeWorker({ apiKey: "k", client, gate: new EfficiencyGate({ perPrUsd: 1 }) });
  await assert.rejects(() => worker.work(reviewCtx), /commitMessage must be a non-empty string/);
});

test("ClaudeWorker: throws when filesTouched is not an array of strings", async () => {
  const client = makeMockClient([patchResponse({ filesTouched: [42, "src/x.ts"] })]);
  const worker = new ClaudeWorker({ apiKey: "k", client, gate: new EfficiencyGate({ perPrUsd: 1 }) });
  await assert.rejects(() => worker.work(reviewCtx), /filesTouched must be an array of strings/);
});

test("ClaudeWorker: sends system prompt with cache_control ephemeral", async () => {
  const gate = new EfficiencyGate({ perPrUsd: 1 });
  const client = makeMockClient([patchResponse()]);
  const worker = new ClaudeWorker({ apiKey: "k", gate, client });
  await worker.work(reviewCtx);
  const params = client.calls[0];
  assert.ok(Array.isArray(params.system), "system should be an array of blocks for cache control");
  assert.equal(params.system[0].cache_control?.type, "ephemeral");
});

test("ClaudeWorker: forces submit_patch tool via tool_choice", async () => {
  const gate = new EfficiencyGate({ perPrUsd: 1 });
  const client = makeMockClient([patchResponse()]);
  const worker = new ClaudeWorker({ apiKey: "k", gate, client });
  await worker.work(reviewCtx);
  const params = client.calls[0];
  assert.equal(params.tool_choice.type, "tool");
  assert.equal(params.tool_choice.name, "submit_patch");
});

test("ClaudeWorker: records a metric on the shared gate", async () => {
  const gate = new EfficiencyGate({ perPrUsd: 1 });
  const client = makeMockClient([patchResponse({ inputTokens: 5_000, outputTokens: 800 })]);
  const worker = new ClaudeWorker({ apiKey: "k", gate, client });
  await worker.work(reviewCtx);
  const summary = gate.metrics.summary();
  assert.equal(summary.callCount, 1);
  assert.equal(summary.byAgent["worker"].calls, 1);
  assert.ok(summary.totalCostUsd > 0);
});

test("ClaudeWorker: respects a shared budget cap", async () => {
  const gate = new EfficiencyGate({ perPrUsd: 0.005 });
  const client = makeMockClient([patchResponse({ inputTokens: 10_000, outputTokens: 1_000 })]);
  const worker = new ClaudeWorker({ apiKey: "k", gate, client });
  await assert.rejects(() => worker.work(reviewCtx), /budget/);
});

test("ClaudeWorker: missing API key AND no injected client throws in constructor", () => {
  const orig = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    assert.throws(() => new ClaudeWorker());
  } finally {
    if (orig !== undefined) process.env.ANTHROPIC_API_KEY = orig;
  }
});

test("ClaudeWorker: prompt includes blocker text and file snapshot contents", async () => {
  const gate = new EfficiencyGate({ perPrUsd: 1 });
  const client = makeMockClient([patchResponse()]);
  const worker = new ClaudeWorker({ apiKey: "k", gate, client });
  await worker.work(reviewCtx);
  const prompt = client.calls[0].messages[0].content;
  assert.ok(prompt.includes("add explicit type annotation"), "prompt should include blocker text");
  assert.ok(prompt.includes("export const x = 1;"), "prompt should include file snapshot contents");
  assert.ok(prompt.includes("src/x.ts"), "prompt should include file path");
  assert.ok(prompt.includes("abc123"), "prompt should include the head sha");
});

test("looksLikeUnifiedDiff: accepts common diff header forms", () => {
  assert.equal(looksLikeUnifiedDiff("diff --git a/x b/x\n"), true);
  assert.equal(looksLikeUnifiedDiff("--- a/x\n+++ b/x\n"), true);
  assert.equal(looksLikeUnifiedDiff("Index: src/x.ts\n"), true);
  assert.equal(looksLikeUnifiedDiff("\n\ndiff --git a/x b/x\n"), true);
});

test("looksLikeUnifiedDiff: rejects prose and code snippets", () => {
  assert.equal(looksLikeUnifiedDiff("const x = 1;\n"), false);
  assert.equal(looksLikeUnifiedDiff("Here's the fix: ...\n"), false);
  assert.equal(looksLikeUnifiedDiff(""), false);
});

test("parsePatchToolUse: direct parser happy path (no LLM)", () => {
  const response = {
    id: "m",
    model: "claude-sonnet-4-6",
    content: [
      {
        type: "tool_use",
        id: "t",
        name: "submit_patch",
        input: {
          patch: VALID_PATCH,
          commitMessage: "fix: something",
          filesTouched: ["src/x.ts"],
          summary: "ok",
        },
      },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  const parsed = parsePatchToolUse(response);
  assert.equal(parsed.patch, VALID_PATCH);
  assert.equal(parsed.message, "fix: something");
  assert.deepEqual(parsed.appliedFiles, ["src/x.ts"]);
});

// v0.13.9 — guard against regression of leading-context guidance in
// the worker system prompt. eventbadge#29 sha 279cb22 produced a
// patch with only one line of leading context (`export function ...`)
// that BOTH `git apply --recount` and `patch -p1 --fuzz=3` rejected.
// The prompt now requires 2-3 lines of leading + trailing context;
// these snapshot assertions lock that guidance in.
test("WORKER_SYSTEM_PROMPT: requires 2-3 lines of leading context", () => {
  const p = WORKER_SYSTEM_PROMPT;
  assert.match(p, /leading context/i, "prompt must mention 'leading context'");
  assert.match(p, /2-3 lines/i, "prompt must specify the 2-3 lines requirement");
  assert.match(p, /starting line/i, "prompt must call out that the @@ start line A is verified");
});

test("WORKER_SYSTEM_PROMPT: starting-line guidance overrides the old 'do not need to be exact' wording", () => {
  const p = WORKER_SYSTEM_PROMPT;
  // Pre-v0.13.9 the prompt told the worker @@ headers "DO NOT need
  // to be exact". That literal wording masked the off-by-one failure
  // mode; assert it's gone.
  assert.doesNotMatch(p, /DO NOT need to be exact/, "old (overly permissive) wording must be removed");
});
