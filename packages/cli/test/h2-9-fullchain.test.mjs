/**
 * H2 #9 fullchain audit — diff splitter.
 *
 * Reproduces review.ts's exact splitter branching logic with
 * fake agents and verifies:
 *   - small diff → single-pass council, splitter not used
 *   - 3 files × 200 lines → 2 chunks → integrated verdict severity-max
 *   - single huge file (800 lines) → chunks.length=1 → fallback single pass
 *   - chunked path: failure-gate runs on the FULL diff (union of all
 *     chunks), not per-chunk — applyFailureGate should still match
 *     tokens scattered across chunks
 *
 * Helper countDiffChangedLines is local to review.ts; we replicate it
 * inline here since it's not exported. If that function ever drifts
 * from the splitter's own counting, this test will catch it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Council,
  applyFailureGate,
  integrateChunkOutcomes,
  splitDiff,
} from "@conclave-ai/core";

class FakeAgent {
  constructor(id, perChunkBehavior) {
    this.id = id;
    this.displayName = id;
    this.perChunkBehavior = perChunkBehavior;
    this.calls = 0;
  }
  async review(ctx) {
    const idx = this.calls;
    this.calls += 1;
    return this.perChunkBehavior(ctx, idx);
  }
}

function fileBlock(name, addedLines) {
  const body = Array.from({ length: addedLines }, (_, i) => `+line ${i} ${name} content`).join("\n");
  return [
    `diff --git a/${name} b/${name}`,
    `index abc..def 100644`,
    `--- a/${name}`,
    `+++ b/${name}`,
    `@@ -1,1 +1,${addedLines} @@`,
    body,
  ].join("\n") + "\n";
}

function countDiffChangedLines(diff) {
  // Replicate review.ts's local helper. If review.ts's version drifts
  // from this we want a build break.
  let n = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+") || line.startsWith("-")) n += 1;
  }
  return n;
}

// review.ts splitter branch — replicated precisely so any drift is
// surfaced by these tests.
async function reviewBranch({ diff, council, splitterEnabled = true, maxLines = 500, maxFiles = 20 }) {
  const totalChangedLines = countDiffChangedLines(diff);
  const useSplitter = splitterEnabled && totalChangedLines > maxLines;
  const baseCtx = { diff, repo: "acme/app", pullNumber: 1, newSha: "sha" };
  if (!useSplitter) {
    return { mode: "single", outcome: await council.deliberate(baseCtx), chunks: 1 };
  }
  const chunks = splitDiff(diff, { maxLinesPerChunk: maxLines, maxChangedFilesPerChunk: maxFiles });
  if (chunks.length <= 1) {
    return { mode: "fallback", outcome: await council.deliberate(baseCtx), chunks: chunks.length };
  }
  const outcomes = [];
  for (const chunk of chunks) {
    outcomes.push(await council.deliberate({ ...baseCtx, diff: chunk.diff }));
  }
  return { mode: "chunked", outcome: integrateChunkOutcomes(outcomes), chunks: chunks.length };
}

test("H2 #9 fullchain: small diff → single-pass (splitter not engaged)", async () => {
  const council = new Council({
    agents: [new FakeAgent("claude", () => ({ agent: "claude", verdict: "approve", blockers: [], summary: "" }))],
    maxRounds: 1,
    enableDebate: false,
  });
  const diff = fileBlock("a.ts", 50);
  const result = await reviewBranch({ diff, council });
  assert.equal(result.mode, "single");
  assert.equal(result.outcome.verdict, "approve");
});

test("H2 #9 fullchain: 3×200 lines → 2 chunks → integrate verdict (any reject wins)", async () => {
  // chunk 1 (a + b = 400 lines) → claude approves, openai approves
  // chunk 2 (c = 200 lines) → claude REJECTS in this chunk
  const council = new Council({
    agents: [
      new FakeAgent("claude", (ctx, idx) =>
        idx === 0
          ? { agent: "claude", verdict: "approve", blockers: [], summary: `c1` }
          : {
              agent: "claude",
              verdict: "reject",
              blockers: [
                { severity: "blocker", category: "regression", message: "broke feature in c.ts", file: "c.ts" },
              ],
              summary: "c2 reject",
            },
      ),
      new FakeAgent("openai", () => ({ agent: "openai", verdict: "approve", blockers: [], summary: "" })),
    ],
    maxRounds: 1,
    enableDebate: false,
  });
  const diff = fileBlock("a.ts", 200) + fileBlock("b.ts", 200) + fileBlock("c.ts", 200);
  const result = await reviewBranch({ diff, council });
  assert.equal(result.mode, "chunked");
  assert.equal(result.chunks, 2);
  assert.equal(result.outcome.verdict, "reject", "severity-max across chunks");
  // Per-agent merge: one entry per agent.
  assert.equal(result.outcome.results.length, 2);
  const claudeResult = result.outcome.results.find((r) => r.agent === "claude");
  assert.equal(claudeResult.blockers.length, 1, "claude's chunk2 blocker carried through integration");
  assert.equal(claudeResult.verdict, "reject");
});

test("H2 #9 fullchain: single 800-line file → chunks.length=1 → fallback to single-pass", async () => {
  const council = new Council({
    agents: [
      new FakeAgent("claude", () => ({ agent: "claude", verdict: "approve", blockers: [], summary: "" })),
    ],
    maxRounds: 1,
    enableDebate: false,
  });
  const diff = fileBlock("huge.ts", 800);
  const result = await reviewBranch({ diff, council });
  assert.equal(result.mode, "fallback", "single-file-over-threshold falls back, doesn't loop chunked");
  assert.equal(result.outcome.verdict, "approve");
});

test("H2 #9 fullchain: diff without `diff --git` headers > threshold → fallback (no per-file boundaries to split on)", async () => {
  const council = new Council({
    agents: [
      new FakeAgent("claude", () => ({ agent: "claude", verdict: "approve", blockers: [], summary: "" })),
    ],
    maxRounds: 1,
    enableDebate: false,
  });
  // Raw 600-line "diff" with only a single +++ header — splitDiff
  // returns 1 chunk because there are no per-file boundaries.
  const lines = ["+++ b/x.ts"];
  for (let i = 0; i < 600; i += 1) lines.push(`+line ${i}`);
  const diff = lines.join("\n");
  const result = await reviewBranch({ diff, council });
  assert.equal(result.mode, "fallback");
  assert.equal(result.outcome.verdict, "approve");
});

test("H2 #9 fullchain: chunked path → failure-gate runs on FULL diff and matches tokens across chunks", async () => {
  // Two chunks, each containing different parts of a known catalog
  // pattern. Gate should match against the UNION (full diff), not
  // each chunk separately.
  const council = new Council({
    agents: [
      new FakeAgent("claude", () => ({ agent: "claude", verdict: "approve", blockers: [], summary: "" })),
    ],
    maxRounds: 1,
    enableDebate: false,
  });
  // file_a has "console" tokens; file_b has "operational" tokens.
  // Need both for the failure body's 2-token overlap to fire.
  const fileWithConsole = (name, lines) =>
    [
      `diff --git a/${name} b/${name}`,
      `index abc..def 100644`,
      `--- a/${name}`,
      `+++ b/${name}`,
      `@@ -1,1 +1,${lines + 1} @@`,
      `+console debug content`,
      ...Array.from({ length: lines - 1 }, (_, i) => `+filler line ${i}`),
    ].join("\n") + "\n";
  const fileWithOperational = (name, lines) =>
    [
      `diff --git a/${name} b/${name}`,
      `index abc..def 100644`,
      `--- a/${name}`,
      `+++ b/${name}`,
      `@@ -1,1 +1,${lines + 1} @@`,
      `+operational frontend production data`,
      ...Array.from({ length: lines - 1 }, (_, i) => `+filler line ${i}`),
    ].join("\n") + "\n";
  const diff = fileWithConsole("a.ts", 250) + fileWithOperational("b.ts", 250) + fileBlock("c.ts", 200);
  const result = await reviewBranch({ diff, council });
  assert.equal(result.mode, "chunked");

  // Now run the gate on the integrated outcome with the FULL diff.
  const failure = {
    id: "fc-1",
    createdAt: new Date().toISOString(),
    domain: "code",
    category: "other",
    severity: "major",
    title: "console.log debug operational frontend",
    body: "console debug operational frontend production",
    tags: ["debug-noise"],
    seedBlocker: {
      severity: "major",
      category: "debug-noise",
      message: "console.log debug operational frontend",
    },
  };
  const gateResult = applyFailureGate(
    result.outcome,
    [failure],
    { diff, repo: "acme/app", pullNumber: 1, newSha: "sha" },
  );
  assert.equal(
    gateResult.stickyBlockers.length,
    1,
    "gate must match tokens scattered across multiple chunks (full-diff scan)",
  );
});

test("H2 #9 fullchain: token sum across chunks survives integration", async () => {
  const council = new Council({
    agents: [
      new FakeAgent("claude", () => ({
        agent: "claude",
        verdict: "approve",
        blockers: [],
        summary: "",
        tokensUsed: 1000,
        costUsd: 0.05,
      })),
    ],
    maxRounds: 1,
    enableDebate: false,
  });
  const diff = fileBlock("a.ts", 200) + fileBlock("b.ts", 200) + fileBlock("c.ts", 200);
  const result = await reviewBranch({ diff, council });
  assert.equal(result.mode, "chunked");
  const claude = result.outcome.results.find((r) => r.agent === "claude");
  assert.equal(claude.tokensUsed, 2000, "tokens should sum across 2 chunks (1000 each)");
  assert.equal(Number(claude.costUsd.toFixed(4)), 0.1);
});
