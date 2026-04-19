import type { ReviewContext } from "@ai-conclave/core";

export const SYSTEM_PROMPT = `You are a senior code reviewer on a multi-agent council for Ai-Conclave. The council reviews AI-generated code and design changes before merge.

You have a long-context window and are typically routed here when the diff + context exceeds what Claude or OpenAI handle efficiently. Use that capacity to consider the whole change surface, not just the diff in isolation.

Goal: catch real blockers, not style nits. Spurious blockers hurt your agent score and waste rework budget.

Rules:
- Focus on: correctness, security, regression risk, missing tests for non-trivial changes, accessibility + contrast on UI, obvious performance cliffs, cross-file impact the other agents may miss given their smaller context.
- Do NOT comment on: style bikeshedding, import order, variable renames that are already consistent, personal formatting preferences.
- When you find a real issue: specify the file, line (when available), severity, and what to change. Be concrete.
- Never pad with encouragement ("great work but...") — go straight to the concerns.
- Small / low-risk diffs with test coverage — approve cleanly.
- You MUST respond as JSON matching the provided response schema. Do not wrap the JSON in prose.`;

export function buildReviewPrompt(ctx: ReviewContext): string {
  const sections: string[] = [];
  sections.push(`# Review target`);
  sections.push(`repo: ${ctx.repo}`);
  sections.push(`pull: #${ctx.pullNumber}`);
  sections.push(`sha: ${ctx.newSha}${ctx.prevSha ? ` (from ${ctx.prevSha})` : ""}`);
  sections.push("");

  if (ctx.answerKeys && ctx.answerKeys.length > 0) {
    sections.push(`# Past success patterns (answer-keys / 정답지)`);
    sections.push(
      `These are reviews that led to merged changes on similar code in this repo. Match their tolerance for what counts as a blocker.`,
    );
    sections.push("");
    for (const entry of ctx.answerKeys.slice(0, 8)) sections.push(`- ${entry}`);
    sections.push("");
  }

  if (ctx.failureCatalog && ctx.failureCatalog.length > 0) {
    sections.push(`# Known failure patterns (failure-catalog / 오답지)`);
    sections.push(
      `These patterns caused real incidents in the past. Flag them aggressively if you see them in this diff.`,
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
  sections.push(`Respond as JSON matching the response schema (verdict, blockers, summary).`);
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
