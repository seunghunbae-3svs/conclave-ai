import { test } from "node:test";
import assert from "node:assert/strict";
import { Council } from "../dist/index.js";

function fakeAgent(id, verdict, blockers = []) {
  return {
    id,
    displayName: id,
    review: async () => ({
      agent: id,
      verdict,
      blockers,
      summary: `${id} says ${verdict}`,
    }),
  };
}

/** Agent whose verdict evolves per round, driven by a list. */
function scriptedAgent(id, script) {
  let i = 0;
  return {
    id,
    displayName: id,
    review: async () => {
      const verdict = script[Math.min(i, script.length - 1)];
      i += 1;
      return {
        agent: id,
        verdict,
        blockers: [],
        summary: `${id} round ${i} says ${verdict}`,
      };
    },
  };
}

/** Agent that records every ReviewContext it sees — used to assert that priors + round are wired. */
function recordingAgent(id, script) {
  const seen = [];
  let i = 0;
  const agent = {
    id,
    displayName: id,
    review: async (ctx) => {
      seen.push(ctx);
      const verdict = script[Math.min(i, script.length - 1)];
      i += 1;
      return { agent: id, verdict, blockers: [], summary: `${id} r${i}` };
    },
  };
  agent.seen = seen;
  return agent;
}

const ctx = { diff: "", repo: "acme/x", pullNumber: 1, newSha: "HEAD" };

test("Council: empty agents throws", () => {
  assert.throws(() => new Council({ agents: [] }));
});

test("Council: single approve → approve + consensus, 1 round", async () => {
  const council = new Council({ agents: [fakeAgent("claude", "approve")] });
  const outcome = await council.deliberate(ctx);
  assert.equal(outcome.verdict, "approve");
  assert.equal(outcome.consensusReached, true);
  assert.equal(outcome.rounds, 1);
  assert.equal(outcome.results.length, 1);
});

test("Council: all approve → approve, early exit round 1", async () => {
  const council = new Council({
    agents: [fakeAgent("claude", "approve"), fakeAgent("openai", "approve")],
  });
  const outcome = await council.deliberate(ctx);
  assert.equal(outcome.verdict, "approve");
  assert.equal(outcome.consensusReached, true);
  assert.equal(outcome.rounds, 1);
  assert.equal(outcome.earlyExit, true);
});

test("Council: any reject → reject + consensus, early exit round 1", async () => {
  const council = new Council({
    agents: [fakeAgent("claude", "approve"), fakeAgent("openai", "reject")],
  });
  const outcome = await council.deliberate(ctx);
  assert.equal(outcome.verdict, "reject");
  assert.equal(outcome.consensusReached, true);
  assert.equal(outcome.rounds, 1);
});

test("Council: mixed approve + rework with no movement → rework, runs full 3 rounds", async () => {
  const council = new Council({
    agents: [fakeAgent("claude", "approve"), fakeAgent("openai", "rework")],
  });
  const outcome = await council.deliberate(ctx);
  assert.equal(outcome.verdict, "rework");
  assert.equal(outcome.consensusReached, false);
  assert.equal(outcome.rounds, 3);
  assert.equal(outcome.earlyExit, false);
  assert.ok(Array.isArray(outcome.roundHistory));
  assert.equal(outcome.roundHistory.length, 3);
});

test("Council: debate reaches consensus in round 2 (agent changes mind)", async () => {
  const council = new Council({
    agents: [
      // stays approve every round
      scriptedAgent("claude", ["approve", "approve", "approve"]),
      // rework in round 1, flips to approve in round 2 after seeing priors
      scriptedAgent("openai", ["rework", "approve", "approve"]),
    ],
  });
  const outcome = await council.deliberate(ctx);
  assert.equal(outcome.verdict, "approve");
  assert.equal(outcome.consensusReached, true);
  assert.equal(outcome.rounds, 2);
  assert.equal(outcome.earlyExit, true);
  assert.equal(outcome.roundHistory.length, 2);
});

test("Council: round 2+ passes priors + round number to agents", async () => {
  const a = recordingAgent("a", ["rework", "rework", "rework"]);
  const b = recordingAgent("b", ["approve", "approve", "approve"]);
  const council = new Council({ agents: [a, b] });
  await council.deliberate(ctx);

  // Round 1 contexts should have no priors
  assert.equal(a.seen[0].round, 1);
  assert.equal(a.seen[0].priors, undefined);
  assert.equal(b.seen[0].priors, undefined);

  // Round 2 contexts should have priors from round 1
  assert.equal(a.seen[1].round, 2);
  assert.equal(a.seen[1].priors.length, 2);
  const priorAgents = a.seen[1].priors.map((p) => p.agent).sort();
  assert.deepEqual(priorAgents, ["a", "b"]);
  const aPrior = a.seen[1].priors.find((p) => p.agent === "a");
  assert.equal(aPrior.verdict, "rework");
  const bPrior = a.seen[1].priors.find((p) => p.agent === "b");
  assert.equal(bPrior.verdict, "approve");

  // Round 3 should see priors from round 2
  assert.equal(a.seen[2].round, 3);
  assert.equal(a.seen[2].priors.length, 2);
});

test("Council: enableDebate=false preserves 1-round behavior", async () => {
  const council = new Council({
    agents: [
      scriptedAgent("claude", ["rework", "approve"]),
      scriptedAgent("openai", ["approve", "approve"]),
    ],
    enableDebate: false,
  });
  const outcome = await council.deliberate(ctx);
  assert.equal(outcome.rounds, 1);
  assert.equal(outcome.verdict, "rework"); // mixed verdicts in round 1, no debate allowed to resolve
  assert.equal(outcome.consensusReached, false);
});

test("Council: maxRounds caps the loop even when no consensus reached", async () => {
  const council = new Council({
    agents: [fakeAgent("a", "approve"), fakeAgent("b", "rework")],
    maxRounds: 5,
  });
  const outcome = await council.deliberate(ctx);
  assert.equal(outcome.rounds, 5);
  assert.equal(outcome.consensusReached, false);
  assert.equal(outcome.roundHistory.length, 5);
});

test("Council: consensus in the final round still sets earlyExit=false", async () => {
  // Round 1 + 2 = rework; Round 3 = approve. consensus in the LAST permitted round.
  const council = new Council({
    agents: [
      scriptedAgent("a", ["approve", "approve", "approve"]),
      scriptedAgent("b", ["rework", "rework", "approve"]),
    ],
    maxRounds: 3,
  });
  const outcome = await council.deliberate(ctx);
  assert.equal(outcome.verdict, "approve");
  assert.equal(outcome.consensusReached, true);
  assert.equal(outcome.rounds, 3);
  assert.equal(outcome.earlyExit, false);
});

test("Council: roundHistory preserves each round's verdict + results", async () => {
  const council = new Council({
    agents: [
      scriptedAgent("a", ["rework", "approve", "approve"]),
      scriptedAgent("b", ["approve", "approve", "approve"]),
    ],
  });
  const outcome = await council.deliberate(ctx);
  assert.equal(outcome.roundHistory[0].verdict, "rework");
  assert.equal(outcome.roundHistory[0].consensusReached, false);
  assert.equal(outcome.roundHistory[1].verdict, "approve");
  assert.equal(outcome.roundHistory[1].consensusReached, true);
  assert.equal(outcome.roundHistory[0].results.length, 2);
});

test("Council: priors carry blockers so agents can respond to specific issues", async () => {
  const agentWithBlockers = {
    id: "a",
    displayName: "a",
    review: async () => ({
      agent: "a",
      verdict: "rework",
      blockers: [
        { severity: "major", category: "security", message: "missing auth check", file: "x.ts", line: 42 },
      ],
      summary: "a says rework",
    }),
  };
  const recorder = recordingAgent("b", ["approve", "approve", "approve"]);
  const council = new Council({ agents: [agentWithBlockers, recorder] });
  await council.deliberate(ctx);
  const r2Priors = recorder.seen[1].priors;
  const aBlocker = r2Priors.find((p) => p.agent === "a").blockers[0];
  assert.equal(aBlocker.message, "missing auth check");
  assert.equal(aBlocker.file, "x.ts");
  assert.equal(aBlocker.line, 42);
});

test("Council: exposes config (agentCount, roundLimit, debateEnabled)", async () => {
  const council = new Council({
    agents: [fakeAgent("a", "approve"), fakeAgent("b", "approve")],
    maxRounds: 5,
  });
  assert.equal(council.agentCount, 2);
  assert.equal(council.roundLimit, 5);
  assert.equal(council.debateEnabled, true);

  const legacy = new Council({ agents: [fakeAgent("a", "approve")], enableDebate: false });
  assert.equal(legacy.debateEnabled, false);
});

// ---------------------------------------------------------------------
// Agent-failure isolation (Promise.allSettled — P0 regression test)
// ---------------------------------------------------------------------

function throwingAgent(id, err) {
  return {
    id,
    displayName: id,
    review: async () => {
      throw err instanceof Error ? err : new Error(String(err));
    },
  };
}

test("Council: one agent throwing does NOT kill the rest of the council", async () => {
  const council = new Council({
    agents: [
      throwingAgent("gemini", "429 Too Many Requests (free tier exhausted)"),
      fakeAgent("claude", "approve"),
      fakeAgent("openai", "approve"),
    ],
  });
  const outcome = await council.deliberate(ctx);
  assert.equal(outcome.results.length, 3, "failed agent still surfaces a synthetic result");
  const failed = outcome.results.find((r) => r.agent === "gemini");
  assert.ok(failed);
  assert.equal(failed.verdict, "rework");
  assert.equal(failed.blockers[0].category, "agent-failure");
  assert.match(failed.blockers[0].message, /429/);
});

test("Council: partial failure + mixed verdicts → no consensus, runs full rounds", async () => {
  const council = new Council({
    agents: [
      throwingAgent("gemini", "timeout"),
      fakeAgent("claude", "approve"),
      fakeAgent("openai", "rework"),
    ],
  });
  const outcome = await council.deliberate(ctx);
  // gemini injected as rework → 1 approve + 2 rework → rework, no consensus
  assert.equal(outcome.verdict, "rework");
  assert.equal(outcome.consensusReached, false);
});

test("Council: all agents failing → throws with aggregated reasons", async () => {
  const council = new Council({
    agents: [
      throwingAgent("a", "network unreachable"),
      throwingAgent("b", "invalid api key"),
    ],
  });
  await assert.rejects(
    () => council.deliberate(ctx),
    /all agents failed.*network unreachable.*invalid api key/s,
  );
});
