/**
 * H2 #10 fullchain audit — agent score routing.
 *
 * Round-trips the FULL chain on a real on-disk store:
 *   1. Seed enough episodics for `noisy` to fall below 0.5
 *      (rejected PRs that ended up merged → bad buildPass score).
 *   2. computeAllAgentScores reads from disk.
 *   3. deriveAgentWeights produces the weights map.
 *   4. New Council instance receives the weights via constructor.
 *   5. Council.deliberate over a new PR — `noisy`'s reject demoted
 *      to advisory rework via tallyWeighted.
 *   6. Edge: brand-new agent (< minSamples) keeps full reject power.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Council,
  FileSystemMemoryStore,
  computeAllAgentScores,
  deriveAgentWeights,
} from "@conclave-ai/core";

function freshFs() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aic-h2-10-fc-"));
}
function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

class FakeAgent {
  constructor(id, verdictFn) {
    this.id = id;
    this.displayName = id;
    this.verdictFn = verdictFn;
  }
  async review(ctx) {
    return this.verdictFn(ctx);
  }
}

async function seedEpisodic({ store, prNumber, agents, councilVerdict, outcome }) {
  await store.writeEpisodic({
    id: `ep-seed-${prNumber}`,
    createdAt: new Date(2026, 3, prNumber).toISOString(),
    repo: "acme/app",
    pullNumber: prNumber,
    sha: `sha${prNumber}`,
    diffSha256: "0".repeat(64),
    reviews: agents,
    councilVerdict,
    outcome,
    costUsd: 0.01,
    cycleNumber: 1,
    solutionPatches: [],
  });
}

test("H2 #10 fullchain: noisy agent's score drops below 0.5 → its reject demoted in council", async () => {
  const root = freshFs();
  try {
    const store = new FileSystemMemoryStore({ root });

    // Seed: 10 PRs where `trusted` approves and `noisy` rejects, but
    // every PR ended up merged. That's the FP signal: noisy was wrong
    // 10 times in a row, so its buildPass component (approved-PRs-that-
    // merged) is good for `trusted` and bad for `noisy`.
    //
    // computeBuildPass measures approved-and-merged. `noisy` rejected
    // every one of these — so buildPass returns null (no approves).
    // That means buildPass doesn't penalize noisy directly. But
    // reviewApproval = approves/total = 0/10 → 0. Heavy weight.
    //
    // To pull noisy below 0.5 with the configured weights
    // (buildPass 0.4, reviewApproval 0.3, time null, rework 0.1):
    //   - reviewApproval=0 (noisy never approves) contributes 0
    //   - rework component for the SHARED episodics: those that ended
    //     in `outcome=merged` give clean rework=1 contribution
    //   - buildPass=null since noisy never approves
    //
    // Numerator over usable components for `noisy`:
    //   reviewApproval * 0.3 = 0
    //   rework         * 0.1 = 1 * 0.1 = 0.1
    //   denominator = 0.3 + 0.1 = 0.4
    //   score = 0.1 / 0.4 = 0.25 → below 0.5 ✓
    //
    // For `trusted`:
    //   reviewApproval = 1.0 (always approves)
    //   buildPass = 1.0 (all approves merged)
    //   rework = 1
    //   numerator = 1.0*0.3 + 1.0*0.4 + 1*0.1 = 0.8
    //   denominator = 0.8
    //   score = 1.0 → full weight
    for (let i = 0; i < 10; i += 1) {
      await seedEpisodic({
        store,
        prNumber: 100 + i,
        agents: [
          { agent: "trusted", verdict: "approve", blockers: [], summary: "ok" },
          {
            agent: "noisy",
            verdict: "reject",
            blockers: [{ severity: "blocker", category: "x", message: "false alarm" }],
            summary: "noisy reject",
          },
        ],
        councilVerdict: "reject",
        outcome: "merged", // user overrode — noisy was wrong
      });
    }

    const scores = await computeAllAgentScores(store);
    const noisyScore = scores.find((s) => s.agent === "noisy");
    const trustedScore = scores.find((s) => s.agent === "trusted");
    assert.ok(noisyScore, "noisy must appear in score list");
    assert.ok(trustedScore, "trusted must appear in score list");
    assert.ok(
      noisyScore.score < 0.5,
      `noisy score should be < 0.5 to trigger demotion; got ${noisyScore.score}`,
    );
    assert.ok(trustedScore.score >= 0.8, `trusted score should remain high; got ${trustedScore.score}`);

    const weights = deriveAgentWeights(scores);
    const noisyWeight = weights.get("noisy");
    const trustedWeight = weights.get("trusted");
    assert.ok(noisyWeight !== undefined && noisyWeight < 0.5, `noisy weight < 0.5; got ${noisyWeight}`);
    assert.ok(
      trustedWeight !== undefined && trustedWeight >= 0.5,
      `trusted weight >= 0.5; got ${trustedWeight}`,
    );

    // Now run a real council on a new PR. noisy rejects, trusted approves.
    // Without weights → "any reject blocks" → reject.
    // With weights → noisy demoted → rework.
    const council = new Council({
      agents: [
        new FakeAgent("trusted", async () => ({
          agent: "trusted",
          verdict: "approve",
          blockers: [],
          summary: "looks fine",
        })),
        new FakeAgent("noisy", async () => ({
          agent: "noisy",
          verdict: "reject",
          blockers: [{ severity: "blocker", category: "y", message: "false alarm again" }],
          summary: "still false",
        })),
      ],
      maxRounds: 1,
      enableDebate: false,
      agentWeights: weights,
    });
    const ctx = { diff: "+x", repo: "acme/app", pullNumber: 999, newSha: "sha-new" };
    const outcome = await council.deliberate(ctx);
    assert.equal(
      outcome.verdict,
      "rework",
      "noisy reject should demote to advisory rework via tallyWeighted",
    );
  } finally {
    cleanup(root);
  }
});

test("H2 #10 fullchain: brand-new agent (< minSamples) keeps full weight even with low-quality samples", async () => {
  const root = freshFs();
  try {
    const store = new FileSystemMemoryStore({ root });

    // Seed only 3 episodics for `newcomer`. Default minSamples = 5.
    for (let i = 0; i < 3; i += 1) {
      await seedEpisodic({
        store,
        prNumber: 100 + i,
        agents: [
          {
            agent: "newcomer",
            verdict: "reject",
            blockers: [{ severity: "blocker", category: "x", message: "x" }],
            summary: "",
          },
        ],
        councilVerdict: "reject",
        outcome: "merged", // user overrode
      });
    }

    const scores = await computeAllAgentScores(store);
    const weights = deriveAgentWeights(scores);
    const newcomerWeight = weights.get("newcomer");
    assert.equal(
      newcomerWeight,
      1.0,
      "agent under minSamples retains full weight (don't silence brand-new agents)",
    );

    const council = new Council({
      agents: [new FakeAgent("newcomer", async () => ({
        agent: "newcomer",
        verdict: "reject",
        blockers: [{ severity: "blocker", category: "x", message: "x" }],
        summary: "",
      }))],
      maxRounds: 1,
      enableDebate: false,
      agentWeights: weights,
    });
    const outcome = await council.deliberate({ diff: "+x", repo: "acme/app", pullNumber: 1, newSha: "sha" });
    assert.equal(
      outcome.verdict,
      "reject",
      "brand-new agent's reject still hard-blocks (full weight preserves voice)",
    );
  } finally {
    cleanup(root);
  }
});

test("H2 #10 fullchain: empty store → empty weights map; council falls back to legacy 'any reject blocks'", async () => {
  const root = freshFs();
  try {
    const store = new FileSystemMemoryStore({ root });
    const scores = await computeAllAgentScores(store);
    const weights = deriveAgentWeights(scores);
    assert.equal(weights.size, 0, "empty store → no weights");

    const council = new Council({
      agents: [new FakeAgent("a", async () => ({
        agent: "a",
        verdict: "reject",
        blockers: [{ severity: "blocker", category: "x", message: "x" }],
        summary: "",
      }))],
      maxRounds: 1,
      enableDebate: false,
      agentWeights: weights,
    });
    const outcome = await council.deliberate({ diff: "+x", repo: "acme/app", pullNumber: 1, newSha: "sha" });
    assert.equal(outcome.verdict, "reject", "no weight info → defaults to 1.0 → legacy 'any reject blocks' holds");
  } finally {
    cleanup(root);
  }
});
