import type { Agent, PriorReview, ReviewContext, ReviewDomain } from "./agent.js";
import { Council, type CouncilOutcome } from "./council.js";

export interface TieredCouncilOptions {
  /** Draft council — cheap/fast agents. Runs first. */
  tier1Agents: Agent[];
  /**
   * Authoritative council — flagship cross-review agents. Runs when
   * tier 1 can't produce a clean approve (or `alwaysEscalate` / design
   * domain forces it). Required even if `alwaysEscalate: false`;
   * the TieredCouncil will throw during construction if tier-2 is
   * empty AND there's any path that could trigger escalation.
   */
  tier2Agents: Agent[];
  /** Default 1 — tier 1 is a single drafting pass. */
  tier1MaxRounds?: number;
  /** Default 2 — tier 2 is short cross-review debate between flagships. */
  tier2MaxRounds?: number;
  /** Default false. Set true to force every review to escalate. */
  alwaysEscalate?: boolean;
}

/**
 * Per-tier CouncilOutcome breakout. The top-level `verdict`,
 * `consensusReached`, `results` mirror whichever tier produced the
 * authoritative answer (tier 2 when escalated, tier 1 otherwise) —
 * the same shape legacy flat-Council consumers already expect.
 */
export interface TieredCouncilOutcome extends CouncilOutcome {
  /** `true` iff tier 2 ran. */
  escalated: boolean;
  /** Raw tier-1 outcome. Always present. */
  tier1Outcome: CouncilOutcome;
  /** Raw tier-2 outcome. Present iff `escalated === true`. */
  tier2Outcome?: CouncilOutcome;
  /**
   * Short string describing why escalation happened (or didn't). Useful
   * for ops dashboards + the "tier-2 called on >60% of reviews"
   * rebalance trigger from the reopen doc.
   */
  escalationReason: string;
}

/**
 * TieredCouncil — composes two `Council` instances into a tier-1 /
 * tier-2 escalation flow. Per the 2-tier reopen (decisions #7 / #26 /
 * #28 — see docs/decision-status.md):
 *
 *   Tier 1 (draft, 1-round default, parallel):
 *     cheap/fast agents — Sonnet + GPT-5 mini + Gemini 2.5 Pro etc.
 *     (+ Grok and/or Ollama opt-in)
 *
 *   Escalation rule:
 *     - domain === "design"       → always escalate
 *     - alwaysEscalate === true   → always escalate
 *     - tier-1 verdict !== "approve" → escalate
 *     - any tier-1 blocker >= "major" → escalate
 *     - otherwise                 → ship tier-1 verdict
 *
 *   Tier 2 (authoritative, 2-round default, cross-review):
 *     Opus 4.7 + GPT-5.4 debating with tier-1 priors in context.
 *     Final verdict is binding.
 *
 * The class composes two `Council` instances rather than reimplementing
 * round logic — early-exit on consensus, priors passing, and rounds
 * metering are unchanged from decision #7's original implementation.
 */
export class TieredCouncil {
  private readonly tier1Council: Council;
  private readonly tier2Council: Council;
  private readonly tier1HasAgents: boolean;
  private readonly tier2HasAgents: boolean;
  private readonly alwaysEscalate: boolean;

  constructor(opts: TieredCouncilOptions) {
    this.tier1HasAgents = opts.tier1Agents.length > 0;
    this.tier2HasAgents = opts.tier2Agents.length > 0;
    if (!this.tier1HasAgents) {
      throw new Error("TieredCouncil: tier1Agents must be non-empty");
    }
    this.alwaysEscalate = opts.alwaysEscalate ?? false;
    this.tier1Council = new Council({
      agents: opts.tier1Agents,
      maxRounds: opts.tier1MaxRounds ?? 1,
    });
    // Tier 2 may be empty if the user is running tier-1-only on a
    // domain that never escalates (idea-like workflows). Guard against
    // accidental escalation into an empty tier-2 at runtime.
    this.tier2Council = new Council({
      // Use a sentinel stub if tier2Agents is empty — we won't call it
      // unless shouldEscalate forces tier 2. Council's constructor
      // throws on empty-agents, so use a one-element placeholder
      // `never-runs` guard.
      agents: this.tier2HasAgents ? opts.tier2Agents : [unreachableAgent],
      maxRounds: opts.tier2MaxRounds ?? 2,
    });
  }

  async deliberate(ctx: ReviewContext): Promise<TieredCouncilOutcome> {
    const tier1Ctx: ReviewContext = { ...ctx, tier: 1 };
    const tier1Outcome = await this.tier1Council.deliberate(tier1Ctx);

    const escalationReason = this.escalationReason(tier1Outcome, ctx.domain);
    const shouldEscalate = escalationReason !== null;

    if (!shouldEscalate) {
      return {
        ...tier1Outcome,
        escalated: false,
        tier1Outcome,
        escalationReason: "tier-1 clean approve",
      };
    }

    if (!this.tier2HasAgents) {
      // Domain wanted escalation but no tier-2 configured. Ship tier-1
      // with a clear note rather than silently dropping the signal.
      return {
        ...tier1Outcome,
        escalated: false,
        tier1Outcome,
        escalationReason: `would-escalate (${escalationReason}) — no tier-2 agents configured, shipping tier-1 verdict`,
      };
    }

    const tier2Priors: PriorReview[] = tier1Outcome.results.map((r) => {
      const p: PriorReview = {
        agent: r.agent,
        verdict: r.verdict,
        blockers: r.blockers,
      };
      if (r.summary) p.summary = r.summary;
      return p;
    });
    const tier2Ctx: ReviewContext = {
      ...ctx,
      tier: 2,
      priors: tier2Priors,
    };
    const tier2Outcome = await this.tier2Council.deliberate(tier2Ctx);

    return {
      ...tier2Outcome,
      escalated: true,
      tier1Outcome,
      tier2Outcome,
      escalationReason,
    };
  }

  /**
   * Return the reason escalation should happen, or `null` to ship tier-1.
   * Centralized so callers (dashboards, `conclave scores --tier-stats`)
   * can surface the exact reason each review escalated.
   */
  private escalationReason(
    tier1: CouncilOutcome,
    domain: ReviewDomain | undefined,
  ): string | null {
    if (this.alwaysEscalate) return "alwaysEscalate=true";
    if (domain === "design") return "domain=design (mid-tier misses visual polish)";
    if (tier1.verdict === "reject") return "tier-1 verdict=reject";
    if (tier1.verdict === "rework") return "tier-1 verdict=rework";
    for (const r of tier1.results) {
      for (const b of r.blockers) {
        if (b.severity === "blocker" || b.severity === "major") {
          return `tier-1 ${b.severity} blocker (${r.agent}): ${b.category}`;
        }
      }
    }
    return null;
  }

  get tier1Count(): number {
    return this.tier1Council.agentCount;
  }

  get tier2Count(): number {
    return this.tier2HasAgents ? this.tier2Council.agentCount : 0;
  }
}

/**
 * Sentinel agent used only to satisfy Council's non-empty-agents
 * invariant when tier 2 is intentionally empty. If deliberate ever
 * reaches it, the TieredCouncil guard above has failed — throw
 * loudly.
 */
const unreachableAgent: Agent = {
  id: "tiered-council-unreachable",
  displayName: "unreachable",
  review: async () => {
    throw new Error(
      "TieredCouncil: attempted to call tier-2 but no tier-2 agents were configured. This is a bug — the escalation guard should have returned the tier-1 outcome instead.",
    );
  },
};
