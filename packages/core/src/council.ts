import type { Agent, ReviewContext, ReviewResult } from "./agent.js";

export interface CouncilOptions {
  agents: Agent[];
  maxRounds?: number;
}

export interface CouncilOutcome {
  verdict: "approve" | "rework" | "reject";
  rounds: number;
  results: ReviewResult[];
  consensusReached: boolean;
}

/**
 * Council — orchestrates N agents across up to `maxRounds` of review.
 *
 * This is a skeleton. The real Mastra-graph implementation (3-round A/B/C
 * debate with early-exit on agreement, rework dispatch, efficiency-gate
 * routing) lands in a subsequent PR. For now, Council runs a single round
 * and returns each agent's individual verdict.
 */
export class Council {
  private readonly agents: Agent[];
  private readonly maxRounds: number;

  constructor(opts: CouncilOptions) {
    if (opts.agents.length === 0) {
      throw new Error("Council requires at least one agent");
    }
    this.agents = opts.agents;
    this.maxRounds = opts.maxRounds ?? 3;
  }

  async deliberate(ctx: ReviewContext): Promise<CouncilOutcome> {
    const results = await Promise.all(this.agents.map((a) => a.review(ctx)));
    const verdicts = results.map((r) => r.verdict);
    const allApprove = verdicts.every((v) => v === "approve");
    const anyReject = verdicts.some((v) => v === "reject");
    const verdict: CouncilOutcome["verdict"] = anyReject
      ? "reject"
      : allApprove
      ? "approve"
      : "rework";
    return {
      verdict,
      rounds: 1,
      results,
      consensusReached: allApprove || anyReject,
    };
  }

  get agentCount(): number {
    return this.agents.length;
  }

  get roundLimit(): number {
    return this.maxRounds;
  }
}
