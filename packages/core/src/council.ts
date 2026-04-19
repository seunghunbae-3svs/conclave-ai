import type { Agent, PriorReview, ReviewContext, ReviewResult } from "./agent.js";

export interface CouncilOptions {
  agents: Agent[];
  /** Cap on rounds. Default 3 (per decision #7). */
  maxRounds?: number;
  /** Set `false` to preserve legacy single-round behavior. Default `true`. */
  enableDebate?: boolean;
}

/**
 * Per-round snapshot — kept in `CouncilOutcome.roundHistory` for
 * observability. Notifiers + UI can render "Round 1 was reject, Round 2
 * flipped to rework after Claude withdrew blocker X" without Council
 * having to expose round-level behavior as a first-class contract.
 */
export interface RoundOutcome {
  round: number;
  results: ReviewResult[];
  verdict: "approve" | "rework" | "reject";
  consensusReached: boolean;
}

export interface CouncilOutcome {
  verdict: "approve" | "rework" | "reject";
  /** 1-indexed count of rounds actually executed (≤ maxRounds). */
  rounds: number;
  /**
   * FINAL-round results. Matches legacy shape so existing consumers
   * (notifiers, memory writer, CLI renderer) keep working without
   * knowing a debate happened.
   */
  results: ReviewResult[];
  consensusReached: boolean;
  /** Per-round detail, newest last. Omitted for legacy 1-round flows. */
  roundHistory?: RoundOutcome[];
  /** `true` if the loop halted on consensus before `maxRounds`. */
  earlyExit?: boolean;
}

/**
 * Council — orchestrates N agents across up to `maxRounds` of review.
 *
 * Round 1: each agent reviews independently. If consensus (all approve
 * OR any reject) → early-exit, return round-1 result.
 *
 * Round 2+: each agent re-reviews with `ctx.priors` populated from the
 * previous round's results. Agents MAY update their verdict based on
 * arguments they missed, or hold firm. Early-exit on consensus still
 * applies. After `maxRounds`, return whatever the last round produced.
 *
 * Agents that ignore `ctx.priors` simply restate their original verdict
 * — harmless; the debate just doesn't move them. Agents that use the
 * field (claude/openai/gemini all render `priors` into their prompts)
 * can actually change their mind on new arguments.
 */
export class Council {
  private readonly agents: Agent[];
  private readonly maxRounds: number;
  private readonly enableDebate: boolean;

  constructor(opts: CouncilOptions) {
    if (opts.agents.length === 0) {
      throw new Error("Council requires at least one agent");
    }
    this.agents = opts.agents;
    this.maxRounds = opts.maxRounds ?? 3;
    this.enableDebate = opts.enableDebate ?? true;
  }

  async deliberate(ctx: ReviewContext): Promise<CouncilOutcome> {
    const roundCap = this.enableDebate ? this.maxRounds : 1;
    const roundHistory: RoundOutcome[] = [];
    let priors: PriorReview[] = [];
    let lastResults: ReviewResult[] = [];
    let lastVerdict: CouncilOutcome["verdict"] = "rework";
    let lastConsensus = false;

    for (let round = 1; round <= roundCap; round++) {
      const roundCtx: ReviewContext = { ...ctx, round };
      if (priors.length > 0) roundCtx.priors = priors;
      // Promise.allSettled — one agent failing (rate-limit, network blip,
      // provider 5xx) must NOT kill the rest of the council. Failed
      // agents drop out of this round; their failure is logged to
      // stderr and their result is synthesized as verdict="rework" with
      // a single blocker so upstream consumers still see the signal.
      const settled = await Promise.allSettled(this.agents.map((a) => a.review(roundCtx)));
      const results: ReviewResult[] = [];
      settled.forEach((s, i) => {
        if (s.status === "fulfilled") {
          results.push(s.value);
          return;
        }
        const agent = this.agents[i];
        if (!agent) return;
        const err = s.reason instanceof Error ? s.reason : new Error(String(s.reason));
        process.stderr.write(
          `Council: ${agent.id} failed in round ${round} — ${err.message.slice(0, 300)}\n`,
        );
        results.push({
          agent: agent.id,
          verdict: "rework",
          blockers: [
            {
              severity: "major",
              category: "agent-failure",
              message: `${agent.displayName} failed: ${err.message.slice(0, 200)}`,
            },
          ],
          summary: `${agent.displayName} errored during round ${round} and was excluded from the tally.`,
        });
      });
      // Throw only if ALL agents failed — otherwise continue with the survivors.
      const anySucceeded = settled.some((s) => s.status === "fulfilled");
      if (!anySucceeded) {
        const reasons = settled
          .map((s, i) =>
            s.status === "rejected"
              ? `${this.agents[i]?.id ?? "?"}: ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`
              : null,
          )
          .filter(Boolean)
          .join("; ");
        throw new Error(`Council: all agents failed in round ${round} — ${reasons}`);
      }
      const tally = this.tally(results);
      roundHistory.push({
        round,
        results,
        verdict: tally.verdict,
        consensusReached: tally.consensusReached,
      });
      lastResults = results;
      lastVerdict = tally.verdict;
      lastConsensus = tally.consensusReached;

      if (tally.consensusReached) {
        return {
          verdict: tally.verdict,
          rounds: round,
          results,
          consensusReached: true,
          roundHistory,
          earlyExit: round < roundCap,
        };
      }

      priors = results.map((r) => {
        const p: PriorReview = { agent: r.agent, verdict: r.verdict, blockers: r.blockers };
        if (r.summary) p.summary = r.summary;
        return p;
      });
    }

    return {
      verdict: lastVerdict,
      rounds: roundCap,
      results: lastResults,
      consensusReached: lastConsensus,
      roundHistory,
      earlyExit: false,
    };
  }

  /**
   * Consensus rule (stable across v2.0 per decision #7):
   *   - All approve → approve, consensus.
   *   - Any reject → reject, consensus. One agent flagging a hard block
   *     is load-bearing; we don't outvote it.
   *   - Otherwise → rework, no consensus.
   */
  private tally(
    results: readonly ReviewResult[],
  ): { verdict: CouncilOutcome["verdict"]; consensusReached: boolean } {
    const verdicts = results.map((r) => r.verdict);
    const allApprove = verdicts.every((v) => v === "approve");
    const anyReject = verdicts.some((v) => v === "reject");
    const verdict: CouncilOutcome["verdict"] = anyReject
      ? "reject"
      : allApprove
        ? "approve"
        : "rework";
    return { verdict, consensusReached: allApprove || anyReject };
  }

  get agentCount(): number {
    return this.agents.length;
  }

  get roundLimit(): number {
    return this.maxRounds;
  }

  get debateEnabled(): boolean {
    return this.enableDebate;
  }
}
