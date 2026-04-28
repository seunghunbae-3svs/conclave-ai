import { test } from "node:test";
import assert from "node:assert/strict";
import { RuleBasedClassifier, newEpisodicId } from "../dist/index.js";

const now = () => new Date().toISOString();

function mkEpisodic(reviews, overrides = {}) {
  return {
    id: "ep-test",
    createdAt: now(),
    repo: "acme/app",
    pullNumber: 7,
    sha: "abc1234",
    diffSha256: "a".repeat(64),
    reviews,
    councilVerdict: overrides.councilVerdict ?? "approve",
    outcome: overrides.outcome ?? "pending",
    costUsd: 0.01,
    ...overrides,
  };
}

test("newEpisodicId: returns ep-prefixed UUID-shape", () => {
  const id = newEpisodicId();
  assert.match(id, /^ep-[0-9a-f-]+$/);
});

test("classify merged: single answer-key, no failures", () => {
  const c = new RuleBasedClassifier();
  const out = c.classify(
    mkEpisodic([{ agent: "claude", verdict: "approve", blockers: [], summary: "LGTM" }]),
    "merged",
  );
  assert.equal(out.answerKeys.length, 1);
  assert.equal(out.failures.length, 0);
  assert.equal(out.answerKeys[0].domain, "code");
  assert.match(out.answerKeys[0].pattern, /by-repo\/acme\/app/);
  assert.match(out.answerKeys[0].lesson, /LGTM/);
});

test("classify merged: empty summary falls back to default lesson", () => {
  const c = new RuleBasedClassifier();
  const out = c.classify(
    mkEpisodic([{ agent: "claude", verdict: "approve", blockers: [], summary: "" }]),
    "merged",
  );
  assert.match(out.answerKeys[0].lesson, /Merged without blockers/);
});

test("classify rejected: one failure per unique (category, severity, message)", () => {
  const c = new RuleBasedClassifier();
  const out = c.classify(
    mkEpisodic([
      {
        agent: "claude",
        verdict: "reject",
        blockers: [
          { severity: "blocker", category: "type-error", message: "ts2345 mismatch", file: "x.ts", line: 10 },
          { severity: "major", category: "security", message: "secret in source" },
          { severity: "nit", category: "style", message: "trailing whitespace" },
        ],
        summary: "2 blockers + 1 nit",
      },
    ]),
    "rejected",
  );
  assert.equal(out.answerKeys.length, 0);
  assert.equal(out.failures.length, 2); // nit excluded
  const categories = out.failures.map((f) => f.category);
  assert.ok(categories.includes("type-error"));
  assert.ok(categories.includes("security"));
});

test("classify rejected: dedupes same (category, severity, message) across agents", () => {
  const c = new RuleBasedClassifier();
  const sameBlocker = { severity: "blocker", category: "security", message: "same leak" };
  const out = c.classify(
    mkEpisodic([
      { agent: "claude", verdict: "reject", blockers: [sameBlocker], summary: "" },
      { agent: "openai", verdict: "reject", blockers: [sameBlocker], summary: "" },
    ]),
    "rejected",
  );
  assert.equal(out.failures.length, 1);
});

test("classify reworked: behaves like rejected (writes failures)", () => {
  const c = new RuleBasedClassifier();
  const out = c.classify(
    mkEpisodic([
      {
        agent: "claude",
        verdict: "rework",
        blockers: [{ severity: "major", category: "missing-test", message: "no test for new branch" }],
        summary: "1 major",
      },
    ]),
    "reworked",
  );
  assert.equal(out.answerKeys.length, 0);
  assert.equal(out.failures.length, 1);
  assert.equal(out.failures[0].category, "missing-test");
});

test("category mapping: free-form strings normalize to allowed enum", () => {
  const c = new RuleBasedClassifier();
  const { failures } = c.classify(
    mkEpisodic([
      {
        agent: "claude",
        verdict: "reject",
        blockers: [
          { severity: "blocker", category: "Type Error", message: "a" },
          { severity: "blocker", category: "UNUSED IMPORT", message: "b" },
          { severity: "blocker", category: "a11y", message: "c" },
          { severity: "blocker", category: "weird-custom", message: "d" },
        ],
        summary: "",
      },
    ]),
    "rejected",
  );
  const cats = failures.map((f) => f.category);
  assert.ok(cats.includes("type-error"));
  assert.ok(cats.includes("dead-code"));
  assert.ok(cats.includes("accessibility"));
  assert.ok(cats.includes("other"));
});

test("classify merged: tags derived from categories seen in review", () => {
  const c = new RuleBasedClassifier();
  const { answerKeys } = c.classify(
    mkEpisodic([
      {
        agent: "claude",
        verdict: "approve",
        blockers: [{ severity: "minor", category: "unused-imports", message: "ok" }],
        summary: "all fine after rework",
      },
    ]),
    "merged",
  );
  assert.ok(answerKeys[0].tags.includes("unused-imports"));
});

test("classify: ids are stable for the same input", () => {
  const c = new RuleBasedClassifier();
  const ep = mkEpisodic([
    { agent: "claude", verdict: "reject", blockers: [{ severity: "blocker", category: "security", message: "leak" }], summary: "" },
  ]);
  const a = c.classify(ep, "rejected");
  const b = c.classify(ep, "rejected");
  assert.equal(a.failures[0].id, b.failures[0].id);
});

// H2 #6 — removed-blocker extraction on merge with priors

test("classify merged with priors: extracts removed-blocker from earlier cycle", () => {
  const c = new RuleBasedClassifier();
  const cycle1 = mkEpisodic(
    [
      {
        agent: "claude",
        verdict: "rework",
        blockers: [
          { severity: "major", category: "debug-noise", message: "console.log debug call left in compressImage" },
        ],
        summary: "1 blocker",
      },
    ],
    { id: "ep-cycle-1", cycleNumber: 1, councilVerdict: "rework", outcome: "reworked" },
  );
  const cycle2 = mkEpisodic(
    [{ agent: "claude", verdict: "approve", blockers: [], summary: "LGTM after rework" }],
    { id: "ep-cycle-2", cycleNumber: 2, priorEpisodicId: "ep-cycle-1" },
  );
  const out = c.classify(cycle2, "merged", [cycle1]);
  assert.equal(out.answerKeys.length, 1);
  const ak = out.answerKeys[0];
  assert.equal(ak.removedBlockers.length, 1);
  assert.equal(ak.removedBlockers[0].category, "debug-noise");
  assert.match(ak.removedBlockers[0].message, /console\.log/);
  // Lesson surfaces the resolved-before-merge signal.
  assert.match(ak.lesson, /Resolved before merge/);
  // Tags pick up the removed-blocker category.
  assert.ok(ak.tags.includes("debug-noise"));
});

test("classify merged with priors: skips nits (low signal)", () => {
  const c = new RuleBasedClassifier();
  const cycle1 = mkEpisodic(
    [
      {
        agent: "claude",
        verdict: "rework",
        blockers: [{ severity: "nit", category: "style", message: "trailing whitespace" }],
        summary: "",
      },
    ],
    { id: "ep-c1", cycleNumber: 1 },
  );
  const cycle2 = mkEpisodic([{ agent: "claude", verdict: "approve", blockers: [], summary: "" }], {
    id: "ep-c2",
    cycleNumber: 2,
    priorEpisodicId: "ep-c1",
  });
  const out = c.classify(cycle2, "merged", [cycle1]);
  assert.equal(out.answerKeys[0].removedBlockers.length, 0);
});

test("classify merged with priors: a blocker still present in the final cycle is NOT removed", () => {
  const c = new RuleBasedClassifier();
  const persistent = { severity: "major", category: "security", message: "hardcoded api key" };
  const cycle1 = mkEpisodic(
    [{ agent: "claude", verdict: "rework", blockers: [persistent], summary: "" }],
    { id: "ep-c1", cycleNumber: 1 },
  );
  const cycle2 = mkEpisodic(
    [{ agent: "claude", verdict: "rework", blockers: [persistent], summary: "" }],
    { id: "ep-c2", cycleNumber: 2, priorEpisodicId: "ep-c1" },
  );
  const out = c.classify(cycle2, "merged", [cycle1]);
  assert.equal(out.answerKeys[0].removedBlockers.length, 0);
});

test("classify merged with priors: dedupes the same removed-blocker reported by 2 agents", () => {
  const c = new RuleBasedClassifier();
  const sameBlocker = { severity: "major", category: "missing-test", message: "no test for new branch" };
  const cycle1 = mkEpisodic(
    [
      { agent: "claude", verdict: "rework", blockers: [sameBlocker], summary: "" },
      { agent: "openai", verdict: "rework", blockers: [sameBlocker], summary: "" },
    ],
    { id: "ep-c1", cycleNumber: 1 },
  );
  const cycle2 = mkEpisodic([{ agent: "claude", verdict: "approve", blockers: [], summary: "" }], {
    id: "ep-c2",
    cycleNumber: 2,
    priorEpisodicId: "ep-c1",
  });
  const out = c.classify(cycle2, "merged", [cycle1]);
  assert.equal(out.answerKeys[0].removedBlockers.length, 1);
});

test("classify merged with priors: walks multi-cycle chain (cycle 1 + 2 → merged at 3)", () => {
  const c = new RuleBasedClassifier();
  const c1 = mkEpisodic(
    [{ agent: "claude", verdict: "rework", blockers: [{ severity: "major", category: "type-error", message: "ts2345" }], summary: "" }],
    { id: "ep-c1", cycleNumber: 1 },
  );
  const c2 = mkEpisodic(
    [{ agent: "claude", verdict: "rework", blockers: [{ severity: "major", category: "missing-test", message: "no test" }], summary: "" }],
    { id: "ep-c2", cycleNumber: 2, priorEpisodicId: "ep-c1" },
  );
  const c3 = mkEpisodic([{ agent: "claude", verdict: "approve", blockers: [], summary: "" }], {
    id: "ep-c3",
    cycleNumber: 3,
    priorEpisodicId: "ep-c2",
  });
  // Caller responsibility: pass priors in oldest-first order.
  const out = c.classify(c3, "merged", [c1, c2]);
  const cats = out.answerKeys[0].removedBlockers.map((b) => b.category).sort();
  assert.deepEqual(cats, ["missing-test", "type-error"]);
});

test("classify merged without priors: behaves identically to legacy single-cycle path", () => {
  const c = new RuleBasedClassifier();
  const ep = mkEpisodic(
    [{ agent: "claude", verdict: "approve", blockers: [], summary: "LGTM" }],
    { id: "ep-1", cycleNumber: 1 },
  );
  const out = c.classify(ep, "merged", []);
  assert.equal(out.answerKeys[0].removedBlockers.length, 0);
  assert.doesNotMatch(out.answerKeys[0].lesson, /Resolved before merge/);
});

// H3 #11 — solution-patch promotion on merge

const sampleHunk = [
  "diff --git a/x.js b/x.js",
  "--- a/x.js",
  "+++ b/x.js",
  "@@ -1,2 +1,1 @@",
  " const x = 1;",
  "-console.log('debug');",
].join("\n");

test("classify merged with priors carrying solutionPatches: emits per-pair answer-keys", () => {
  const c = new RuleBasedClassifier();
  const cycle1 = mkEpisodic(
    [
      {
        agent: "claude",
        verdict: "rework",
        blockers: [
          { severity: "major", category: "debug-noise", message: "console.log left in compressImage" },
        ],
        summary: "1 blocker",
      },
    ],
    { id: "ep-c1", cycleNumber: 1 },
  );
  // Cycle 2 carries the worker's applied patch as solutionPatches.
  const cycle2 = mkEpisodic(
    [{ agent: "claude", verdict: "approve", blockers: [], summary: "LGTM after rework" }],
    {
      id: "ep-c2",
      cycleNumber: 2,
      priorEpisodicId: "ep-c1",
      solutionPatches: [
        {
          blockerCategory: "debug-noise",
          blockerMessage: "console.log left in compressImage",
          blockerFile: "src/x.js",
          hunk: sampleHunk,
          agent: "claude",
        },
      ],
    },
  );
  const out = c.classify(cycle2, "merged", [cycle1]);
  assert.equal(out.answerKeys.length, 2); // aggregate + per-pair
  const solnKey = out.answerKeys.find((k) => k.pattern.startsWith("autofix-solution/"));
  assert.ok(solnKey, "expected autofix-solution answer-key");
  assert.equal(solnKey.solutionPatch.hunk, sampleHunk);
  assert.equal(solnKey.solutionPatch.blockerCategory, "debug-noise");
  assert.match(solnKey.lesson, /Worker.*resolved.*debug-noise/);
});

test("classify merged: solutionPatch with no matching removed-blocker → not emitted", () => {
  const c = new RuleBasedClassifier();
  const cycle1 = mkEpisodic(
    [{ agent: "claude", verdict: "approve", blockers: [], summary: "" }],
    { id: "ep-c1", cycleNumber: 1 },
  );
  const cycle2 = mkEpisodic(
    [{ agent: "claude", verdict: "approve", blockers: [], summary: "" }],
    {
      id: "ep-c2",
      cycleNumber: 2,
      priorEpisodicId: "ep-c1",
      solutionPatches: [
        {
          blockerCategory: "different-category",
          blockerMessage: "no matching removed-blocker exists",
          hunk: sampleHunk,
          agent: "claude",
        },
      ],
    },
  );
  const out = c.classify(cycle2, "merged", [cycle1]);
  // No removed blockers (priors had no blockers) → no autofix-solution key.
  assert.equal(out.answerKeys.length, 1);
  assert.equal(out.answerKeys[0].pattern, "by-repo/acme/app");
});

test("classify merged: dedupes same-(category, message) solutionPatch across multiple priors", () => {
  const c = new RuleBasedClassifier();
  const cycle1 = mkEpisodic(
    [
      {
        agent: "claude",
        verdict: "rework",
        blockers: [{ severity: "major", category: "debug-noise", message: "console.log A" }],
        summary: "",
      },
    ],
    { id: "ep-c1", cycleNumber: 1 },
  );
  const cycle2 = mkEpisodic(
    [
      {
        agent: "claude",
        verdict: "rework",
        blockers: [{ severity: "major", category: "debug-noise", message: "console.log A" }],
        summary: "",
      },
    ],
    {
      id: "ep-c2",
      cycleNumber: 2,
      priorEpisodicId: "ep-c1",
      // Same patch across cycles — should collapse.
      solutionPatches: [
        {
          blockerCategory: "debug-noise",
          blockerMessage: "console.log A",
          hunk: sampleHunk,
          agent: "claude",
        },
      ],
    },
  );
  const cycle3 = mkEpisodic(
    [{ agent: "claude", verdict: "approve", blockers: [], summary: "" }],
    {
      id: "ep-c3",
      cycleNumber: 3,
      priorEpisodicId: "ep-c2",
      solutionPatches: [
        {
          blockerCategory: "debug-noise",
          blockerMessage: "console.log A",
          hunk: sampleHunk,
          agent: "claude",
        },
      ],
    },
  );
  const out = c.classify(cycle3, "merged", [cycle1, cycle2]);
  const solnKeys = out.answerKeys.filter((k) => k.pattern.startsWith("autofix-solution/"));
  assert.equal(solnKeys.length, 1, `expected 1 deduped solution key, got ${solnKeys.length}`);
});

test("classify merged: matchPatchToRemoved requires same category", () => {
  const c = new RuleBasedClassifier();
  const cycle1 = mkEpisodic(
    [
      {
        agent: "claude",
        verdict: "rework",
        blockers: [{ severity: "major", category: "debug-noise", message: "x" }],
        summary: "",
      },
    ],
    { id: "ep-c1", cycleNumber: 1 },
  );
  const cycle2 = mkEpisodic(
    [{ agent: "claude", verdict: "approve", blockers: [], summary: "" }],
    {
      id: "ep-c2",
      cycleNumber: 2,
      priorEpisodicId: "ep-c1",
      solutionPatches: [
        {
          blockerCategory: "missing-test", // different category — should NOT match
          blockerMessage: "x",
          hunk: sampleHunk,
          agent: "claude",
        },
      ],
    },
  );
  const out = c.classify(cycle2, "merged", [cycle1]);
  const solnKeys = out.answerKeys.filter((k) => k.pattern.startsWith("autofix-solution/"));
  assert.equal(solnKeys.length, 0);
});
