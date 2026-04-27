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

/**
 * Mode of the review. v0.6.0 adds "audit" — a whole-file, whole-project
 * health check rather than a PR-diff review. Agents should switch their
 * prompts to treat the file contents as already-shipped code and call
 * out real issues (a11y, security, regression risk, token drift, etc.)
 * rather than reasoning about "what changed".
 *
 * Absent ≡ "review" for backward compatibility with every pre-v0.6
 * caller of Council / TieredCouncil / the individual agents.
 */
export type ReviewMode = "review" | "audit";

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
   * "review" (default) or "audit". When "audit", the `diff` field carries
   * the full current contents of the batched files (not a unified diff),
   * and agents are expected to identify issues in the code as-shipped.
   * See `ReviewMode` for the rationale.
   */
  mode?: ReviewMode;
  /**
   * v0.6 audit-mode hint — the list of file paths whose contents are
   * packed into `diff`. Lets agents attribute blockers precisely without
   * having to parse the (non-standard, non-unified) payload themselves.
   * Omitted on review-mode calls.
   */
  auditFiles?: readonly string[];
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
  /**
   * v0.6.4 — project-wide context. Injected into every agent (code + design)
   * so reviews can judge against product intent, not just the diff.
   * Combines the head of the repo README with the full contents of
   * `.conclave/project-context.md`. Loaded by the CLI before council
   * deliberation; agents should prepend it as a `# Project context`
   * section above the diff / audit payload.
   *
   * Absent when neither source file exists. Agents MUST degrade
   * gracefully (omit the section) rather than treat absence as an error.
   */
  projectContext?: string;
  /**
   * v0.6.4 — design-only intent (brand, tone, persona, a11y target).
   * Passed to DesignAgent only; read from `.conclave/design-context.md`.
   * Absent on code-only reviews and when the file is missing.
   */
  designContext?: string;
  /**
   * v0.6.4 — design-only reference images representing brand "good".
   * Read from `.conclave/design-reference/*.png` (up to 4, ≤ 500KB each
   * by default). Passed to DesignAgent as additional vision content
   * blocks labeled "Brand reference" — distinct from `visualArtifacts`
   * (which is the PR-specific before/after pair).
   *
   * `bytes` is raw PNG bytes. Absent when the directory is empty or
   * missing.
   */
  designReferences?: Array<{ filename: string; bytes: Buffer | Uint8Array }>;
  /**
   * v0.13.22 — design system baseline drift pairs. Each entry is a
   * (baseline, after) screenshot pair for a route where a stored baseline
   * exists in `.conclave/design/baseline/`. DesignAgent uses these to
   * detect color token mismatch, layout regression, contrast changes, and
   * cropped text relative to the golden design system state.
   *
   * `diffRatio` is an optional pre-computed pixelmatch ratio (0..1) for
   * the baseline→after pair — included as a fast quantitative signal.
   * Absent when the pixel diff step was skipped.
   *
   * Populated by `conclave review --visual` when baselines exist on disk.
   * Absent when no baselines have been captured yet.
   */
  designBaselineDrift?: Array<{
    route: string;
    baseline: Buffer | string;
    after: Buffer | string;
    diffRatio?: number;
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
