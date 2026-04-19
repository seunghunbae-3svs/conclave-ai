import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeAgentScore,
  computeAllAgentScores,
  AGENT_SCORE_WEIGHTS,
  FileSystemMemoryStore,
  OutcomeWriter,
} from "../dist/index.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function episodic({
  id,
  reviews,
  outcome = "pending",
  repo = "acme/app",
  pullNumber = 1,
  sha = "sha",
}) {
  return {
    id,
    createdAt: new Date().toISOString(),
    repo,
    pullNumber,
    sha,
    diffSha256: "a".repeat(64),
    reviews,
    councilVerdict: "approve",
    outcome,
    costUsd: 0.01,
  };
}

const approve = (agent) => ({ agent, verdict: "approve", blockers: [], summary: "" });
const reject = (agent) => ({ agent, verdict: "reject", blockers: [], summary: "" });
const rework = (agent) => ({ agent, verdict: "rework", blockers: [], summary: "" });

test("AGENT_SCORE_WEIGHTS sum to 1.0 per decision #19", () => {
  const sum =
    AGENT_SCORE_WEIGHTS.buildPass +
    AGENT_SCORE_WEIGHTS.reviewApproval +
    AGENT_SCORE_WEIGHTS.time +
    AGENT_SCORE_WEIGHTS.rework;
  assert.ok(Math.abs(sum - 1.0) < 1e-9, `weights sum to ${sum}, expected 1.0`);
});

test("computeAgentScore: empty episodic history → score 0, all components null", () => {
  const s = computeAgentScore("claude", []);
  assert.equal(s.score, 0);
  assert.equal(s.sampleCount, 0);
  assert.equal(s.components.buildPass, null);
  assert.equal(s.components.reviewApproval, null);
  assert.equal(s.components.rework, null);
  assert.equal(s.components.time, null);
});

test("computeAgentScore: all approvals + all merged → components near 1.0", () => {
  const entries = [
    episodic({ id: "e1", reviews: [approve("claude")], outcome: "merged" }),
    episodic({ id: "e2", reviews: [approve("claude")], outcome: "merged" }),
    episodic({ id: "e3", reviews: [approve("claude")], outcome: "merged" }),
  ];
  const s = computeAgentScore("claude", entries);
  assert.equal(s.components.reviewApproval, 1);
  assert.equal(s.components.buildPass, 1);
  assert.equal(s.components.rework, 1); // 1 - 0/3 = 1
  assert.equal(s.components.time, null);
  assert.ok(s.score > 0.9, `expected > 0.9, got ${s.score}`);
});

test("computeAgentScore: all reworks → rework component drops to 0", () => {
  const entries = [
    episodic({ id: "e1", reviews: [rework("claude")], outcome: "reworked" }),
    episodic({ id: "e2", reviews: [rework("claude")], outcome: "reworked" }),
  ];
  const s = computeAgentScore("claude", entries);
  assert.equal(s.components.reviewApproval, 0);
  assert.equal(s.components.rework, 0);
});

test("computeAgentScore: pending entries excluded from buildPass + rework", () => {
  const entries = [
    episodic({ id: "e1", reviews: [approve("claude")], outcome: "pending" }),
    episodic({ id: "e2", reviews: [approve("claude")], outcome: "pending" }),
  ];
  const s = computeAgentScore("claude", entries);
  assert.equal(s.components.reviewApproval, 1);
  assert.equal(s.components.buildPass, null);
  assert.equal(s.components.rework, null);
});

test("computeAgentScore: entries not involving this agent are ignored", () => {
  const entries = [
    episodic({ id: "e1", reviews: [approve("openai")], outcome: "merged" }),
    episodic({ id: "e2", reviews: [approve("openai")], outcome: "merged" }),
    episodic({ id: "e3", reviews: [approve("claude"), approve("openai")], outcome: "merged" }),
  ];
  const s = computeAgentScore("claude", entries);
  assert.equal(s.sampleCount, 1);
  assert.equal(s.components.reviewApproval, 1);
});

test("computeAgentScore: mixed verdicts → fractional components", () => {
  const entries = [
    episodic({ id: "e1", reviews: [approve("claude")], outcome: "merged" }),
    episodic({ id: "e2", reviews: [reject("claude")], outcome: "rejected" }),
    episodic({ id: "e3", reviews: [rework("claude")], outcome: "reworked" }),
  ];
  const s = computeAgentScore("claude", entries);
  // 1 of 3 approves
  assert.equal(s.components.reviewApproval, 1 / 3);
  // buildPass: only 1 approve, merged = 1 → 1/1 = 1
  assert.equal(s.components.buildPass, 1);
  // rework: 1 reworked / 3 resolved → 1 - 1/3 = 2/3
  assert.equal(s.components.rework.toFixed(4), (2 / 3).toFixed(4));
});

test("computeAgentScore: approved but later rejected → buildPass drops", () => {
  const entries = [
    episodic({ id: "e1", reviews: [approve("claude")], outcome: "merged" }),
    episodic({ id: "e2", reviews: [approve("claude")], outcome: "rejected" }),
  ];
  const s = computeAgentScore("claude", entries);
  // buildPass = approvals that merged / total approvals resolved = 1/2
  assert.equal(s.components.buildPass, 0.5);
});

test("computeAgentScore: time component currently always null (placeholder)", () => {
  const entries = [episodic({ id: "x", reviews: [approve("claude")], outcome: "merged" })];
  const s = computeAgentScore("claude", entries);
  assert.equal(s.components.time, null);
});

test("computeAgentScore: componentsUsed lists contributing components only", () => {
  const entries = [
    episodic({ id: "e1", reviews: [approve("claude")], outcome: "pending" }),
  ];
  const s = computeAgentScore("claude", entries);
  // reviewApproval is the only resolvable component for pending-only input.
  assert.deepEqual(s.componentsUsed, ["reviewApproval"]);
  // score renormalized over that component alone = its value
  assert.equal(s.score, 1);
});

test("computeAgentScore: score rounded to 4 decimal places", () => {
  const entries = [
    episodic({ id: "e1", reviews: [approve("claude")], outcome: "merged" }),
    episodic({ id: "e2", reviews: [reject("claude")], outcome: "rejected" }),
    episodic({ id: "e3", reviews: [rework("claude")], outcome: "reworked" }),
  ];
  const s = computeAgentScore("claude", entries);
  // Score should have ≤ 4 decimal places
  const decimalStr = String(s.score).split(".")[1] ?? "";
  assert.ok(decimalStr.length <= 4, `too many decimals in ${s.score}`);
});

test("computeAllAgentScores: picks up every agent in the store", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aic-score-"));
  const store = new FileSystemMemoryStore({ root });
  const writer = new OutcomeWriter({ store });
  try {
    const ep1 = await writer.writeReview({
      ctx: { diff: "x", repo: "a/b", pullNumber: 1, newSha: "s1" },
      reviews: [approve("claude"), approve("openai")],
      councilVerdict: "approve",
      costUsd: 0.01,
    });
    await writer.recordOutcome({ episodicId: ep1.id, outcome: "merged" });

    const ep2 = await writer.writeReview({
      ctx: { diff: "y", repo: "a/b", pullNumber: 2, newSha: "s2" },
      reviews: [approve("claude"), reject("openai")],
      councilVerdict: "rework",
      costUsd: 0.01,
    });
    await writer.recordOutcome({ episodicId: ep2.id, outcome: "reworked" });

    const scores = await computeAllAgentScores(store);
    const byAgent = Object.fromEntries(scores.map((s) => [s.agent, s]));
    assert.ok(byAgent["claude"], "claude score should be present");
    assert.ok(byAgent["openai"], "openai score should be present");
    assert.equal(byAgent["claude"].sampleCount, 2);
    assert.equal(byAgent["openai"].sampleCount, 2);
    // sorted alphabetically
    assert.deepEqual(scores.map((s) => s.agent), ["claude", "openai"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
