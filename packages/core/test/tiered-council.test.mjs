import { test } from "node:test";
import assert from "node:assert/strict";
import { TieredCouncil } from "../dist/index.js";

function fakeAgent(id, verdict, blockers = [], summary) {
  return {
    id,
    displayName: id,
    review: async () => ({
      agent: id,
      verdict,
      blockers,
      summary: summary ?? `${id} says ${verdict}`,
    }),
  };
}

/**
 * Records every ReviewContext each agent sees — lets us assert tier
 * number + priors propagation.
 */
function recordingAgent(id, verdict, blockers = []) {
  const seen = [];
  const agent = {
    id,
    displayName: id,
    review: async (ctx) => {
      seen.push(ctx);
      return { agent: id, verdict, blockers, summary: `${id}` };
    },
  };
  agent.seen = seen;
  return agent;
}

const ctx = { diff: "", repo: "acme/x", pullNumber: 1, newSha: "HEAD" };
const ctxDesign = { ...ctx, domain: "design" };
const ctxCode = { ...ctx, domain: "code" };

// ---------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------

test("TieredCouncil: throws when tier1Agents empty", () => {
  assert.throws(
    () => new TieredCouncil({ tier1Agents: [], tier2Agents: [fakeAgent("o", "approve")] }),
  );
});

test("TieredCouncil: empty tier2 is permitted (tier-1-only mode)", () => {
  const c = new TieredCouncil({
    tier1Agents: [fakeAgent("a", "approve")],
    tier2Agents: [],
  });
  assert.equal(c.tier1Count, 1);
  assert.equal(c.tier2Count, 0);
});

// ---------------------------------------------------------------------
// Escalation rule
// ---------------------------------------------------------------------

test("TieredCouncil: tier-1 clean approve → no escalation", async () => {
  const c = new TieredCouncil({
    tier1Agents: [fakeAgent("a", "approve"), fakeAgent("b", "approve")],
    tier2Agents: [fakeAgent("opus", "approve")],
  });
  const out = await c.deliberate(ctxCode);
  assert.equal(out.escalated, false);
  assert.equal(out.verdict, "approve");
  assert.equal(out.tier1Outcome.verdict, "approve");
  assert.equal(out.tier2Outcome, undefined);
  assert.match(out.escalationReason, /clean approve/);
});

test("TieredCouncil: tier-1 rework → escalate to tier 2", async () => {
  const c = new TieredCouncil({
    tier1Agents: [fakeAgent("a", "approve"), fakeAgent("b", "rework")],
    tier2Agents: [fakeAgent("opus", "approve"), fakeAgent("gpt5.4", "approve")],
  });
  const out = await c.deliberate(ctxCode);
  assert.equal(out.escalated, true);
  assert.equal(out.verdict, "approve"); // tier-2 overrides
  assert.ok(out.tier2Outcome);
  assert.match(out.escalationReason, /verdict=rework/);
});

test("TieredCouncil: tier-1 reject → escalate to tier 2", async () => {
  const c = new TieredCouncil({
    tier1Agents: [fakeAgent("a", "approve"), fakeAgent("b", "reject")],
    tier2Agents: [fakeAgent("opus", "rework"), fakeAgent("gpt5.4", "rework")],
  });
  const out = await c.deliberate(ctxCode);
  assert.equal(out.escalated, true);
  assert.equal(out.verdict, "rework"); // tier-2 overrides
  assert.match(out.escalationReason, /verdict=reject/);
});

test("TieredCouncil: MAJOR blocker → escalate even if tier-1 verdict=approve", async () => {
  const c = new TieredCouncil({
    tier1Agents: [
      fakeAgent("a", "approve", [{ severity: "major", category: "security", message: "real issue" }]),
      fakeAgent("b", "approve"),
    ],
    tier2Agents: [fakeAgent("opus", "rework"), fakeAgent("gpt5.4", "rework")],
  });
  const out = await c.deliberate(ctxCode);
  assert.equal(out.escalated, true);
  assert.equal(out.verdict, "rework");
  assert.match(out.escalationReason, /major blocker/);
});

test("TieredCouncil: BLOCKER severity escalates even on approve verdict", async () => {
  const c = new TieredCouncil({
    tier1Agents: [
      fakeAgent("a", "approve", [{ severity: "blocker", category: "security", message: "rce" }]),
    ],
    tier2Agents: [fakeAgent("opus", "reject")],
  });
  const out = await c.deliberate(ctxCode);
  assert.equal(out.escalated, true);
  assert.match(out.escalationReason, /blocker blocker|blocker/);
});

test("TieredCouncil: only MINOR blocker does NOT escalate on approve", async () => {
  const c = new TieredCouncil({
    tier1Agents: [
      fakeAgent("a", "approve", [{ severity: "minor", category: "style", message: "nit" }]),
      fakeAgent("b", "approve", [{ severity: "nit", category: "style", message: "really nit" }]),
    ],
    tier2Agents: [fakeAgent("opus", "reject")],
  });
  const out = await c.deliberate(ctxCode);
  assert.equal(out.escalated, false);
  assert.equal(out.verdict, "approve");
});

test("TieredCouncil: design domain ALWAYS escalates (even on clean approve)", async () => {
  const c = new TieredCouncil({
    tier1Agents: [fakeAgent("a", "approve"), fakeAgent("b", "approve")],
    tier2Agents: [fakeAgent("opus", "approve"), fakeAgent("gpt5.4", "approve")],
  });
  const out = await c.deliberate(ctxDesign);
  assert.equal(out.escalated, true);
  assert.match(out.escalationReason, /design/);
});

test("TieredCouncil: alwaysEscalate=true forces escalation on clean code approve", async () => {
  const c = new TieredCouncil({
    tier1Agents: [fakeAgent("a", "approve")],
    tier2Agents: [fakeAgent("opus", "approve")],
    alwaysEscalate: true,
  });
  const out = await c.deliberate(ctxCode);
  assert.equal(out.escalated, true);
  assert.match(out.escalationReason, /alwaysEscalate/);
});

// ---------------------------------------------------------------------
// Tier wiring — priors + tier field propagation
// ---------------------------------------------------------------------

test("TieredCouncil: tier-2 agents receive tier-1 priors on their first-round call", async () => {
  const t1a = fakeAgent("cheap-a", "approve", [
    { severity: "major", category: "perf", message: "N+1 query" },
  ]);
  const t1b = fakeAgent("cheap-b", "rework");
  const t2 = recordingAgent("opus", "rework");
  const c = new TieredCouncil({ tier1Agents: [t1a, t1b], tier2Agents: [t2] });
  await c.deliberate(ctxCode);

  // tier-2 may run multiple rounds if no consensus; what matters is that the
  // FIRST tier-2 round sees the tier-1 result set as priors.
  assert.ok(t2.seen.length >= 1);
  const firstCall = t2.seen[0];
  assert.equal(firstCall.tier, 2);
  assert.ok(Array.isArray(firstCall.priors));
  assert.equal(firstCall.priors.length, 2);
  const cheapA = firstCall.priors.find((p) => p.agent === "cheap-a");
  assert.equal(cheapA.verdict, "approve");
  assert.equal(cheapA.blockers[0].message, "N+1 query");
  const cheapB = firstCall.priors.find((p) => p.agent === "cheap-b");
  assert.equal(cheapB.verdict, "rework");
});

test("TieredCouncil: tier-1 agents see tier=1 in context", async () => {
  const t1 = recordingAgent("cheap", "approve");
  const c = new TieredCouncil({
    tier1Agents: [t1],
    tier2Agents: [fakeAgent("opus", "approve")],
  });
  await c.deliberate(ctxCode);
  assert.equal(t1.seen[0].tier, 1);
});

test("TieredCouncil: tier-1-only mode ships tier-1 verdict with a note when design forces escalate", async () => {
  const c = new TieredCouncil({
    tier1Agents: [fakeAgent("a", "approve")],
    tier2Agents: [],
  });
  const out = await c.deliberate(ctxDesign);
  assert.equal(out.escalated, false); // no tier-2 to escalate into
  assert.match(out.escalationReason, /no tier-2/);
  assert.equal(out.verdict, "approve"); // tier-1 ships
});

// ---------------------------------------------------------------------
// Round counts
// ---------------------------------------------------------------------

test("TieredCouncil: tier1MaxRounds=1 by default (single drafting pass)", async () => {
  const t1a = fakeAgent("a", "approve");
  const t1b = fakeAgent("b", "rework");
  const c = new TieredCouncil({
    tier1Agents: [t1a, t1b],
    tier2Agents: [fakeAgent("opus", "approve")],
  });
  const out = await c.deliberate(ctxCode);
  assert.equal(out.tier1Outcome.rounds, 1);
});

test("TieredCouncil: tier2MaxRounds=2 by default", async () => {
  const c = new TieredCouncil({
    tier1Agents: [fakeAgent("a", "rework")],
    tier2Agents: [fakeAgent("opus", "approve"), fakeAgent("gpt5.4", "rework")],
  });
  const out = await c.deliberate(ctxCode);
  assert.equal(out.escalated, true);
  // mixed verdicts → no consensus → runs full 2 rounds
  assert.equal(out.tier2Outcome.rounds, 2);
});

test("TieredCouncil: custom round counts honored", async () => {
  const c = new TieredCouncil({
    tier1Agents: [fakeAgent("a", "rework"), fakeAgent("b", "approve")],
    tier2Agents: [fakeAgent("opus", "rework"), fakeAgent("gpt5.4", "approve")],
    tier1MaxRounds: 2,
    tier2MaxRounds: 3,
  });
  const out = await c.deliberate(ctxCode);
  assert.equal(out.tier1Outcome.rounds, 2);
  assert.equal(out.tier2Outcome.rounds, 3);
});

// ---------------------------------------------------------------------
// Output shape contract
// ---------------------------------------------------------------------

test("TieredCouncil: outcome's top-level shape matches CouncilOutcome (backward-compat surface)", async () => {
  const c = new TieredCouncil({
    tier1Agents: [fakeAgent("a", "approve")],
    tier2Agents: [fakeAgent("opus", "approve")],
  });
  const out = await c.deliberate(ctxCode);
  assert.ok("verdict" in out);
  assert.ok("results" in out);
  assert.ok("consensusReached" in out);
  assert.ok("rounds" in out);
  // plus the tiered extensions
  assert.ok("escalated" in out);
  assert.ok("tier1Outcome" in out);
  assert.ok("escalationReason" in out);
});

test("TieredCouncil: results field reflects tier-2 when escalated, tier-1 when not", async () => {
  const tier1Agents = [fakeAgent("cheap", "rework")];
  const tier2Agents = [fakeAgent("opus", "approve")];
  const c = new TieredCouncil({ tier1Agents, tier2Agents });
  const out = await c.deliberate(ctxCode);
  assert.equal(out.escalated, true);
  assert.equal(out.results[0].agent, "opus"); // tier-2 result surfaces at top

  const c2 = new TieredCouncil({
    tier1Agents: [fakeAgent("cheap", "approve")],
    tier2Agents: [fakeAgent("opus", "approve")],
  });
  const out2 = await c2.deliberate(ctxCode);
  assert.equal(out2.escalated, false);
  assert.equal(out2.results[0].agent, "cheap"); // tier-1 result surfaces at top
});
