import type { NotifyReviewInput } from "@ai-conclave/core";

const VERDICT_LABEL: Record<"approve" | "rework" | "reject", string> = {
  approve: "APPROVE",
  rework: "REWORK",
  reject: "REJECT",
};

const VERDICT_COLOR: Record<"approve" | "rework" | "reject", string> = {
  approve: "#16a34a",
  rework: "#d97706",
  reject: "#dc2626",
};

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

/** Escape HTML-special chars for the html body. */
function h(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function severityOrder(s: "blocker" | "major" | "minor" | "nit"): number {
  return { blocker: 0, major: 1, minor: 2, nit: 3 }[s];
}

/** Render a NotifyReviewInput to plaintext + HTML email bodies. */
export function renderEmail(input: NotifyReviewInput): RenderedEmail {
  const { outcome, ctx, totalCostUsd, prUrl, episodicId } = input;
  const subject = `[conclave] ${VERDICT_LABEL[outcome.verdict]} — ${ctx.repo}${ctx.pullNumber ? ` #${ctx.pullNumber}` : ""}`;

  const textLines: string[] = [];
  textLines.push(
    `Verdict: ${VERDICT_LABEL[outcome.verdict]}${outcome.consensusReached ? "" : " (no consensus reached)"}`,
  );
  textLines.push(`Repo:    ${ctx.repo}${ctx.pullNumber ? ` #${ctx.pullNumber}` : ""}`);
  textLines.push(`SHA:     ${ctx.newSha.slice(0, 12)}`);
  if (prUrl) textLines.push(`PR:      ${prUrl}`);
  textLines.push("");
  for (const r of outcome.results) {
    textLines.push(`── ${r.agent} → ${VERDICT_LABEL[r.verdict]} ──`);
    if (r.blockers.length === 0) textLines.push("  (no blockers)");
    else {
      const sorted = [...r.blockers]
        .sort((a, b) => severityOrder(a.severity) - severityOrder(b.severity))
        .slice(0, 5);
      for (const b of sorted) {
        const where = b.file ? `  ${b.file}${b.line ? `:${b.line}` : ""}` : "";
        textLines.push(`  [${b.severity.toUpperCase()}] (${b.category})${where}`);
        textLines.push(`    ${b.message}`);
      }
      if (r.blockers.length > 5) textLines.push(`  ... +${r.blockers.length - 5} more`);
    }
    if (r.summary) textLines.push(`  summary: ${r.summary}`);
    textLines.push("");
  }
  textLines.push(`cost: $${totalCostUsd.toFixed(4)} · episodic: ${episodicId}`);
  const text = textLines.join("\n");

  // HTML rendering — self-contained, no external CSS, email-safe.
  const htmlSections: string[] = [];
  htmlSections.push(
    `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#111;max-width:640px;margin:0 auto;padding:16px;">`,
  );
  htmlSections.push(
    `<h2 style="margin:0 0 8px 0;color:${VERDICT_COLOR[outcome.verdict]}">${h(VERDICT_LABEL[outcome.verdict])} — ${h(ctx.repo)}${ctx.pullNumber ? ` #${ctx.pullNumber}` : ""}</h2>`,
  );
  if (!outcome.consensusReached) htmlSections.push(`<p style="color:#555;margin:0 0 8px 0"><em>no consensus reached</em></p>`);
  if (prUrl) {
    htmlSections.push(
      `<p style="margin:0 0 16px 0"><a href="${h(prUrl)}" style="color:#2563eb">${h(prUrl)}</a></p>`,
    );
  }
  for (const r of outcome.results) {
    htmlSections.push(
      `<h3 style="margin:16px 0 4px 0">${h(r.agent)} → <span style="color:${VERDICT_COLOR[r.verdict]}">${h(VERDICT_LABEL[r.verdict])}</span></h3>`,
    );
    if (r.blockers.length === 0) {
      htmlSections.push(`<p style="color:#666;margin:0"><em>(no blockers)</em></p>`);
    } else {
      const sorted = [...r.blockers]
        .sort((a, b) => severityOrder(a.severity) - severityOrder(b.severity))
        .slice(0, 5);
      htmlSections.push(`<ul style="margin:4px 0 0 0;padding-left:20px">`);
      for (const b of sorted) {
        const where = b.file ? ` <code style="background:#f3f4f6;padding:2px 4px">${h(b.file)}${b.line ? `:${b.line}` : ""}</code>` : "";
        htmlSections.push(
          `<li><strong>${h(b.severity)}</strong> (${h(b.category)})${where}<br/>${h(b.message)}</li>`,
        );
      }
      if (r.blockers.length > 5) htmlSections.push(`<li><em>+${r.blockers.length - 5} more</em></li>`);
      htmlSections.push(`</ul>`);
    }
    if (r.summary) {
      htmlSections.push(
        `<p style="color:#444;margin:8px 0 0 0"><em>${h(r.summary)}</em></p>`,
      );
    }
  }
  htmlSections.push(
    `<hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0"/>` +
      `<p style="color:#6b7280;font-size:12px;margin:0">` +
      `cost $${totalCostUsd.toFixed(4)} · episodic <code>${h(episodicId)}</code>` +
      `</p>` +
      `</div>`,
  );
  const html = htmlSections.join("");

  return { subject, text, html };
}
