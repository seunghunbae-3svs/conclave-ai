import type { ReviewContext } from "@conclave-ai/core";

export const SYSTEM_PROMPT = `You are a senior code reviewer on a multi-agent council for Conclave AI. The council reviews AI-generated code and design changes before merge.

Your goal: catch real blockers, not style nits. You work alongside other agents (Claude, Gemini, possibly domain-specific specialists). Your reviews are weighed against theirs; spurious blockers hurt your agent score and waste the rework budget.

Rules:
- Focus on: correctness, security, regression risk, missing tests for non-trivial changes, accessibility + contrast on UI, obvious performance cliffs.
- Do NOT comment on: style bikeshedding, import order, variable renames that are already consistent, personal formatting preferences.
- When you find a real issue: specify the file, line (when available), severity, and what to change. Be concrete.
- Never pad with encouragement ("great work but...") — go straight to the concerns.
- When the diff is small, low-risk, and has test coverage, approve cleanly. Over-flagging is a bigger sin than missing a nit.
- You MUST respond in the provided JSON schema. Any field marked nullable uses null when not applicable (do not omit it).`;

export function buildReviewPrompt(ctx: ReviewContext): string {
  const sections: string[] = [];
  sections.push(`# Review target`);
  sections.push(`repo: ${ctx.repo}`);
  sections.push(`pull: #${ctx.pullNumber}`);
  sections.push(`sha: ${ctx.newSha}${ctx.prevSha ? ` (from ${ctx.prevSha})` : ""}`);
  sections.push("");

  if (ctx.answerKeys && ctx.answerKeys.length > 0) {
    sections.push(`# Past success patterns (answer-keys)`);
    sections.push(
      `These are reviews that led to merged changes on similar code in this repo. Lean on them as a style + quality bar — match their tolerance for what counts as a blocker.`,
    );
    sections.push("");
    for (const entry of ctx.answerKeys.slice(0, 8)) sections.push(`- ${entry}`);
    sections.push("");
  }

  if (ctx.failureCatalog && ctx.failureCatalog.length > 0) {
    sections.push(`# Known failure patterns (failure-catalog)`);
    sections.push(
      `These are patterns that caused real incidents in the past. Flag them aggressively if you see them in this diff.`,
    );
    sections.push("");
    for (const entry of ctx.failureCatalog.slice(0, 8)) sections.push(`- ${entry}`);
    sections.push("");
  }

  sections.push(`# Diff`);
  sections.push("```diff");
  sections.push(ctx.diff || "(empty diff — respond with verdict=approve, summary noting nothing to review, blockers=[])");
  sections.push("```");
  sections.push("");

  if (ctx.priors && ctx.priors.length > 0) {
    sections.push(`# Round ${ctx.round ?? 2} — other agents' verdicts from the previous round`);
    sections.push(
      `The council is in a multi-round debate. Read each agent's verdict + blockers. Update your verdict ONLY if you see a real issue you missed, or a false-positive you can now retract. Do not mirror the majority — the dissenting voice is often the correct one.`,
    );
    sections.push("");
    for (const p of ctx.priors) {
      sections.push(`## ${p.agent}: ${p.verdict}`);
      if (p.blockers.length > 0) {
        for (const b of p.blockers.slice(0, 5)) {
          const loc = b.file ? ` (${b.file}${b.line ? ":" + b.line : ""})` : "";
          sections.push(`- [${b.severity}/${b.category}] ${b.message}${loc}`);
        }
      } else {
        sections.push(`- (no blockers)`);
      }
      sections.push("");
    }
  }

  sections.push(`Respond using the conclave_review JSON schema.`);
  return sections.join("\n");
}

export function buildCacheablePrefix(ctx: ReviewContext): string {
  const parts: string[] = [SYSTEM_PROMPT];
  if (ctx.answerKeys && ctx.answerKeys.length > 0) {
    parts.push("answer-keys:\n" + ctx.answerKeys.slice(0, 8).join("\n"));
  }
  if (ctx.failureCatalog && ctx.failureCatalog.length > 0) {
    parts.push("failure-catalog:\n" + ctx.failureCatalog.slice(0, 8).join("\n"));
  }
  return parts.join("\n---\n");
}
