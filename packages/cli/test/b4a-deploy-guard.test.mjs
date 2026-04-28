/**
 * Phase B.4a — deploy-status guard.
 *
 * User-reported failure mode: "deploy에 실패했는데 완성됐다고 merge."
 *
 * Today the deploy=failure signal is communicated to agents via prompt
 * text only — strict instruction "do NOT vote approve unless every
 * blocker is unambiguously unrelated to the deploy." That's a SOFT
 * guarantee; LLMs occasionally ignore it especially when the diff
 * itself looks clean.
 *
 * This test pins down the contract: when council returns approve AND
 * deployStatus=failure, the CLI MUST enforce a hard verdict downgrade
 * before propagating to record-outcome / notification / merge button.
 *
 * The first test (red) exercises the gap so we know this is real.
 * The second tests run after the guard is added.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDeployGuard } from "../dist/lib/deploy-guard.js";

test("B.4a: deploy=failure + approve verdict → forced to rework with synthetic blocker", () => {
  const before = {
    verdict: "approve",
    rounds: 1,
    results: [
      { agent: "claude", verdict: "approve", blockers: [], summary: "looks fine" },
      { agent: "openai", verdict: "approve", blockers: [], summary: "ok" },
    ],
    consensusReached: true,
  };
  const after = applyDeployGuard(before, "failure");
  assert.equal(after.outcome.verdict, "rework", "approve must be downgraded on deploy=failure");
  assert.equal(after.applied, true);
  // Synthetic blocker injected so users see WHY the verdict flipped.
  const allBlockers = after.outcome.results.flatMap((r) => r.blockers);
  assert.ok(
    allBlockers.some((b) => b.category === "deploy-failure"),
    "must inject deploy-failure blocker so the message renders correctly",
  );
});

test("B.4a: deploy=failure + reject verdict → unchanged (already non-approve)", () => {
  const before = {
    verdict: "reject",
    rounds: 1,
    results: [
      {
        agent: "claude",
        verdict: "reject",
        blockers: [{ severity: "blocker", category: "security", message: "x" }],
        summary: "",
      },
    ],
    consensusReached: true,
  };
  const after = applyDeployGuard(before, "failure");
  assert.equal(after.outcome.verdict, "reject");
  assert.equal(after.applied, false, "no need to apply guard when already non-approve");
});

test("B.4a: deploy=failure + rework verdict → unchanged", () => {
  const before = {
    verdict: "rework",
    rounds: 1,
    results: [
      {
        agent: "claude",
        verdict: "rework",
        blockers: [{ severity: "major", category: "x", message: "x" }],
        summary: "",
      },
    ],
    consensusReached: false,
  };
  const after = applyDeployGuard(before, "failure");
  assert.equal(after.outcome.verdict, "rework");
  assert.equal(after.applied, false);
});

test("B.4a: deploy=success + approve → guard does nothing", () => {
  const before = {
    verdict: "approve",
    rounds: 1,
    results: [{ agent: "claude", verdict: "approve", blockers: [], summary: "" }],
    consensusReached: true,
  };
  const after = applyDeployGuard(before, "success");
  assert.equal(after.outcome.verdict, "approve");
  assert.equal(after.applied, false);
});

test("B.4a: deploy=pending + approve → guard does nothing (pending is advisory, not blocking)", () => {
  const before = {
    verdict: "approve",
    rounds: 1,
    results: [{ agent: "claude", verdict: "approve", blockers: [], summary: "" }],
    consensusReached: true,
  };
  const after = applyDeployGuard(before, "pending");
  assert.equal(after.outcome.verdict, "approve");
  assert.equal(after.applied, false);
});

test("B.4a: deploy=unknown + approve → guard does nothing (no platform attached)", () => {
  const before = {
    verdict: "approve",
    rounds: 1,
    results: [{ agent: "claude", verdict: "approve", blockers: [], summary: "" }],
    consensusReached: true,
  };
  const after = applyDeployGuard(before, "unknown");
  assert.equal(after.outcome.verdict, "approve");
  assert.equal(after.applied, false);
});

test("B.4a: deploy=failure + approve, undefined deployStatus passed → guard does nothing (no signal)", () => {
  const before = {
    verdict: "approve",
    rounds: 1,
    results: [{ agent: "claude", verdict: "approve", blockers: [], summary: "" }],
    consensusReached: true,
  };
  const after = applyDeployGuard(before, undefined);
  assert.equal(after.outcome.verdict, "approve");
  assert.equal(after.applied, false);
});
