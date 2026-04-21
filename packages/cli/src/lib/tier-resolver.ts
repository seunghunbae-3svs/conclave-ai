/**
 * Tier-resolver — pure, testable computation of the tier-1 / tier-2
 * agent-id lists (and per-tier model overrides) for a given resolved
 * review domain, given the per-domain config blocks.
 *
 * Lives in `lib/` rather than inside `commands/review.ts` so the
 * merge + safety-net logic can be unit-tested without spinning up
 * the full review pipeline.
 *
 * The key rule this module encodes — and the v0.6.2 regression fix —
 * is the **mixed-domain design safety net**:
 *
 *   When `resolvedDomain === "mixed"` (UI signal hit in the diff),
 *   the Design agent MUST appear in tier-1. Pre-v0.5.0-alpha.1 configs
 *   written by the old `conclave init` wizard set
 *   `domains.design.tier1: ["claude", "openai", "gemini"]` without a
 *   literal `"design"` entry. In that case the naive merge of
 *   `code.tier1 ∪ design.tier1` produces no DesignAgent, the Council
 *   never calls DesignAgent.review(), and the rendered verdict silently
 *   omits the `design → ...` section.
 *
 *   We inject `"design"` at the head of tier-1 for mixed runs whenever
 *   it's absent, so legacy configs don't need a migration to get the
 *   Design review back. Same safety net applies to tier-2 when it's
 *   non-empty, since design's `alwaysEscalate: true` makes tier-2 the
 *   binding verdict for mixed runs.
 *
 * Users who explicitly want a design-free mixed run can either pass
 * `--domain code` or disable auto-detect (`autoDetect.enabled: false`).
 */

/**
 * Per-domain config shape we care about here. Matches the Zod-inferred
 * `ConclaveConfig.council.domains[<name>]` without the extra bits
 * `tier-resolver` doesn't need (tier*MaxRounds, alwaysEscalate — those
 * stay in review.ts where the Council is actually constructed).
 */
export interface DomainTierCfg {
  readonly tier1: readonly string[];
  readonly tier2: readonly string[];
  readonly models?: {
    readonly tier1?: Readonly<Record<string, string>>;
    readonly tier2?: Readonly<Record<string, string>>;
  };
}

export type ResolvedDomain = "code" | "design" | "mixed";

export interface ResolveTierInput {
  readonly resolvedDomain: ResolvedDomain;
  readonly codeDomainCfg?: DomainTierCfg | undefined;
  readonly designDomainCfg?: DomainTierCfg | undefined;
}

export interface ResolveTierOutput {
  readonly tier1Ids: readonly string[];
  readonly tier2Ids: readonly string[];
  readonly tier1Models: Readonly<Record<string, string>>;
  readonly tier2Models: Readonly<Record<string, string>>;
}

function pushUnique(seen: Set<string>, out: string[], ids: readonly string[] | undefined): void {
  if (!ids) return;
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
}

/**
 * Compute the merged, dedup'd, design-safety-net'd tier-1 and tier-2
 * agent id lists for a resolved review domain.
 *
 * `resolvedDomain === "code"` → pulls tier1/tier2 from `codeDomainCfg` only.
 * `resolvedDomain === "design"` → pulls from `designDomainCfg` only.
 * `resolvedDomain === "mixed"` → unions code.tier* ∪ design.tier* with
 *   code first, design-only additions appended, then auto-injects
 *   `"design"` at the head of tier-1 (and tier-2 when non-empty) if it
 *   isn't already present.
 *
 * Returns empty arrays rather than throwing when the relevant config
 * block is absent — callers decide how to handle that (review.ts falls
 * back to legacy flat-Council when `useTiered === false`).
 */
export function resolveTierIds(input: ResolveTierInput): ResolveTierOutput {
  const { resolvedDomain, codeDomainCfg, designDomainCfg } = input;

  const mergeTier = (pick: (c: DomainTierCfg) => readonly string[]): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    if (resolvedDomain === "mixed") {
      if (codeDomainCfg) pushUnique(seen, out, pick(codeDomainCfg));
      if (designDomainCfg) pushUnique(seen, out, pick(designDomainCfg));
    } else if (resolvedDomain === "code") {
      if (codeDomainCfg) pushUnique(seen, out, pick(codeDomainCfg));
    } else {
      if (designDomainCfg) pushUnique(seen, out, pick(designDomainCfg));
    }
    return out;
  };

  const tier1Ids = mergeTier((c) => c.tier1 ?? []);
  const tier2Ids = mergeTier((c) => c.tier2 ?? []);

  // v0.6.2 safety net — see module comment above for full rationale.
  if (resolvedDomain === "mixed" && !tier1Ids.includes("design")) {
    tier1Ids.unshift("design");
  }
  if (
    resolvedDomain === "mixed" &&
    tier2Ids.length > 0 &&
    !tier2Ids.includes("design")
  ) {
    tier2Ids.unshift("design");
  }

  const mergeModels = (
    tier: "tier1" | "tier2",
  ): Record<string, string> => {
    if (resolvedDomain === "code") {
      return { ...(codeDomainCfg?.models?.[tier] ?? {}) };
    }
    if (resolvedDomain === "design") {
      return { ...(designDomainCfg?.models?.[tier] ?? {}) };
    }
    // mixed — design overrides code. Design's model picks are tuned
    // for design work; code agents keep whichever override code
    // supplied unless design explicitly pinned the same agent.
    return {
      ...(codeDomainCfg?.models?.[tier] ?? {}),
      ...(designDomainCfg?.models?.[tier] ?? {}),
    };
  };

  return {
    tier1Ids,
    tier2Ids,
    tier1Models: mergeModels("tier1"),
    tier2Models: mergeModels("tier2"),
  };
}
