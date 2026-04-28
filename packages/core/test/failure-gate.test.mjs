import { test } from "node:test";
import assert from "node:assert/strict";
import { applyFailureGate } from "../dist/index.js";

const now = () => new Date().toISOString();

function mkOutcome(verdict, results) {
  return {
    verdict,
    rounds: 1,
    results,
    consensusReached: true,
  };
}

function mkFailure({ id, category, severity, title, body, file, tags = [] }) {
  return {
    id,
    createdAt: now(),
    domain: "code",
    category,
    severity,
    title,
    body,
    tags: [category, ...tags],
    ...(file ? { seedBlocker: { severity, category, message: title, file } } : {}),
  };
}

const baseCtx = {
  diff: "",
  repo: "acme/app",
  pullNumber: 1,
  newSha: "sha",
};

test("applyFailureGate: no retrieved failures → outcome unchanged, no stickies", () => {
  const outcome = mkOutcome("approve", [
    { agent: "claude", verdict: "approve", blockers: [], summary: "LGTM" },
  ]);
  const result = applyFailureGate(outcome, [], baseCtx);
  assert.equal(result.stickyBlockers.length, 0);
  assert.equal(result.outcome.verdict, "approve");
  assert.equal(result.outcome.results.length, 1);
});

test("applyFailureGate: matches body tokens against added diff lines and injects sticky", () => {
  const failure = mkFailure({
    id: "fc-debug",
    category: "debug-noise",
    severity: "major",
    title: "console.log debug call left in production code",
    body: "Remove console.log debug calls before merging — they leak operational data.",
  });
  const outcome = mkOutcome("approve", [
    { agent: "claude", verdict: "approve", blockers: [], summary: "" },
  ]);
  const ctx = {
    ...baseCtx,
    diff: [
      "+++ b/frontend/src/utils/imageCompressor.js",
      "+function compressImage(file) {",
      "+  console.log('debug compressImage called');",
      "+  return file;",
      "+}",
    ].join("\n"),
  };
  const result = applyFailureGate(outcome, [failure], ctx);
  assert.equal(result.stickyBlockers.length, 1);
  assert.equal(result.stickyBlockers[0].category, "debug-noise");
  assert.equal(result.stickyBlockers[0].severity, "major");
  assert.match(result.stickyBlockers[0].message, /\[sticky from failure-catalog\]/);
  assert.equal(result.outcome.verdict, "rework"); // approve → rework via gate
  // Synthetic agent appended:
  const last = result.outcome.results[result.outcome.results.length - 1];
  assert.equal(last.agent, "failure-gate");
});

test("applyFailureGate: blocker-severity sticky escalates verdict to reject", () => {
  const failure = mkFailure({
    id: "fc-secret",
    category: "security",
    severity: "blocker",
    title: "secret committed in source",
    body: "API_KEY hardcoded values must not land in repository code.",
  });
  const outcome = mkOutcome("approve", [
    { agent: "claude", verdict: "approve", blockers: [], summary: "" },
  ]);
  const ctx = {
    ...baseCtx,
    diff: [
      "+++ b/server/config.js",
      "+const API_KEY = 'sk-prod-hardcoded-values';",
      "+module.exports = { API_KEY };",
    ].join("\n"),
  };
  const result = applyFailureGate(outcome, [failure], ctx);
  assert.equal(result.stickyBlockers.length, 1);
  assert.equal(result.outcome.verdict, "reject");
});

test("applyFailureGate: insufficient token overlap → no sticky", () => {
  const failure = mkFailure({
    id: "fc-strict",
    category: "type-error",
    severity: "major",
    title: "wrong narrowing on union",
    body: "ts2345 narrowing union mismatch verbose error description text",
  });
  const outcome = mkOutcome("approve", [
    { agent: "claude", verdict: "approve", blockers: [], summary: "" },
  ]);
  const ctx = {
    ...baseCtx,
    diff: ["+++ b/x.ts", "+const x = 1;"].join("\n"), // no failure tokens
  };
  const result = applyFailureGate(outcome, [failure], ctx);
  assert.equal(result.stickyBlockers.length, 0);
  assert.equal(result.outcome.verdict, "approve");
});

test("applyFailureGate: skips when council already raised same-category blocker", () => {
  const failure = mkFailure({
    id: "fc-dup",
    category: "debug-noise",
    severity: "major",
    title: "console.log debug calls",
    body: "Remove console.log debug noise before merging operational frontend production",
  });
  const outcome = mkOutcome("rework", [
    {
      agent: "claude",
      verdict: "rework",
      blockers: [
        {
          severity: "major",
          category: "debug-noise",
          message: "console.log on line 18",
        },
      ],
      summary: "1 blocker",
    },
  ]);
  const ctx = {
    ...baseCtx,
    diff: [
      "+++ b/x.js",
      "+console.log('debug compressImage');",
      "+console.log('frontend production noise');",
    ].join("\n"),
  };
  const result = applyFailureGate(outcome, [failure], ctx);
  // No-file case: same category alone suffices for suppression.
  assert.equal(result.stickyBlockers.length, 0);
});

test("applyFailureGate: same category but different file path still injects when seedBlocker.file is set + council blocker has no file", () => {
  const failure = mkFailure({
    id: "fc-debug-file",
    category: "debug-noise",
    severity: "major",
    title: "console.log debug calls in compressor module",
    body: "Remove console.log debug noise before merging operational frontend production",
    file: "frontend/src/utils/imageCompressor.js",
  });
  const outcome = mkOutcome("rework", [
    {
      agent: "claude",
      verdict: "rework",
      blockers: [
        {
          severity: "major",
          category: "debug-noise",
          message: "different file — server.js leftover",
          // no file field
        },
      ],
      summary: "",
    },
  ]);
  const ctx = {
    ...baseCtx,
    diff: [
      "+++ b/frontend/src/utils/imageCompressor.js",
      "+console.log('debug compressImage');",
      "+console.log('frontend production noise');",
    ].join("\n"),
  };
  const result = applyFailureGate(outcome, [failure], ctx);
  // Council blocker has no file → can't claim coverage of the catalog
  // entry's specific file. Gate injects so the file-specific finding
  // isn't lost behind a generic same-category blocker.
  assert.equal(result.stickyBlockers.length, 1);
});

test("applyFailureGate: dedupes two retrieved failures with same (category, title)", () => {
  const f1 = mkFailure({
    id: "fc-a",
    category: "debug-noise",
    severity: "major",
    title: "console.log debug calls left in production",
    body: "console.log debug calls leak operational data frontend production",
  });
  const f2 = mkFailure({
    id: "fc-b",
    category: "debug-noise",
    severity: "major",
    title: "console.log debug calls left in production",
    body: "console.log debug calls leak operational data frontend production",
  });
  const outcome = mkOutcome("approve", [
    { agent: "claude", verdict: "approve", blockers: [], summary: "" },
  ]);
  const ctx = {
    ...baseCtx,
    diff: ["+++ b/x.js", "+console.log('debug operational data');", "+const frontend = 1;"].join("\n"),
  };
  const result = applyFailureGate(outcome, [f1, f2], ctx);
  assert.equal(result.stickyBlockers.length, 1);
});

test("applyFailureGate: severity floor filters minor failures when set to major", () => {
  const minor = mkFailure({
    id: "fc-minor",
    category: "style",
    severity: "minor",
    title: "trailing whitespace style nuisance",
    body: "trailing whitespace style nuisance value",
  });
  const ctx = {
    ...baseCtx,
    diff: ["+++ b/x.js", "+const trailing = 'whitespace style nuisance value';"].join("\n"),
  };
  const outcome = mkOutcome("approve", [
    { agent: "claude", verdict: "approve", blockers: [], summary: "" },
  ]);
  const minorEnabled = applyFailureGate(outcome, [minor], ctx);
  assert.equal(minorEnabled.stickyBlockers.length, 1);
  const majorOnly = applyFailureGate(outcome, [minor], ctx, { minSeverity: "major" });
  assert.equal(majorOnly.stickyBlockers.length, 0);
});

test("applyFailureGate: never downgrades a council reject to approve/rework", () => {
  const failure = mkFailure({
    id: "fc-x",
    category: "debug-noise",
    severity: "major",
    title: "console.log debug calls",
    body: "console.log debug calls leak operational data frontend production",
  });
  const outcome = mkOutcome("reject", [
    { agent: "claude", verdict: "reject", blockers: [
      { severity: "blocker", category: "security", message: "secret leak" }
    ], summary: "" },
  ]);
  const ctx = {
    ...baseCtx,
    diff: ["+++ b/x.js", "+console.log('debug operational frontend production data');"].join("\n"),
  };
  const result = applyFailureGate(outcome, [failure], ctx);
  // Sticky added, but verdict stays reject.
  assert.equal(result.stickyBlockers.length, 1);
  assert.equal(result.outcome.verdict, "reject");
});

test("applyFailureGate: empty diff → no stickies (no FP on diff-less audit context)", () => {
  const failure = mkFailure({
    id: "fc-x",
    category: "debug-noise",
    severity: "major",
    title: "console.log debug calls",
    body: "console.log debug calls leak operational data frontend production",
  });
  const outcome = mkOutcome("approve", [
    { agent: "claude", verdict: "approve", blockers: [], summary: "" },
  ]);
  const result = applyFailureGate(outcome, [failure], baseCtx);
  assert.equal(result.stickyBlockers.length, 0);
});

test("applyFailureGate: only +++ headers (no added content lines) → no stickies", () => {
  const failure = mkFailure({
    id: "fc-x",
    category: "debug-noise",
    severity: "major",
    title: "console.log debug calls",
    body: "console.log debug calls leak operational data frontend production",
  });
  const outcome = mkOutcome("approve", [
    { agent: "claude", verdict: "approve", blockers: [], summary: "" },
  ]);
  const ctx = { ...baseCtx, diff: "+++ b/x.js\n--- a/x.js\n" };
  const result = applyFailureGate(outcome, [failure], ctx);
  assert.equal(result.stickyBlockers.length, 0);
});
