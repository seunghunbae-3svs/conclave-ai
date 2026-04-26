import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupeBlockersAcrossAgents, isFuzzyDuplicate } from "../dist/index.js";

/**
 * v0.13.13 — fuzzy dedupe tests.
 *
 * Live RC: eventbadge#29 verdict had Claude flagging a `console.log`
 * at line 18 and OpenAI flagging the SAME `console.log` at line 17
 * (off-by-one). Existing exact dedupe (file|line|msg[:60]) didn't
 * collapse them — autofix produced 2 patches, second hit a "patch
 * already applied" conflict, loop stalled.
 *
 * Fuzzy rule: collapse iff (same file) AND (line diff ≤ 1) AND (the
 * messages share a notable code-shaped token of ≥4 chars).
 */

const claudeReview = (blockers) => ({ agent: "claude", verdict: "rework", blockers, summary: "" });
const openaiReview = (blockers) => ({ agent: "openai", verdict: "rework", blockers, summary: "" });

test("dedupeBlockersAcrossAgents: collapses ±1-line same-bug from two agents (eventbadge#29 case)", () => {
  const reviews = [
    claudeReview([
      {
        severity: "major",
        category: "debug-artifact",
        message: "Remove the console.log('[debug] compressImage called', file?.name) debug statement.",
        file: "frontend/src/utils/imageCompressor.js",
        line: 18,
      },
    ]),
    openaiReview([
      {
        severity: "minor",
        category: "debug-logging",
        message: "A debug console.log('[debug] compressImage called', file?.name) was added — remove it.",
        file: "frontend/src/utils/imageCompressor.js",
        line: 17,
      },
    ]),
  ];
  const out = dedupeBlockersAcrossAgents(reviews);
  assert.equal(out.length, 1, `expected 1 collapsed blocker, got ${out.length}`);
  // First-seen wins — Claude was first.
  assert.equal(out[0].agent, "claude");
});

test("dedupeBlockersAcrossAgents: does NOT collapse when lines differ by >1", () => {
  const reviews = [
    claudeReview([
      { severity: "major", category: "x", message: "console.log here", file: "a.js", line: 10 },
    ]),
    openaiReview([
      { severity: "major", category: "x", message: "console.log here", file: "a.js", line: 13 },
    ]),
  ];
  const out = dedupeBlockersAcrossAgents(reviews);
  assert.equal(out.length, 2, "lines 10 and 13 differ by 3 — should NOT collapse");
});

test("dedupeBlockersAcrossAgents: does NOT collapse when files differ", () => {
  const reviews = [
    claudeReview([
      { severity: "major", category: "x", message: "console.log here", file: "a.js", line: 10 },
    ]),
    openaiReview([
      { severity: "major", category: "x", message: "console.log here", file: "b.js", line: 10 },
    ]),
  ];
  const out = dedupeBlockersAcrossAgents(reviews);
  assert.equal(out.length, 2);
});

test("dedupeBlockersAcrossAgents: does NOT collapse when messages share no notable token", () => {
  const reviews = [
    claudeReview([
      { severity: "major", category: "x", message: "Remove unused import", file: "a.js", line: 10 },
    ]),
    openaiReview([
      { severity: "major", category: "y", message: "Add input validation", file: "a.js", line: 11 },
    ]),
  ];
  const out = dedupeBlockersAcrossAgents(reviews);
  assert.equal(out.length, 2, "different bugs at adjacent lines — keep both");
});

test("dedupeBlockersAcrossAgents: collapses when both messages contain the same identifier-shaped token", () => {
  const reviews = [
    claudeReview([
      { severity: "major", category: "x", message: "Variable userEmail is leaked", file: "a.js", line: 10 },
    ]),
    openaiReview([
      { severity: "major", category: "y", message: "userEmail should not appear in logs", file: "a.js", line: 11 },
    ]),
  ];
  const out = dedupeBlockersAcrossAgents(reviews);
  assert.equal(out.length, 1);
});

test("dedupeBlockersAcrossAgents: still respects the existing exact key (no fuzzy false-fire)", () => {
  const reviews = [
    claudeReview([
      { severity: "major", category: "x", message: "Same exact bug", file: "a.js", line: 10 },
    ]),
    openaiReview([
      { severity: "major", category: "x", message: "Same exact bug", file: "a.js", line: 10 },
    ]),
  ];
  const out = dedupeBlockersAcrossAgents(reviews);
  assert.equal(out.length, 1);
});

test("dedupeBlockersAcrossAgents: nit severity is filtered before dedupe", () => {
  const reviews = [
    claudeReview([
      { severity: "nit", category: "style", message: "consider tabs", file: "a.js", line: 1 },
      { severity: "major", category: "bug", message: "real bug here", file: "b.js", line: 2 },
    ]),
  ];
  const out = dedupeBlockersAcrossAgents(reviews);
  assert.equal(out.length, 1);
  assert.equal(out[0].blocker.severity, "major");
});

// ---- isFuzzyDuplicate (export for direct unit testing) -------------------

test("isFuzzyDuplicate: false when no accepted entries", () => {
  assert.equal(
    isFuzzyDuplicate(
      { severity: "major", category: "x", message: "msg", file: "a.js", line: 1 },
      [],
    ),
    false,
  );
});

test("isFuzzyDuplicate: false when candidate has no file", () => {
  assert.equal(
    isFuzzyDuplicate(
      { severity: "major", category: "x", message: "msg", line: 1 },
      [{ agent: "claude", blocker: { severity: "major", category: "x", message: "msg", file: "a", line: 1 } }],
    ),
    false,
  );
});

test("isFuzzyDuplicate: false when candidate has no line", () => {
  assert.equal(
    isFuzzyDuplicate(
      { severity: "major", category: "x", message: "console.log here", file: "a.js" },
      [{ agent: "claude", blocker: { severity: "major", category: "x", message: "console.log here", file: "a.js", line: 1 } }],
    ),
    false,
  );
});

test("isFuzzyDuplicate: stopwords don't count as notable tokens", () => {
  const cand = { severity: "major", category: "x", message: "this should be removed before merge", file: "a.js", line: 1 };
  const accepted = [
    { agent: "claude", blocker: { severity: "major", category: "x", message: "this should not be merged before review", file: "a.js", line: 2 } },
  ];
  // Both share "this", "should", "before" — but those are stopwords. Should NOT collapse.
  assert.equal(isFuzzyDuplicate(cand, accepted), false);
});
