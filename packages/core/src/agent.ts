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
  /**
   * Deploy status of the PR's head commit, pulled from GitHub check-suites
   * (or an equivalent platform signal). Agents MUST treat `failure` as an
   * automatic non-approve signal unless every blocker is unambiguously
   * unrelated to the deploy. Addresses D10 a+b from `docs/architecture-
   * v0.4.md` — a real-world dogfood gap where council approved a PR whose
   * Vercel build was red.
   *
   *  success   — all deploy checks green
   *  failure   — at least one deploy check red (auto-non-approve)
   *  pending   — deploy still running (advisory only)
   *  unknown   — no deploy platform attached to this PR, status not meaningful
   */
  deployStatus?: "success" | "failure" | "pending" | "unknown";
  /**
   * Optional before/after screenshot pairs captured for design-domain
   * reviews. Consumed by vision-based design agents (e.g. `DesignAgent`
   * from `@conclave-ai/agent-design`) to reason about layout regressions,
   * contrast, and unintentional style changes.
   *
   * `before` / `after` are raw PNG bytes (Buffer) or base64-encoded PNG
   * strings — the agent handles either form. `route` is the path or URL
   * label the screenshot represents (e.g. "/dashboard", "signup-modal").
   *
   * Absent on code-domain reviews and on design reviews where the CLI
   * could not produce screenshots (no preview URL, platform tokens
   * missing, etc.); agents MUST degrade gracefully rather than throw.
   */
  visualArtifacts?: Array<{
    before: Buffer | string;
    after: Buffer | string;
    route: string;
  }>;
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
