import type { EpisodicEntry } from "./memory/schema.js";
import type { MemoryStore } from "./memory/store.js";

/**
 * Agent scoring weights locked by decision #19 (ported directly from
 * solo-cto-agent where they were validated in production):
 *
 *   build pass rate        40%
 *   review approval rate   30%
 *   time to resolution     20%
 *   rework frequency       10%
 *
 * Some signals require data we don't yet collect (build outcomes from
 * CI, precise resolution timestamps). Missing components are marked
 * `null`; the final score renormalizes over the components that are
 * actually available so agents aren't penalized for missing data.
 */
export const AGENT_SCORE_WEIGHTS = {
  buildPass: 0.4,
  reviewApproval: 0.3,
  time: 0.2,
  rework: 0.1,
} as const;

export interface AgentScoreComponents {
  /** Fraction of the agent's approved reviews that eventually merged. Null = not yet tracked. */
  buildPass: number | null;
  /** Fraction of the agent's reviews where it voted `approve`. */
  reviewApproval: number | null;
  /** Fraction 0..1 — higher = faster. `null` when no resolution timestamps available. */
  time: number | null;
  /**
   * Rework-friendly score: 1 - (rework outcomes per review), clamped to
   * [0, 1]. `null` when the agent has no episodic entries with an
   * outcome yet.
   */
  rework: number | null;
}

export interface AgentScore {
  agent: string;
  /** Weighted score in [0, 1], rounded to 4 decimal places. */
  score: number;
  /** How many episodic entries fed the score. */
  sampleCount: number;
  components: AgentScoreComponents;
  /** Components that actually contributed (non-null). Ops teams watch this. */
  componentsUsed: Array<keyof AgentScoreComponents>;
}

/**
 * Compute one agent's score from a flat list of episodic entries. Each
 * entry may contain this agent's review or not; entries without the
 * agent are ignored.
 */
export function computeAgentScore(agent: string, entries: readonly EpisodicEntry[]): AgentScore {
  const relevant = entries.filter((e) => e.reviews.some((r) => r.agent === agent));
  const sampleCount = relevant.length;

  const reviewApproval = sampleCount === 0 ? null : computeReviewApproval(agent, relevant);
  const buildPass = sampleCount === 0 ? null : computeBuildPass(agent, relevant);
  const rework = sampleCount === 0 ? null : computeReworkFriendly(relevant);
  const time = null; // Not yet tracked — needs resolution timestamps beyond createdAt.

  const components: AgentScoreComponents = { buildPass, reviewApproval, time, rework };
  const { score, used } = weightAndNormalize(components);

  return {
    agent,
    score,
    sampleCount,
    components,
    componentsUsed: used,
  };
}

/**
 * Convenience: compute scores for every agent that appears anywhere in
 * the store's episodic log. Runs one pass over all episodes.
 */
export async function computeAllAgentScores(store: MemoryStore): Promise<AgentScore[]> {
  const entries = await store.listEpisodic();
  const agents = new Set<string>();
  for (const e of entries) {
    for (const r of e.reviews) agents.add(r.agent);
  }
  return [...agents].sort().map((agent) => computeAgentScore(agent, entries));
}

// ─── component calculators ─────────────────────────────────────────

/** Fraction of this agent's reviews where its individual verdict was `approve`. */
function computeReviewApproval(agent: string, entries: readonly EpisodicEntry[]): number {
  let approves = 0;
  let total = 0;
  for (const e of entries) {
    for (const r of e.reviews) {
      if (r.agent !== agent) continue;
      total += 1;
      if (r.verdict === "approve") approves += 1;
    }
  }
  return total === 0 ? 0 : approves / total;
}

/**
 * Proxy for build pass rate: of the PRs this agent approved, what
 * fraction eventually merged. If an approved PR later landed (outcome=
 * merged), the agent's call was validated. If it got rejected or
 * reworked after approval, the call was off.
 *
 * Excludes pending entries — they aren't a signal yet.
 * Returns null when no resolved-outcome approved reviews exist.
 */
function computeBuildPass(agent: string, entries: readonly EpisodicEntry[]): number | null {
  let denom = 0;
  let merged = 0;
  for (const e of entries) {
    if (e.outcome === "pending") continue;
    const thisAgentApproved = e.reviews.some((r) => r.agent === agent && r.verdict === "approve");
    if (!thisAgentApproved) continue;
    denom += 1;
    if (e.outcome === "merged") merged += 1;
  }
  return denom === 0 ? null : merged / denom;
}

/** 1 - (reworked outcomes / resolved outcomes). Null when nothing is resolved yet. */
function computeReworkFriendly(entries: readonly EpisodicEntry[]): number | null {
  let reworked = 0;
  let resolved = 0;
  for (const e of entries) {
    if (e.outcome === "pending") continue;
    resolved += 1;
    if (e.outcome === "reworked") reworked += 1;
  }
  if (resolved === 0) return null;
  const rate = reworked / resolved;
  return clamp01(1 - rate);
}

// ─── weighted normalization ────────────────────────────────────────

function weightAndNormalize(c: AgentScoreComponents): {
  score: number;
  used: Array<keyof AgentScoreComponents>;
} {
  const used: Array<keyof AgentScoreComponents> = [];
  let numerator = 0;
  let denominator = 0;
  (Object.keys(AGENT_SCORE_WEIGHTS) as Array<keyof AgentScoreComponents>).forEach((k) => {
    const v = c[k];
    if (v === null) return;
    used.push(k);
    const w = AGENT_SCORE_WEIGHTS[k];
    numerator += w * v;
    denominator += w;
  });
  const score = denominator === 0 ? 0 : numerator / denominator;
  return { score: Math.round(score * 10_000) / 10_000, used };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
