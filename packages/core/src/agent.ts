export type Severity = "blocker" | "major" | "minor" | "nit";

export interface Blocker {
  severity: Severity;
  category: string;
  message: string;
  file?: string;
  line?: number;
}

/**
 * PriorReview — a compact view of another agent's result, passed back as
 * context in Round 2+ of a multi-round debate (decision #7).
 * Intentionally a subset of ReviewResult: token / cost fields drop so
 * the wire stays small and agents focus on blockers + reasoning.
 */
export interface PriorReview {
  agent: string;
  verdict: "approve" | "rework" | "reject";
  blockers: Blocker[];
  summary?: string;
}

/**
 * Domain of the review. Drives tier-aware routing in `TieredCouncil`
 * (design always escalates to tier-2; code escalates conditionally).
 * Absent ≡ "code" for backward compat with legacy `Council` callers.
 */
export type ReviewDomain = "code" | "design";

export interface ReviewContext {
  diff: string;
  repo: string;
  pullNumber: number;
  prevSha?: string;
  newSha: string;
  answerKeys?: string[];
  failureCatalog?: string[];
  /** 1-indexed round number. Absent ≡ first (or only) round. */
  round?: number;
  /** Other agents' results from the previous round. Used only in Round 2+. */
  priors?: PriorReview[];
  /** "code" (default) or "design" — see `ReviewDomain`. */
  domain?: ReviewDomain;
  /**
   * Tier number, 1-indexed. Set by `TieredCouncil` when it calls agents
   * so prompts + agent scoring can attribute results to the correct tier.
   * Legacy flat-Council callers leave this undefined.
   */
  tier?: 1 | 2;
}

export interface ReviewResult {
  agent: string;
  verdict: "approve" | "rework" | "reject";
  blockers: Blocker[];
  summary: string;
  tokensUsed?: number;
  costUsd?: number;
}

export interface Agent {
  readonly id: string;
  readonly displayName: string;
  review(ctx: ReviewContext): Promise<ReviewResult>;
}
