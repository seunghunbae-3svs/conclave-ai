/**
 * Audit-mode output formatters (v0.6.0).
 *
 * Three targets:
 *   - "stdout": ANSI-colored human summary. Reuses tone of renderReview.
 *   - "json":   machine-readable bundle (no colors).
 *   - "issue":  GitHub-issue markdown body, grouped by severity + category
 *               + subsystem. Matches the "headline feature" spec.
 *
 * Aggregation is identical across targets — they diverge only in the
 * serializer. Dedup key = (file, lineRange, category, severity). When
 * two agents flag the same (file, line, category) we collapse them into
 * one entry and attribute the message with `agents: [claude, openai]`.
 */

import type { Blocker, MetricsSummary, ReviewResult } from "@conclave-ai/core";
import type { AuditCategory, DiscoveredFile } from "./audit-discovery.js";

export interface PerBatchResult {
  batchIndex: number;
  files: readonly DiscoveredFile[];
  results: readonly ReviewResult[];
  costUsd: number;
  latencyMs: number;
}

export interface AggregatedFinding {
  severity: Blocker["severity"];
  category: string;
  file: string;
  line?: number;
  message: string;
  agents: string[];
  /** Subsystem derived from the file path (ui / code / infra / docs). */
  subsystem: AuditCategory;
}

export interface AuditReport {
  repo: string;
  sha: string;
  scope: string;
  domain: string;
  filesAudited: number;
  filesInScope: number;
  sampled: boolean;
  discoveryReason: string;
  findings: AggregatedFinding[];
  perAgentVerdict: Array<{
    agent: string;
    approvedBatches: number;
    reworkBatches: number;
    rejectBatches: number;
  }>;
  budgetUsd: number;
  spentUsd: number;
  budgetExhausted: boolean;
  batchesRun: number;
  batchesTotal: number;
  metrics: MetricsSummary;
}

const SEVERITY_ORDER: Record<Blocker["severity"], number> = {
  blocker: 0,
  major: 1,
  minor: 2,
  nit: 3,
};

const CATEGORY_ORDER: readonly string[] = [
  "security",
  "a11y",
  "correctness",
  "regression",
  "token-drift",
  "dead-code",
  "performance",
  "semantic-html",
  "layout",
  "responsive",
  "interaction-state",
  "contrast",
  "overflow",
  "test-coverage",
  "docs",
];

/**
 * Aggregate per-batch review results into a single deduped finding list.
 * Dedup key: normalize file path, round line to nearest 5-line range,
 * category + severity literal. Agents are merged into an attribution
 * array rather than producing duplicate entries.
 */
export function aggregateFindings(
  batches: readonly PerBatchResult[],
  fileToCategory: Map<string, AuditCategory>,
): AggregatedFinding[] {
  const acc = new Map<string, AggregatedFinding>();
  for (const batch of batches) {
    for (const res of batch.results) {
      for (const b of res.blockers) {
        const file = b.file ?? "(unknown)";
        const lineBucket = b.line !== undefined ? Math.floor(b.line / 5) * 5 : -1;
        const key = `${file}::${lineBucket}::${b.category}::${b.severity}`;
        const existing = acc.get(key);
        const subsystem = fileToCategory.get(file) ?? inferSubsystemFromPath(file);
        if (existing) {
          if (!existing.agents.includes(res.agent)) existing.agents.push(res.agent);
          // Keep the longest / most-specific message.
          if (b.message.length > existing.message.length) existing.message = b.message;
          continue;
        }
        const finding: AggregatedFinding = {
          severity: b.severity,
          category: b.category,
          file,
          message: b.message,
          agents: [res.agent],
          subsystem,
        };
        if (b.line !== undefined) finding.line = b.line;
        acc.set(key, finding);
      }
    }
  }
  const all = Array.from(acc.values());
  all.sort((a, b) => {
    const s = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (s !== 0) return s;
    const ca = CATEGORY_ORDER.indexOf(a.category);
    const cb = CATEGORY_ORDER.indexOf(b.category);
    const cDelta = (ca < 0 ? 999 : ca) - (cb < 0 ? 999 : cb);
    if (cDelta !== 0) return cDelta;
    return a.file.localeCompare(b.file);
  });
  return all;
}

function inferSubsystemFromPath(p: string): AuditCategory {
  const lower = p.toLowerCase();
  if (/\.(tsx|jsx|vue|svelte|astro|css|scss|html)$/.test(lower)) return "ui";
  if (/\.(ya?ml|toml|tf|dockerfile)$/.test(lower) || lower.includes(".github/workflows/")) return "infra";
  if (/\.(md|mdx|rst|txt)$/.test(lower)) return "docs";
  return "code";
}

// ─── stdout renderer ──────────────────────────────────────────────────

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

export function renderAuditStdout(report: AuditReport): string {
  const lines: string[] = [];
  lines.push(`conclave audit — ${report.repo}`);
  lines.push(`  sha:    ${report.sha.slice(0, 12)}`);
  lines.push(`  scope:  ${report.scope}   domain: ${report.domain}`);
  lines.push(
    `  files:  ${report.filesAudited} audited / ${report.filesInScope} in scope${report.sampled ? " (sampled)" : ""}`,
  );
  lines.push(`          ${report.discoveryReason}`);
  lines.push(
    `  batches: ${report.batchesRun}/${report.batchesTotal}${report.budgetExhausted ? "  (BUDGET EXHAUSTED)" : ""}`,
  );
  lines.push("");

  const bySeverity = groupBy(report.findings, (f) => f.severity);
  const blockers = bySeverity.get("blocker") ?? [];
  const majors = bySeverity.get("major") ?? [];
  const minors = bySeverity.get("minor") ?? [];
  const nits = bySeverity.get("nit") ?? [];

  lines.push(
    `Findings: ${blockers.length} blockers / ${majors.length} major / ${minors.length} minor / ${nits.length} nit`,
  );
  lines.push("");

  if (report.findings.length === 0) {
    lines.push("  (no findings — audit came back clean)");
    lines.push("");
  }

  for (const f of report.findings) {
    const loc = f.line ? `  ${f.file}:${f.line}` : `  ${f.file}`;
    const attr = f.agents.length > 1 ? `  [${f.agents.join(", ")}]` : "";
    lines.push(`  ${severityTag(f.severity)} (${f.category} / ${f.subsystem})${loc}${attr}`);
    lines.push(`    ${f.message}`);
  }
  lines.push("");

  lines.push("── per-agent verdicts ──");
  for (const v of report.perAgentVerdict) {
    lines.push(
      `  ${v.agent.padEnd(8)}  approve=${v.approvedBatches}  rework=${v.reworkBatches}  reject=${v.rejectBatches}`,
    );
  }
  lines.push("");

  lines.push("── metrics ──");
  lines.push(`  calls:      ${report.metrics.callCount}`);
  lines.push(`  tokens:     in=${report.metrics.totalInputTokens} out=${report.metrics.totalOutputTokens}`);
  lines.push(`  cost:       $${report.metrics.totalCostUsd.toFixed(4)} of $${report.budgetUsd.toFixed(2)} budget`);
  lines.push(`  latency:    ${report.metrics.totalLatencyMs}ms`);
  lines.push(`  cache hit:  ${(report.metrics.cacheHitRate * 100).toFixed(1)}%`);

  return lines.join("\n") + "\n";
}

// ─── JSON renderer ────────────────────────────────────────────────────

export function renderAuditJson(report: AuditReport): string {
  return JSON.stringify(report, null, 2) + "\n";
}

// ─── GitHub-issue renderer ────────────────────────────────────────────

export function renderAuditIssueBody(report: AuditReport): string {
  const date = new Date().toISOString().slice(0, 10);
  const sections: string[] = [];
  sections.push(`## Conclave Project Audit — ${date}`);
  sections.push("");
  sections.push(`**Repo:** \`${report.repo}\`  `);
  sections.push(`**SHA:** \`${report.sha.slice(0, 12)}\`  `);
  sections.push(`**Scope:** \`${report.scope}\` (domain: \`${report.domain}\`)  `);
  sections.push(
    `**Coverage:** ${report.filesAudited} audited / ${report.filesInScope} in scope${report.sampled ? "  _(sampled)_" : ""}`,
  );
  sections.push(
    `**Batches:** ${report.batchesRun}/${report.batchesTotal}${report.budgetExhausted ? " _(budget exhausted — partial result)_" : ""}`,
  );
  sections.push("");

  // Top-line summary
  const bySeverity = groupBy(report.findings, (f) => f.severity);
  const counts = {
    blocker: (bySeverity.get("blocker") ?? []).length,
    major: (bySeverity.get("major") ?? []).length,
    minor: (bySeverity.get("minor") ?? []).length,
    nit: (bySeverity.get("nit") ?? []).length,
  };
  sections.push(`### Summary`);
  sections.push(
    `| Severity | Count |\n|---|---|\n| Blocker | ${counts.blocker} |\n| Major | ${counts.major} |\n| Minor | ${counts.minor} |\n| Nit | ${counts.nit} |`,
  );
  sections.push("");

  // Top blockers (first): severity desc
  if (report.findings.length === 0) {
    sections.push(`_No findings — audit came back clean._`);
    sections.push("");
  } else {
    sections.push(`### Top blockers (by severity)`);
    const topN = report.findings.slice(0, 10);
    for (const f of topN) {
      const loc = f.line ? `\`${f.file}:${f.line}\`` : `\`${f.file}\``;
      const attr = f.agents.length > 1 ? ` _(${f.agents.join(", ")})_` : "";
      sections.push(`- **${f.severity.toUpperCase()}** \`${f.category}\` — ${loc}${attr}`);
      sections.push(`  ${f.message}`);
    }
    sections.push("");

    // Grouped by category
    sections.push(`### Grouped by category`);
    const byCategory = groupBy(report.findings, (f) => f.category);
    for (const [cat, items] of sortedMap(byCategory, (a, b) => {
      const ai = CATEGORY_ORDER.indexOf(a);
      const bi = CATEGORY_ORDER.indexOf(b);
      return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
    })) {
      sections.push(`<details><summary><code>${cat}</code> — ${items.length} findings</summary>`);
      sections.push("");
      for (const f of items) {
        const loc = f.line ? `${f.file}:${f.line}` : f.file;
        sections.push(`- \`${f.severity}\` \`${loc}\` — ${f.message}`);
      }
      sections.push("</details>");
      sections.push("");
    }

    // Grouped by subsystem
    sections.push(`### Grouped by subsystem`);
    const bySub = groupBy(report.findings, (f) => f.subsystem);
    for (const [sub, items] of bySub) {
      sections.push(`<details><summary><code>${sub}</code> — ${items.length} findings</summary>`);
      sections.push("");
      for (const f of items) {
        const loc = f.line ? `${f.file}:${f.line}` : f.file;
        sections.push(`- \`${f.severity}\` \`${f.category}\` \`${loc}\` — ${f.message}`);
      }
      sections.push("</details>");
      sections.push("");
    }
  }

  // Per-agent verdicts
  sections.push(`### Per-agent verdicts`);
  sections.push(`| Agent | Approve | Rework | Reject |`);
  sections.push(`|---|---|---|---|`);
  for (const v of report.perAgentVerdict) {
    sections.push(`| ${v.agent} | ${v.approvedBatches} | ${v.reworkBatches} | ${v.rejectBatches} |`);
  }
  sections.push("");

  // Stats
  sections.push(`### Cost + latency`);
  sections.push(
    `- **Spend:** $${report.metrics.totalCostUsd.toFixed(4)} of $${report.budgetUsd.toFixed(2)} budget`,
  );
  sections.push(`- **Calls:** ${report.metrics.callCount}`);
  sections.push(
    `- **Tokens:** in=${report.metrics.totalInputTokens}, out=${report.metrics.totalOutputTokens}`,
  );
  sections.push(`- **Latency:** ${report.metrics.totalLatencyMs}ms`);
  sections.push(`- **Cache hit:** ${(report.metrics.cacheHitRate * 100).toFixed(1)}%`);
  sections.push("");
  sections.push(`_Generated by [conclave audit](https://www.npmjs.com/package/@conclave-ai/cli)._`);

  return sections.join("\n");
}

// ─── small utils ──────────────────────────────────────────────────────

function groupBy<T, K>(items: readonly T[], key: (t: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const it of items) {
    const k = key(it);
    const arr = out.get(k) ?? [];
    arr.push(it);
    out.set(k, arr);
  }
  return out;
}

function sortedMap<K, V>(m: Map<K, V>, cmp: (a: K, b: K) => number): Array<[K, V]> {
  return Array.from(m.entries()).sort((a, b) => cmp(a[0], b[0]));
}
