import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReviewJson, serializeReviewJson } from "../dist/lib/review-json-output.js";

// Fixtures ---------------------------------------------------------------

const claudeReviewRework = {
  agent: "claude",
  verdict: "rework",
  summary: "needs more work",
  blockers: [{ severity: "blocker", category: "type-error", message: "fix x", file: "src/x.ts" }],
};

const openaiReviewApprove = {
  agent: "openai",
  verdict: "approve",
  summary: "LGTM",
  blockers: [],
};

const designReviewRework = {
  agent: "design",
  verdict: "rework",
  summary: "contrast too low",
  blockers: [{ severity: "major", category: "design-contrast", message: "1.2:1", file: "src/App.tsx" }],
};

const metricsA = {
  callCount: 2,
  totalInputTokens: 500,
  totalOutputTokens: 200,
  totalCostUsd: 0.0345,
  totalLatencyMs: 3200,
  cacheHitRate: 0.5,
};

// 1. Flat Council — no tier, no plain summary, no PR number -------------

test("buildReviewJson: flat Council shape has tier1Count=results.length, tier2Count=0", () => {
  const out = buildReviewJson({
    repo: "o/r",
    sha: "deadbeefcafe",
    councilVerdict: "rework",
    domain: "code",
    results: [claudeReviewRework, openaiReviewApprove],
    metrics: metricsA,
    episodicId: "ep-1",
  });
  assert.equal(out.verdict, "rework");
  assert.equal(out.domain, "code");
  assert.equal(out.tiers.tier1Count, 2);
  assert.equal(out.tiers.tier1Verdict, "rework");
  assert.equal(out.tiers.tier2Count, 0);
  assert.equal(out.tiers.tier2Verdict, "");
  assert.equal(out.agents.length, 2);
  assert.equal(out.agents[0].id, "claude");
  assert.equal(out.agents[0].blockers.length, 1);
  assert.equal(out.agents[1].id, "openai");
  assert.equal(out.agents[1].verdict, "approve");
  assert.equal(out.metrics.calls, 2);
  assert.equal(out.metrics.tokensIn, 500);
  assert.equal(out.metrics.costUsd, 0.0345);
  assert.equal(out.episodicId, "ep-1");
  assert.equal(out.sha, "deadbeefcafe");
  assert.equal(out.repo, "o/r");
  assert.equal(out.prNumber, undefined, "prNumber absent when not provided");
  assert.equal(out.plainSummary, undefined);
});

// 2. Tiered — with escalation -------------------------------------------

test("buildReviewJson: tiered with escalation populates tier1 + tier2 counts and verdicts", () => {
  const out = buildReviewJson({
    repo: "o/r",
    sha: "s1",
    pullNumber: 21,
    councilVerdict: "approve",
    domain: "mixed",
    results: [claudeReviewRework, designReviewRework, openaiReviewApprove],
    metrics: metricsA,
    episodicId: "ep-21",
    tier: {
      escalated: true,
      reason: "tier-1 disagreement",
      tier1Rounds: 2,
      tier2Rounds: 1,
      tier1Ids: ["claude", "design"],
      tier2Ids: ["claude", "design", "openai"],
      tier1Verdict: "rework",
      tier2Verdict: "approve",
    },
  });
  assert.equal(out.tiers.tier1Count, 2);
  assert.equal(out.tiers.tier1Verdict, "rework");
  assert.equal(out.tiers.tier2Count, 3);
  assert.equal(out.tiers.tier2Verdict, "approve");
  assert.equal(out.prNumber, 21);
  assert.equal(out.domain, "mixed");
});

// 3. Tiered — no escalation (tier-1 clean approve) -----------------------

test("buildReviewJson: tiered without escalation → tier2 count+verdict empty", () => {
  const out = buildReviewJson({
    repo: "o/r",
    sha: "s2",
    pullNumber: 100,
    councilVerdict: "approve",
    domain: "code",
    results: [openaiReviewApprove],
    metrics: metricsA,
    episodicId: "ep-100",
    tier: {
      escalated: false,
      reason: "tier-1 clean approve",
      tier1Rounds: 1,
      tier1Ids: ["openai"],
      tier2Ids: [],
      tier1Verdict: "approve",
    },
  });
  assert.equal(out.tiers.tier1Count, 1);
  assert.equal(out.tiers.tier1Verdict, "approve");
  assert.equal(out.tiers.tier2Count, 0);
  assert.equal(out.tiers.tier2Verdict, "");
});

// 4. Plain summary included when provided --------------------------------

test("buildReviewJson: plainSummary passes through when provided", () => {
  const plainSummary = {
    mode: "review",
    locale: "en",
    whatChanged: "Two files changed.",
    verdictInPlain: "Needs rework.",
    nextAction: "Fix type error.",
    issues: [],
  };
  const out = buildReviewJson({
    repo: "o/r",
    sha: "s3",
    councilVerdict: "rework",
    domain: "code",
    results: [claudeReviewRework],
    metrics: metricsA,
    episodicId: "ep-3",
    plainSummary,
  });
  assert.deepEqual(out.plainSummary, plainSummary);
});

// 5. serializeReviewJson emits a single newline-terminated JSON line -----

test("serializeReviewJson: output is single JSON line terminated with \\n", () => {
  const out = buildReviewJson({
    repo: "o/r",
    sha: "s",
    councilVerdict: "approve",
    domain: "code",
    results: [openaiReviewApprove],
    metrics: metricsA,
    episodicId: "e",
  });
  const ser = serializeReviewJson(out);
  assert.ok(ser.endsWith("\n"));
  // Exactly one line (other than trailing newline).
  const lines = ser.split("\n").filter((l) => l.length > 0);
  assert.equal(lines.length, 1);
  // Parseable round-trip
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.verdict, "approve");
  assert.equal(parsed.sha, "s");
});

// 6. Schema invariants — shape is stable ---------------------------------

test("buildReviewJson: output keys are exactly the v0.7.1 locked schema", () => {
  const out = buildReviewJson({
    repo: "o/r",
    sha: "s",
    councilVerdict: "approve",
    domain: "code",
    results: [openaiReviewApprove],
    metrics: metricsA,
    episodicId: "e",
  });
  const keys = Object.keys(out).sort();
  const expected = ["agents", "domain", "episodicId", "metrics", "repo", "sha", "tiers", "verdict"].sort();
  assert.deepEqual(keys, expected);

  const tierKeys = Object.keys(out.tiers).sort();
  assert.deepEqual(tierKeys, ["tier1Count", "tier1Verdict", "tier2Count", "tier2Verdict"]);

  const metricKeys = Object.keys(out.metrics).sort();
  assert.deepEqual(metricKeys, ["cacheHitRate", "calls", "costUsd", "latencyMs", "tokensIn", "tokensOut"]);

  const agentKeys = Object.keys(out.agents[0]).sort();
  assert.deepEqual(agentKeys, ["blockers", "id", "summary", "verdict"]);
});

// 7. pullNumber=0 is treated as absent -----------------------------------

test("buildReviewJson: pullNumber=0 is omitted (git-diff / local run)", () => {
  const out = buildReviewJson({
    repo: "o/r",
    sha: "s",
    pullNumber: 0,
    councilVerdict: "approve",
    domain: "code",
    results: [openaiReviewApprove],
    metrics: metricsA,
    episodicId: "e",
  });
  assert.equal(out.prNumber, undefined);
});

// 8. Reject verdict surfaces at all three levels -------------------------

test("buildReviewJson: reject verdict propagates to verdict + tier1Verdict", () => {
  const rejectReview = {
    agent: "claude",
    verdict: "reject",
    summary: "no",
    blockers: [{ severity: "blocker", category: "sec", message: "leak" }],
  };
  const out = buildReviewJson({
    repo: "o/r",
    sha: "s",
    councilVerdict: "reject",
    domain: "code",
    results: [rejectReview],
    metrics: metricsA,
    episodicId: "e",
  });
  assert.equal(out.verdict, "reject");
  assert.equal(out.tiers.tier1Verdict, "reject");
  assert.equal(out.agents[0].verdict, "reject");
});
