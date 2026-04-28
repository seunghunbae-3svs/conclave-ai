import type { Blocker, CouncilOutcome, ReviewResult } from "@conclave-ai/core";

/**
 * Phase B.4a — hard programmatic guard against the user-reported
 * failure mode: "deploy에 실패했는데 완성됐다고 merge".
 *
 * The agent prompts already instruct "deployStatus=failure → do NOT
 * approve", but that's a soft guarantee; LLMs occasionally vote approve
 * anyway when the diff itself looks clean. This guard runs AFTER
 * council.deliberate (and before the failure-gate / record-outcome
 * stages) so the verdict propagated to record-outcome / Telegram
 * notifications / merge buttons CANNOT be approve when the deploy is
 * red.
 *
 * Semantic:
 *   - deployStatus="failure" + verdict="approve" → force to "rework" +
 *     inject a synthetic deploy-failure blocker (so users see WHY the
 *     downgrade happened in the rendered message).
 *   - Any other shape → outcome unchanged, applied=false.
 *
 * The synthetic blocker is on a new `deploy-guard` agent slot so it's
 * obvious in renders that this came from the CLI guard, not a council
 * member's vote.
 */

export interface DeployGuardResult {
  outcome: CouncilOutcome;
  /** True iff the guard injected a deploy-failure blocker AND downgraded the verdict. */
  applied: boolean;
}

export function applyDeployGuard(
  outcome: CouncilOutcome,
  deployStatus: "success" | "failure" | "pending" | "unknown" | undefined,
): DeployGuardResult {
  if (deployStatus !== "failure") return { outcome, applied: false };
  if (outcome.verdict !== "approve") return { outcome, applied: false };

  const synthetic: ReviewResult = {
    agent: "deploy-guard",
    verdict: "rework",
    blockers: [
      {
        severity: "major",
        category: "deploy-failure",
        message:
          "Deploy is red on this commit. The council voted approve but the runtime check is failing — " +
          "do NOT merge until the deploy turns green or the failure is unambiguously shown to be unrelated to this diff.",
      } satisfies Blocker,
    ],
    summary: "Hard CLI guard: deploy=failure forced verdict from approve → rework",
  };
  return {
    outcome: {
      ...outcome,
      verdict: "rework",
      results: [...outcome.results, synthetic],
      consensusReached: false,
    },
    applied: true,
  };
}
