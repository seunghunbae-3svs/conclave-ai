/**
 * v0.7.1 — structured JSON emitter for `conclave review --json`.
 *
 * Purpose: `conclave autofix` (and any downstream tool — benchmarks,
 * Telegram bot, dashboards) needs a parseable verdict stream without
 * scraping ANSI-colored human output. Previously, autofix required a
 * hand-crafted verdict JSON file because there was no supported way
 * to capture the live review output programmatically. This emitter
 * closes that gap.
 *
 * Shape invariants (pinned — do NOT break at v0.7.1+):
 * - `verdict`: the council's final verdict, "approve" | "rework" | "reject"
 * - `domain`: "code" | "design" | "mixed" (matches CLI-layer resolvedDomain)
 * - `tiers`: present when TieredCouncil ran; tier-2 fields are 0/"" when no escalation
 * - `agents`: per-agent results, each with blockers + summary
 * - `metrics`: EfficiencyGate summary snapshot
 * - `episodicId`, `sha`, `repo`: traceability fields for autofix + record-outcome
 * - `prNumber`: optional (absent for plain `git diff` runs)
 * - `plainSummary`: present when plain-summary generation succeeded; optional
 *
 * Keep this emitter pure — no process.* / fs / network. Callers own stdout.
 */
import type {
  Blocker,
  MetricsSummary,
  PlainSummary,
  ReviewResult,
} from "@conclave-ai/core";

export interface ReviewJsonInput {
  repo: string;
  sha: string;
  pullNumber?: number;
  councilVerdict: "approve" | "rework" | "reject";
  domain: "code" | "design" | "mixed";
  results: readonly ReviewResult[];
  metrics: MetricsSummary;
  episodicId: string;
  /** Present when TieredCouncil was used. */
  tier?: {
    escalated: boolean;
    reason: string;
    tier1Rounds: number;
    tier2Rounds?: number;
    tier1Ids: readonly string[];
    tier2Ids: readonly string[];
    tier1Verdict: "approve" | "rework" | "reject";
    tier2Verdict?: "approve" | "rework" | "reject";
  };
  plainSummary?: PlainSummary;
}

export interface ReviewJsonOutputAgent {
  id: string;
  verdict: "approve" | "rework" | "reject";
  blockers: readonly Blocker[];
  summary: string;
}

export interface ReviewJsonOutput {
  verdict: "approve" | "rework" | "reject";
  domain: "code" | "design" | "mixed";
  tiers: {
    tier1Count: number;
    tier1Verdict: "approve" | "rework" | "reject" | "";
    tier2Count: number;
    tier2Verdict: "approve" | "rework" | "reject" | "";
  };
  agents: ReviewJsonOutputAgent[];
  metrics: {
    calls: number;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    latencyMs: number;
    cacheHitRate: number;
  };
  episodicId: string;
  sha: string;
  repo: string;
  prNumber?: number;
  plainSummary?: PlainSummary;
}

/**
 * Build the structured JSON payload. Pure function — accepts the same
 * shape `renderReview` sees plus the persisted episodic id so downstream
 * tools can call `conclave record-outcome --id <episodicId>`.
 *
 * When TieredCouncil was used, the tiers block carries actual participant
 * counts and per-tier verdicts. For flat Council runs, tier1Count = agent
 * count and tier1Verdict = councilVerdict (with tier2 zero/empty).
 */
export function buildReviewJson(input: ReviewJsonInput): ReviewJsonOutput {
  const agents: ReviewJsonOutputAgent[] = input.results.map((r) => ({
    id: r.agent,
    verdict: r.verdict,
    blockers: r.blockers,
    summary: r.summary,
  }));

  const tiers = input.tier
    ? {
        tier1Count: input.tier.tier1Ids.length,
        tier1Verdict: input.tier.tier1Verdict,
        tier2Count: input.tier.tier2Ids.length,
        tier2Verdict: (input.tier.tier2Verdict ?? "") as
          | "approve"
          | "rework"
          | "reject"
          | "",
      }
    : {
        tier1Count: input.results.length,
        tier1Verdict: input.councilVerdict,
        tier2Count: 0,
        tier2Verdict: "" as const,
      };

  const metrics = {
    calls: input.metrics.callCount,
    tokensIn: input.metrics.totalInputTokens,
    tokensOut: input.metrics.totalOutputTokens,
    costUsd: input.metrics.totalCostUsd,
    latencyMs: input.metrics.totalLatencyMs,
    cacheHitRate: input.metrics.cacheHitRate,
  };

  const out: ReviewJsonOutput = {
    verdict: input.councilVerdict,
    domain: input.domain,
    tiers,
    agents,
    metrics,
    episodicId: input.episodicId,
    sha: input.sha,
    repo: input.repo,
  };
  if (input.pullNumber !== undefined && input.pullNumber > 0) {
    out.prNumber = input.pullNumber;
  }
  if (input.plainSummary) {
    out.plainSummary = input.plainSummary;
  }
  return out;
}

/**
 * Serialize the payload for stdout. Standalone so callers can inject
 * a different JSON.stringify replacer / indent in tests.
 *
 * Always terminates with "\n" — downstream parsers can rely on
 * line-oriented framing (e.g. `process.stdout` piped through `head -1`
 * in a bash script still returns the full JSON).
 */
export function serializeReviewJson(output: ReviewJsonOutput): string {
  return JSON.stringify(output) + "\n";
}
