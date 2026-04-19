import type { Blocker, ReviewResult, MetricsSummary } from "@conclave-ai/core";

export interface PrintReviewInput {
  repo: string;
  pullNumber: number;
  sha: string;
  source: string;
  councilVerdict: "approve" | "rework" | "reject";
  consensus: boolean;
  results: readonly ReviewResult[];
  metrics: MetricsSummary;
  /** Number of debate rounds executed (≥ 1). Omit for legacy 1-round flows. */
  rounds?: number;
  /** `true` when debate halted on consensus before reaching maxRounds. */
  earlyExit?: boolean;
  /** Domain label (e.g. "code", "design"). Omit for legacy flows. */
  domain?: string;
  /** Set by TieredCouncil path — tier-2 escalation state. */
  tier?: {
    escalated: boolean;
    reason: string;
    tier1Rounds: number;
    tier2Rounds?: number;
  };
}

const SEVERITY_ORDER: Record<Blocker["severity"], number> = {
  blocker: 0,
  major: 1,
  minor: 2,
  nit: 3,
};

function severityTag(s: Blocker["severity"]): string {
  switch (s) {
    case "blocker":
      return "[BLOCKER]";
    case "major":
      return "[MAJOR]  ";
    case "minor":
      return "[MINOR]  ";
    case "nit":
      return "[NIT]    ";
  }
}

function verdictTag(v: "approve" | "rework" | "reject"): string {
  switch (v) {
    case "approve":
      return "APPROVE";
    case "rework":
      return "REWORK ";
    case "reject":
      return "REJECT ";
  }
}

export function renderReview(input: PrintReviewInput): string {
  const lines: string[] = [];
  lines.push(`conclave review — ${input.repo}${input.pullNumber ? ` #${input.pullNumber}` : ""}`);
  lines.push(`  sha:    ${input.sha.slice(0, 12)}`);
  lines.push(`  source: ${input.source}`);
  lines.push("");
  lines.push(`Verdict: ${verdictTag(input.councilVerdict)}${input.consensus ? "" : "  (no consensus)"}`);
  if (input.domain) {
    lines.push(`Domain:  ${input.domain}`);
  }
  if (input.tier) {
    if (input.tier.escalated) {
      lines.push(`Tiers:   1 (${input.tier.tier1Rounds}r) → 2 (${input.tier.tier2Rounds ?? 0}r) — ${input.tier.reason}`);
    } else {
      lines.push(`Tiers:   1 (${input.tier.tier1Rounds}r) only — ${input.tier.reason}`);
    }
  } else if (input.rounds && input.rounds > 1) {
    const tail = input.earlyExit ? " (early exit on consensus)" : "";
    lines.push(`Rounds:  ${input.rounds}${tail}`);
  }
  lines.push("");

  for (const r of input.results) {
    lines.push(`── ${r.agent} → ${verdictTag(r.verdict)} ──`);
    if (r.blockers.length === 0) {
      lines.push("  (no blockers)");
    } else {
      const sorted = [...r.blockers].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
      for (const b of sorted) {
        const loc = b.file ? `  ${b.file}${b.line ? `:${b.line}` : ""}` : "";
        lines.push(`  ${severityTag(b.severity)} (${b.category})${loc}`);
        lines.push(`    ${b.message}`);
      }
    }
    if (r.summary) {
      lines.push("");
      lines.push(`  summary: ${r.summary}`);
    }
    lines.push("");
  }

  lines.push("── metrics ──");
  lines.push(`  calls:      ${input.metrics.callCount}`);
  lines.push(`  tokens:     in=${input.metrics.totalInputTokens} out=${input.metrics.totalOutputTokens}`);
  lines.push(`  cost:       $${input.metrics.totalCostUsd.toFixed(4)}`);
  lines.push(`  latency:    ${input.metrics.totalLatencyMs}ms`);
  lines.push(`  cache hit:  ${(input.metrics.cacheHitRate * 100).toFixed(1)}%`);

  return lines.join("\n") + "\n";
}

export function verdictToExitCode(v: "approve" | "rework" | "reject"): number {
  if (v === "approve") return 0;
  if (v === "rework") return 1;
  return 2;
}
