import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Council,
  TieredCouncil,
  deriveAgentWeights,
  tallyWeighted,
} from "../dist/index.js";

// ─── tallyWeighted ─────────────────────────────────────────────────────

const approveR = (agent) => ({ agent, verdict: "approve", blockers: [], summary: "" });
const reworkR = (agent, blockers = []) => ({ agent, verdict: "rework", blockers, summary: "" });
const rejectR = (agent, blockers = [{ severity: "blocker", category: "x", message: "x" }]) => ({
  agent,
  verdict: "reject",
  blockers,
  summary: "",
});

test("tallyWeighted: empty weights → identical to legacy 'any reject blocks'", () => {
  const weights = new Map();
  assert.equal(
    tallyWeighted([approveR("claude"), approveR("openai")], weights, 0.5).verdict,
    "approve",
  );
  assert.equal(
    tallyWeighted([approveR("claude"), rejectR("openai")], weights, 0.5).verdict,
    "reject",
  );
  assert.equal(
    tallyWeighted([approveR("claude"), reworkR("openai")], weights, 0.5).verdict,
    "rework",
  );
});

test("tallyWeighted: high-weight reject still blocks (full vote)", () => {
  const weights = new Map([
    ["claude", 0.9],
    ["openai", 0.95],
  ]);
  const out = tallyWeighted([approveR("claude"), rejectR("openai")], weights, 0.5);
  assert.equal(out.verdict, "reject");
  assert.equal(out.consensusReached, true);
});

test("tallyWeighted: low-weight reject demoted to rework", () => {
  const weights = new Map([
    ["claude", 0.9],
    ["noisy", 0.3], // below threshold
  ]);
  const out = tallyWeighted([approveR("claude"), rejectR("noisy")], weights, 0.5);
  assert.equal(out.verdict, "rework");
  assert.equal(out.consensusReached, false);
});

test("tallyWeighted: mix of low-weight reject + high-weight reject → reject (high carries)", () => {
  const weights = new Map([
    ["trusted", 0.8],
    ["noisy", 0.3],
  ]);
  const out = tallyWeighted([rejectR("trusted"), rejectR("noisy")], weights, 0.5);
  assert.equal(out.verdict, "reject");
});

test("tallyWeighted: unknown agent (no weight entry) defaults to 1.0 — full reject power", () => {
  const weights = new Map([["known-noisy", 0.2]]);
  const out = tallyWeighted([approveR("known-noisy"), rejectR("brand-new")], weights, 0.5);
  assert.equal(out.verdict, "reject"); // brand-new has weight 1.0 by default
});

test("tallyWeighted: all approve regardless of weights → approve", () => {
  const weights = new Map([
    ["claude", 0.1], // even with very low weight
    ["openai", 0.05],
  ]);
  const out = tallyWeighted([approveR("claude"), approveR("openai")], weights, 0.5);
  assert.equal(out.verdict, "approve");
});

test("tallyWeighted: rejectThreshold tunable", () => {
  const weights = new Map([["x", 0.4]]);
  // With threshold 0.5 → demoted
  assert.equal(tallyWeighted([rejectR("x")], weights, 0.5).verdict, "rework");
  // With threshold 0.3 → still hard-blocks
  assert.equal(tallyWeighted([rejectR("x")], weights, 0.3).verdict, "reject");
});

// ─── deriveAgentWeights ────────────────────────────────────────────────

const baseScore = (overrides) => ({
  agent: "x",
  score: 0.5,
  sampleCount: 10,
  components: { buildPass: null, reviewApproval: null, time: null, rework: null },
  componentsUsed: [],
  ...overrides,
});

test("deriveAgentWeights: < minSamples → full weight 1.0", () => {
  const weights = deriveAgentWeights([baseScore({ score: 0.1, sampleCount: 2 })]);
  assert.equal(weights.get("x"), 1.0);
});

test("deriveAgentWeights: >= minSamples → score-derived weight, clamped to floor", () => {
  const weights = deriveAgentWeights(
    [
      baseScore({ agent: "high", score: 0.9, sampleCount: 10 }),
      baseScore({ agent: "low", score: 0.05, sampleCount: 10 }), // below default floor 0.2
    ],
  );
  assert.equal(weights.get("high"), 0.9);
  assert.equal(weights.get("low"), 0.2); // floored
});

test("deriveAgentWeights: custom minSamples + floor honored", () => {
  const weights = deriveAgentWeights(
    [baseScore({ agent: "x", score: 0.4, sampleCount: 3 })],
    { minSamples: 3, floor: 0.5 },
  );
  // 3 samples meets new minSamples; 0.4 floored to 0.5
  assert.equal(weights.get("x"), 0.5);
});

test("deriveAgentWeights: scores >1 clamped to 1", () => {
  const weights = deriveAgentWeights(
    [baseScore({ agent: "x", score: 1.5, sampleCount: 10 })],
  );
  assert.equal(weights.get("x"), 1);
});

// ─── Council integration ───────────────────────────────────────────────

class FakeAgent {
  constructor(id, verdict) {
    this.id = id;
    this.displayName = id;
    this.verdict = verdict;
  }
  async review() {
    return {
      agent: this.id,
      verdict: this.verdict,
      blockers:
        this.verdict === "reject"
          ? [{ severity: "blocker", category: "x", message: "x" }]
          : [],
      summary: `${this.id}:${this.verdict}`,
    };
  }
}

test("Council: low-weight agent's reject demoted to rework", async () => {
  const council = new Council({
    agents: [new FakeAgent("trusted", "approve"), new FakeAgent("noisy", "reject")],
    maxRounds: 1,
    enableDebate: false,
    agentWeights: new Map([
      ["trusted", 0.9],
      ["noisy", 0.3],
    ]),
  });
  const ctx = { diff: "+", repo: "acme/app", pullNumber: 1, newSha: "sha" };
  const out = await council.deliberate(ctx);
  assert.equal(out.verdict, "rework");
});

test("Council: legacy behavior preserved when no agentWeights provided", async () => {
  const council = new Council({
    agents: [new FakeAgent("a", "approve"), new FakeAgent("b", "reject")],
    maxRounds: 1,
    enableDebate: false,
  });
  const ctx = { diff: "+", repo: "acme/app", pullNumber: 1, newSha: "sha" };
  const out = await council.deliberate(ctx);
  assert.equal(out.verdict, "reject"); // any reject still blocks
});

test("TieredCouncil: agentWeights flow through to tier-1 council", async () => {
  const council = new TieredCouncil({
    tier1Agents: [new FakeAgent("trusted", "approve"), new FakeAgent("noisy", "reject")],
    tier2Agents: [new FakeAgent("opus", "approve"), new FakeAgent("gpt5", "approve")],
    tier1MaxRounds: 1,
    tier2MaxRounds: 1,
    agentWeights: new Map([
      ["trusted", 0.9],
      ["noisy", 0.3],
    ]),
  });
  const ctx = { diff: "+", repo: "acme/app", pullNumber: 1, newSha: "sha" };
  const out = await council.deliberate(ctx);
  // Tier 1's noisy reject is demoted → tier 1 verdict is "rework" → escalates to tier 2.
  // Tier 2 (both approve) → approve.
  assert.equal(out.verdict, "approve");
  assert.equal(out.escalated, true);
});
