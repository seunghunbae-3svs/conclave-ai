import { test } from "node:test";
import assert from "node:assert/strict";
import { splitDiff, integrateChunkOutcomes } from "../dist/index.js";

function fileBlock(name, addedLines, removedLines = 0) {
  const adds = Array.from({ length: addedLines }, (_, i) => `+added line ${i}`).join("\n");
  const dels = Array.from({ length: removedLines }, (_, i) => `-removed line ${i}`).join("\n");
  return [
    `diff --git a/${name} b/${name}`,
    `index abc..def 100644`,
    `--- a/${name}`,
    `+++ b/${name}`,
    `@@ -1,${removedLines || 1} +1,${addedLines || 1} @@`,
    adds,
    dels,
  ]
    .filter((s) => s.length > 0)
    .join("\n") + "\n";
}

test("splitDiff: empty input → []", () => {
  assert.deepEqual(splitDiff(""), []);
  assert.deepEqual(splitDiff("   \n  "), []);
});

test("splitDiff: no diff --git headers → single chunk", () => {
  const raw = "+++ b/x.ts\n@@ -1,2 +1,2 @@\n+added\n-removed\n";
  const chunks = splitDiff(raw);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].diff, raw);
});

test("splitDiff: small diff under threshold → single chunk", () => {
  const diff = fileBlock("a.ts", 10) + fileBlock("b.ts", 20);
  const chunks = splitDiff(diff, { maxLinesPerChunk: 500 });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].files.length, 2);
  assert.deepEqual(chunks[0].files.sort(), ["a.ts", "b.ts"]);
  assert.equal(chunks[0].changedLines, 30);
});

test("splitDiff: bin-packs into chunks at the line threshold", () => {
  // 3 files of 200 lines each. Threshold 500 → first chunk (200+200=400) + second chunk (200).
  const diff = fileBlock("a.ts", 200) + fileBlock("b.ts", 200) + fileBlock("c.ts", 200);
  const chunks = splitDiff(diff, { maxLinesPerChunk: 500 });
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].files.length, 2); // a + b
  assert.equal(chunks[1].files.length, 1); // c
  // Total lines preserved.
  const total = chunks.reduce((acc, c) => acc + c.changedLines, 0);
  assert.equal(total, 600);
});

test("splitDiff: file larger than threshold gets its own chunk (no splitting mid-file)", () => {
  const big = fileBlock("huge.ts", 800); // > 500
  const small = fileBlock("small.ts", 100);
  const chunks = splitDiff(big + small, { maxLinesPerChunk: 500 });
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].files[0], "huge.ts");
  assert.equal(chunks[0].changedLines, 800);
  assert.equal(chunks[1].files[0], "small.ts");
});

test("splitDiff: maxChangedFilesPerChunk caps file count even when lines fit", () => {
  // 5 files, 10 lines each = 50 total, well under 500 line threshold.
  // But maxFilesPerChunk=2 forces chunking.
  let diff = "";
  for (let i = 0; i < 5; i += 1) diff += fileBlock(`f${i}.ts`, 10);
  const chunks = splitDiff(diff, { maxLinesPerChunk: 500, maxChangedFilesPerChunk: 2 });
  assert.equal(chunks.length, 3); // 2 + 2 + 1
  assert.deepEqual(
    chunks.map((c) => c.files.length),
    [2, 2, 1],
  );
});

test("splitDiff: each chunk's diff is self-contained (re-parsing yields same files)", () => {
  const diff = fileBlock("a.ts", 200) + fileBlock("b.ts", 200) + fileBlock("c.ts", 200);
  const chunks = splitDiff(diff, { maxLinesPerChunk: 500 });
  for (const chunk of chunks) {
    const reparsed = splitDiff(chunk.diff, { maxLinesPerChunk: 10_000 });
    assert.equal(reparsed.length, 1);
    assert.deepEqual(reparsed[0].files.sort(), [...chunk.files].sort());
  }
});

// integrateChunkOutcomes ----------------------------------------------------

function mkOutcome(verdict, results) {
  return {
    verdict,
    rounds: 1,
    results,
    consensusReached: true,
  };
}

test("integrateChunkOutcomes: empty list throws actionable error", () => {
  assert.throws(() => integrateChunkOutcomes([]), /non-empty/);
});

test("integrateChunkOutcomes: single outcome returned as-is", () => {
  const o = mkOutcome("approve", [
    { agent: "claude", verdict: "approve", blockers: [], summary: "LGTM" },
  ]);
  assert.equal(integrateChunkOutcomes([o]), o);
});

test("integrateChunkOutcomes: verdict is severity-max across chunks", () => {
  const a = mkOutcome("approve", [{ agent: "claude", verdict: "approve", blockers: [], summary: "" }]);
  const b = mkOutcome("rework", [{ agent: "claude", verdict: "rework", blockers: [], summary: "" }]);
  const c = mkOutcome("reject", [{ agent: "claude", verdict: "reject", blockers: [], summary: "" }]);
  assert.equal(integrateChunkOutcomes([a, b]).verdict, "rework");
  assert.equal(integrateChunkOutcomes([a, c]).verdict, "reject");
  assert.equal(integrateChunkOutcomes([b, c]).verdict, "reject");
  assert.equal(integrateChunkOutcomes([a, a]).verdict, "approve");
});

test("integrateChunkOutcomes: per-agent merge concatenates blockers + dedupes", () => {
  const blockerA = { severity: "major", category: "type-error", message: "ts2345 mismatch", file: "a.ts", line: 10 };
  const blockerB = { severity: "major", category: "missing-test", message: "no test for new branch", file: "b.ts" };
  const blockerDup = { severity: "major", category: "type-error", message: "ts2345 mismatch", file: "a.ts", line: 10 };
  const c1 = mkOutcome("rework", [
    { agent: "claude", verdict: "rework", blockers: [blockerA], summary: "chunk 1" },
    { agent: "openai", verdict: "approve", blockers: [], summary: "chunk 1 ok" },
  ]);
  const c2 = mkOutcome("rework", [
    { agent: "claude", verdict: "rework", blockers: [blockerDup, blockerB], summary: "chunk 2" },
    { agent: "openai", verdict: "approve", blockers: [], summary: "chunk 2 ok" },
  ]);
  const merged = integrateChunkOutcomes([c1, c2]);
  const claude = merged.results.find((r) => r.agent === "claude");
  assert.equal(claude.blockers.length, 2); // duplicate collapsed
  assert.equal(claude.summary, "chunk 1 | chunk 2");
});

test("integrateChunkOutcomes: per-agent verdict is severity-max", () => {
  const c1 = mkOutcome("approve", [
    { agent: "claude", verdict: "approve", blockers: [], summary: "" },
  ]);
  const c2 = mkOutcome("reject", [
    { agent: "claude", verdict: "reject", blockers: [{ severity: "blocker", category: "x", message: "x" }], summary: "" },
  ]);
  const merged = integrateChunkOutcomes([c1, c2]);
  const claude = merged.results.find((r) => r.agent === "claude");
  assert.equal(claude.verdict, "reject");
});

test("integrateChunkOutcomes: tokens + costs sum across chunks", () => {
  const c1 = mkOutcome("approve", [
    { agent: "claude", verdict: "approve", blockers: [], summary: "", tokensUsed: 1000, costUsd: 0.05 },
  ]);
  const c2 = mkOutcome("approve", [
    { agent: "claude", verdict: "approve", blockers: [], summary: "", tokensUsed: 800, costUsd: 0.04 },
  ]);
  const merged = integrateChunkOutcomes([c1, c2]);
  const claude = merged.results.find((r) => r.agent === "claude");
  assert.equal(claude.tokensUsed, 1800);
  assert.equal(Number(claude.costUsd.toFixed(4)), 0.09);
});

test("integrateChunkOutcomes: rounds = max, consensusReached = AND", () => {
  const c1 = { verdict: "approve", rounds: 1, results: [], consensusReached: true };
  const c2 = { verdict: "rework", rounds: 3, results: [], consensusReached: false };
  const merged = integrateChunkOutcomes([c1, c2]);
  assert.equal(merged.rounds, 3);
  assert.equal(merged.consensusReached, false);
});

test("integrateChunkOutcomes: agent only present in one chunk still appears in merged results", () => {
  const c1 = mkOutcome("approve", [
    { agent: "claude", verdict: "approve", blockers: [], summary: "" },
  ]);
  const c2 = mkOutcome("approve", [
    { agent: "claude", verdict: "approve", blockers: [], summary: "" },
    { agent: "openai", verdict: "approve", blockers: [], summary: "" },
  ]);
  const merged = integrateChunkOutcomes([c1, c2]);
  const ids = merged.results.map((r) => r.agent).sort();
  assert.deepEqual(ids, ["claude", "openai"]);
});
