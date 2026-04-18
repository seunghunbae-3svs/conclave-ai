import { test } from "node:test";
import assert from "node:assert/strict";
import { renderReview, verdictToExitCode } from "../dist/lib/output.js";

const baseMetrics = {
  callCount: 1,
  totalInputTokens: 1_000,
  totalOutputTokens: 200,
  totalCostUsd: 0.015,
  totalLatencyMs: 900,
  cacheHitRate: 0.5,
  byAgent: { claude: { calls: 1, costUsd: 0.015 } },
  byModel: { "claude-sonnet-4-6": { calls: 1, costUsd: 0.015 } },
};

test("verdictToExitCode: approve=0, rework=1, reject=2", () => {
  assert.equal(verdictToExitCode("approve"), 0);
  assert.equal(verdictToExitCode("rework"), 1);
  assert.equal(verdictToExitCode("reject"), 2);
});

test("renderReview: approve + no blockers produces clean output", () => {
  const out = renderReview({
    repo: "acme/my-app",
    pullNumber: 7,
    sha: "abcdef1234567890",
    source: "gh-pr",
    councilVerdict: "approve",
    consensus: true,
    results: [{ agent: "claude", verdict: "approve", blockers: [], summary: "LGTM" }],
    metrics: baseMetrics,
  });
  assert.match(out, /Verdict: APPROVE/);
  assert.match(out, /acme\/my-app #7/);
  assert.match(out, /no blockers/);
  assert.match(out, /cache hit:  50.0%/);
});

test("renderReview: rework with mixed-severity blockers sorts by severity", () => {
  const out = renderReview({
    repo: "acme/my-app",
    pullNumber: 0,
    sha: "sha",
    source: "git-diff",
    councilVerdict: "rework",
    consensus: false,
    results: [
      {
        agent: "claude",
        verdict: "rework",
        blockers: [
          { severity: "nit", category: "style", message: "unused var" },
          { severity: "blocker", category: "type-error", message: "ts2345", file: "x.ts", line: 10 },
          { severity: "major", category: "security", message: "hardcoded secret" },
        ],
        summary: "1 blocker + 1 major + 1 nit",
      },
    ],
    metrics: baseMetrics,
  });
  const blockerIdx = out.indexOf("[BLOCKER]");
  const majorIdx = out.indexOf("[MAJOR]");
  const nitIdx = out.indexOf("[NIT]");
  assert.ok(blockerIdx < majorIdx, "blocker should come before major");
  assert.ok(majorIdx < nitIdx, "major should come before nit");
  assert.match(out, /no consensus/);
  assert.match(out, /x\.ts:10/);
});

test("renderReview: reject output tagged", () => {
  const out = renderReview({
    repo: "acme/my-app",
    pullNumber: 1,
    sha: "sha",
    source: "gh-pr",
    councilVerdict: "reject",
    consensus: true,
    results: [{ agent: "claude", verdict: "reject", blockers: [], summary: "wrong approach" }],
    metrics: baseMetrics,
  });
  assert.match(out, /Verdict: REJECT/);
});

test("renderReview: metrics section rendered", () => {
  const out = renderReview({
    repo: "acme/my-app",
    pullNumber: 1,
    sha: "sha",
    source: "gh-pr",
    councilVerdict: "approve",
    consensus: true,
    results: [{ agent: "claude", verdict: "approve", blockers: [], summary: "" }],
    metrics: { ...baseMetrics, totalCostUsd: 0.0345 },
  });
  assert.match(out, /\$0\.0345/);
  assert.match(out, /calls:      1/);
});
