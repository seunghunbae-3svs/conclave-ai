import type { Blocker, ReviewResult, MetricsSummary } from "@ai-conclave/core";

export interface PrintReviewInput {
  repo: string;
  pullNumber: number;
  sha: string;
  source: string;
  councilVerdict: "approve" | "rework" | "reject";
  consensus: boolean;
  results: readonly ReviewResult[];
  metrics: MetricsSummary;
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
