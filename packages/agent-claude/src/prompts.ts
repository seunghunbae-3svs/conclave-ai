import type { ReviewContext } from "@conclave-ai/core";

/**
 * Audit-mode system prompt (v0.6.0). Used by `conclave audit` to run a
 * full-project health check instead of a PR-diff review. Agents receive
 * full file contents (not a diff) and must flag real issues in the
 * code as-shipped.
 */
export const AUDIT_SYSTEM_PROMPT = `You are a senior code auditor on a multi-agent council for Conclave AI. The council is auditing an already-shipped codebase — NOT a pull-request diff. Treat everything in the context as code that is live right now.

Your goal: surface real issues a human should fix this week. You work alongside other agents (OpenAI, Gemini, possibly a design specialist); spurious findings dilute the signal and waste the user's budget.

Rules:
- Flag real problems: correctness, security, injection risk, regression risk, accessibility violations, missing input validation, dead code, design-token drift, performance cliffs on hot paths.
- Do NOT pad with stylistic nits, import order, or taste-based naming suggestions.
- Every blocker MUST name the file and (when you can tell) a line or line-range. Concrete > abstract.
- Severity — blocker = ships broken / unsafe; major = observable regression risk or clear a11y violation; minor = real issue but low blast radius; nit = polish.
- Category — one of: security, a11y, correctness, regression, token-drift, dead-code, performance, test-coverage, docs.
- When the file contents are short and clean, approve cleanly — over-flagging is a bigger sin than missing a nit.
- You MUST respond by calling the submit_review tool exactly once. Do not emit free-form text.`;

export const SYSTEM_PROMPT = `You are a senior code reviewer on a multi-agent council for Conclave AI. The council reviews AI-generated code and design changes before merge.

Your goal: catch real blockers, not style nits. You work alongside other agents (OpenAI, Gemini, possibly domain-specific specialists). Your reviews are weighed against theirs; spurious blockers hurt your agent score and waste the rework budget.

Rules:
- Focus on: correctness, security, regression risk, missing tests for non-trivial changes, accessibility + contrast on UI, obvious performance cliffs.
- Do NOT comment on: style bikeshedding, import order, variable renames that are already consistent, personal formatting preferences.
- When you find a real issue: specify the file, line (when available), severity, and what to change. Be concrete.
- Never pad with encouragement ("great work but...") — go straight to the concerns.
- When the diff is small, low-risk, and has test coverage, approve cleanly. Over-flagging is a bigger sin than missing a nit.
- When the review context tells you deployStatus=failure for this commit, do NOT vote approve unless every blocker is unambiguously unrelated to the deploy. "Deploy is red" is a real-world signal the diff is not ready, even if the diff itself looks clean.
- You MUST respond by calling the submit_review tool exactly once. Do not emit free-form text.`;

export function buildReviewPrompt(ctx: ReviewContext): string {
  if (ctx.mode === "audit") return buildAuditPrompt(ctx);
  const sections: string[] = [];
  sections.push(`# Review target`);
  sections.push(`repo: ${ctx.repo}`);
  sections.push(`pull: #${ctx.pullNumber}`);
  sections.push(`sha: ${ctx.newSha}${ctx.prevSha ? ` (from ${ctx.prevSha})` : ""}`);
  sections.push("");

  // v0.6.4 — project context goes BEFORE the diff so the model reads
  // the repo's intent first and judges the diff against it, not in a
  // vacuum. Absent on repos without a README or .conclave/project-context.md.
  if (ctx.projectContext) {
    sections.push(`# Project context`);
    sections.push(ctx.projectContext);
    sections.push("");
  }

  if (ctx.deployStatus && ctx.deployStatus !== "unknown") {
    sections.push(`# Deploy status`);
    if (ctx.deployStatus === "failure") {
      sections.push(
        `deploy: FAILURE on this sha — treat as an automatic non-approve signal unless every blocker is unambiguously unrelated to the deploy. Approving a red-deploy PR is a hard mistake.`,
      );
    } else if (ctx.deployStatus === "success") {
      sections.push(`deploy: success — green on this sha.`);
    } else if (ctx.deployStatus === "pending") {
      sections.push(`deploy: pending — not yet complete. Do not block on it, but prefer rework over approve when in doubt.`);
    }
    sections.push("");
  }

  if (ctx.answerKeys && ctx.answerKeys.length > 0) {
    sections.push(`# Past success patterns (answer-keys)`);
    sections.push(
      `These are reviews that led to merged changes on similar code in this repo. Lean on them as a style + quality bar — match their tolerance for what counts as a blocker.`,
    );
    sections.push("");
    for (const entry of ctx.answerKeys.slice(0, 8)) {
      sections.push(`- ${entry}`);
    }
    sections.push("");
  }

  if (ctx.failureCatalog && ctx.failureCatalog.length > 0) {
    sections.push(`# Known failure patterns (failure-catalog)`);
    sections.push(
      `These are patterns that caused real incidents in the past. Flag them aggressively if you see them in this diff.`,
    );
    sections.push("");
    for (const entry of ctx.failureCatalog.slice(0, 8)) {
      sections.push(`- ${entry}`);
    }
    sections.push("");
  }

  sections.push(`# Diff`);
  sections.push("```diff");
  sections.push(ctx.diff || "(empty diff — respond with verdict=approve, summary noting nothing to review)");
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

  sections.push(`Call submit_review exactly once with your verdict, blockers (if any), and a one-paragraph summary.`);
  return sections.join("\n");
}

/**
 * The cacheable prefix is everything STABLE across calls within a session —
 * system prompt + any pinned RAG context that doesn't change per-turn.
 * Anthropic's prompt cache works best when this prefix is marked
 * `cache_control: ephemeral` and sits at the head of the messages array.
 */
export function buildCacheablePrefix(ctx: ReviewContext): string {
  const parts: string[] = [ctx.mode === "audit" ? AUDIT_SYSTEM_PROMPT : SYSTEM_PROMPT];
  if (ctx.answerKeys && ctx.answerKeys.length > 0) {
    parts.push("answer-keys:\n" + ctx.answerKeys.slice(0, 8).join("\n"));
  }
  if (ctx.failureCatalog && ctx.failureCatalog.length > 0) {
    parts.push("failure-catalog:\n" + ctx.failureCatalog.slice(0, 8).join("\n"));
  }
  return parts.join("\n---\n");
}

/**
 * Audit-mode user prompt (v0.6.0). `ctx.diff` carries the full current
 * contents of the batched files (not a unified diff); `ctx.auditFiles`
 * lists the paths. Priors are still honored so tier-2 escalation works.
 */
export function buildAuditPrompt(ctx: ReviewContext): string {
  const sections: string[] = [];
  sections.push(`# Audit target`);
  sections.push(`repo: ${ctx.repo}`);
  sections.push(`sha:  ${ctx.newSha}`);
  if (ctx.auditFiles && ctx.auditFiles.length > 0) {
    sections.push(`files in this batch (${ctx.auditFiles.length}): ${ctx.auditFiles.join(", ")}`);
  }
  sections.push("");

  // v0.6.4 — project context ahead of everything else so "what is this
  // repo FOR" sets the frame before the model reads the files.
  if (ctx.projectContext) {
    sections.push(`# Project context`);
    sections.push(ctx.projectContext);
    sections.push("");
  }

  if (ctx.failureCatalog && ctx.failureCatalog.length > 0) {
    sections.push(`# Known failure patterns (failure-catalog)`);
    sections.push(
      `These patterns caused real incidents in the past. Flag them aggressively if you see them in the files below.`,
    );
    sections.push("");
    for (const entry of ctx.failureCatalog.slice(0, 8)) sections.push(`- ${entry}`);
    sections.push("");
  }

  sections.push(`# Files (current state — already shipped)`);
  sections.push("```");
  sections.push(ctx.diff || "(empty — respond with verdict=approve and a note that the batch is empty)");
  sections.push("```");
  sections.push("");

  if (ctx.priors && ctx.priors.length > 0) {
    sections.push(`# Round ${ctx.round ?? 2} — other agents' audit findings from the previous round`);
    sections.push(
      `Read each agent's blockers. Update your verdict ONLY if you see a real issue you missed, or a false-positive you can now retract. Do not mirror the majority.`,
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

  sections.push(
    `Call submit_review exactly once. Treat every file as already-shipped; do NOT assume there is a diff. Focus on blockers users should fix now — not "the diff looks clean". Empty blockers list + approve is fine when the batch is genuinely clean.`,
  );
  return sections.join("\n");
}
