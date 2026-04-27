import { test } from "node:test";
import assert from "node:assert/strict";
import { remainingBlockersFrom } from "../dist/commands/autofix.js";

/**
 * v0.13.14 — `remainingBlockersFrom` must use the same dedupe rules as
 * `dedupeBlockersAcrossAgents` (both exact `file|line|msg[:60]` and
 * fuzzy ±1-line same-token). Live RC: eventbadge#31 (cli@0.13.13)
 * had Claude + OpenAI flag the SAME `console.log` at line 9 with
 * different message wording — the planner correctly collapsed them
 * into one applied fix (commit `459fd5e` landed), but the bailed log
 * still said "remaining blockers: 2" because this function used the
 * legacy key `category|file|message[:60]`.
 */

const review = (agent, blockers) => ({ agent, verdict: "rework", blockers, summary: "" });

test("remainingBlockersFrom: collapses claude+openai reporting same console.log at same line (eventbadge#31)", () => {
  const reviews = [
    review("claude", [
      {
        severity: "major",
        category: "debug-logging",
        message: "Remove the debug console.log('[debug] rgbToHex', r, g, b) — rgbToHex is on the hot path",
        file: "frontend/src/utils/colorExtractor.js",
        line: 9,
      },
    ]),
    review("openai", [
      {
        severity: "major",
        category: "debug-logging",
        message: "A leftover console.log('[debug] rgbToHex', r, g, b) was added to a hot utility path",
        file: "frontend/src/utils/colorExtractor.js",
        line: 9,
      },
    ]),
  ];
  const remaining = remainingBlockersFrom(reviews);
  assert.equal(remaining.length, 1, `expected 1 collapsed blocker, got ${remaining.length} (the eventbadge#31 bailed-count regression)`);
});

test("remainingBlockersFrom: collapses ±1-line same-bug variant (eventbadge#29 cycle 3)", () => {
  const reviews = [
    review("claude", [
      { severity: "major", category: "debug-artifact", message: "Remove the console.log('[debug] compressImage called'", file: "x.js", line: 18 },
    ]),
    review("openai", [
      { severity: "minor", category: "debug-logging", message: "A debug console.log('[debug] compressImage called'", file: "x.js", line: 17 },
    ]),
  ];
  const remaining = remainingBlockersFrom(reviews);
  assert.equal(remaining.length, 1);
});

test("remainingBlockersFrom: keeps two genuinely-different blockers at different lines on same file", () => {
  const reviews = [
    review("claude", [
      { severity: "major", category: "x", message: "Missing input validation on user_id parameter", file: "a.js", line: 10 },
      { severity: "major", category: "y", message: "SQL injection risk on user_query construction", file: "a.js", line: 25 },
    ]),
  ];
  const remaining = remainingBlockersFrom(reviews);
  assert.equal(remaining.length, 2, "different bugs at non-adjacent lines must stay separate");
});

test("remainingBlockersFrom: nit severity is filtered", () => {
  const reviews = [
    review("claude", [
      { severity: "nit", category: "style", message: "consider tabs", file: "a.js", line: 1 },
      { severity: "major", category: "bug", message: "real bug", file: "a.js", line: 2 },
    ]),
  ];
  const remaining = remainingBlockersFrom(reviews);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].severity, "major");
});

test("remainingBlockersFrom: pre-fix legacy key would have NOT collapsed — verify v0.13.14 fix is wired", () => {
  // Same file, same line, different category labels (which the OLD key
  // separated). Real-world: agents disagree on category for the same bug.
  const reviews = [
    review("claude", [
      { severity: "major", category: "regression", message: "Stray debug log in hot path", file: "a.js", line: 5 },
    ]),
    review("openai", [
      { severity: "major", category: "code-quality", message: "Stray debug log in hot path", file: "a.js", line: 5 },
    ]),
  ];
  const remaining = remainingBlockersFrom(reviews);
  // Pre-fix: 2 (different category breaks key). Post-fix: 1 (file|line|msg matches exactly).
  assert.equal(remaining.length, 1, "different category labels must NOT split the dedupe");
});
