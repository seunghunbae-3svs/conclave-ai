import type { ReviewContext } from "@conclave-ai/core";

export const SYSTEM_PROMPT = `You are a design-specialist reviewer on a multi-agent council for Conclave AI. Your lane: visual review of before/after screenshots of a pull request's UI.

Your goal: catch real design regressions, accessibility issues, and unintentional style changes that the text-based reviewers would miss. The council weighs your verdict alongside the text-agents (Claude, OpenAI, Gemini) who are reading the diff. Cover what they can't: what the page actually looks like, rendered.

Rules:
- Focus on: layout regressions (cropped text, overlapping elements, broken alignment), contrast + WCAG AA accessibility, unintentional style changes (font weight/color drift, spacing regressions), visual bugs (missing states, broken responsive breakpoints).
- Do NOT block on: imperceptible pixel noise, intentional redesigns that cleanly land, minor spacing nits when the overall composition still reads well.
- When you find a real issue: name the element + describe the regression concretely. "Header CTA truncated on after screenshot — 'Sign up' becomes 'Sign u...'" beats "button looks wrong".
- Severity: blocker = breaks core flow or inaccessible; major = obvious visual regression on primary surface; minor = secondary surface / easily fixed; nit = tiny polish.
- When no visual artifacts were captured for this PR (empty \`visualArtifacts\`), respond verdict=approve and note the limitation in your summary. Do NOT fabricate findings from the text diff alone.
- Never pad with encouragement ("great work but..."). Straight to concerns.
- You MUST respond by calling the submit_review tool exactly once. No free-form text.`;

export const REVIEW_TOOL_NAME = "submit_review";

export const REVIEW_TOOL_DESCRIPTION =
  "Submit your structured visual review of the before/after screenshots. Call this exactly once at the end of your analysis.";

export const REVIEW_TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    verdict: {
      type: "string",
      enum: ["approve", "rework", "reject"],
      description:
        "approve = visuals ship as-is; rework = fixable visual regressions (author should address); reject = fundamental design break (not mergeable).",
    },
    blockers: {
      type: "array",
      description:
        "Ordered list of visual issues. Empty when verdict is approve. Each entry names the affected element + the regression.",
      items: {
        type: "object",
        properties: {
          severity: {
            type: "string",
            enum: ["blocker", "major", "minor", "nit"],
            description:
              "blocker = breaks core flow / inaccessible; major = obvious visual regression; minor = secondary surface; nit = polish.",
          },
          category: {
            type: "string",
            description:
              "Short tag: 'layout-regression' / 'contrast' / 'cropped-text' / 'style-drift' / 'missing-state' / 'overflow' / 'accessibility'.",
          },
          message: {
            type: "string",
            description: "One-sentence description naming the element and the concrete regression.",
          },
          file: {
            type: "string",
            description: "Route or screenshot label, if attributable.",
          },
        },
        required: ["severity", "category", "message"],
      },
    },
    summary: {
      type: "string",
      description:
        "One-paragraph summary of the visual review. Explain the overall verdict reasoning — what changed, whether it reads as intentional, and any caveats.",
    },
  },
  required: ["verdict", "blockers", "summary"],
} as const;

export function buildUserPrompt(ctx: ReviewContext, routes: readonly string[]): string {
  const sections: string[] = [];
  sections.push(`# Design review target`);
  sections.push(`repo: ${ctx.repo}`);
  sections.push(`pull: #${ctx.pullNumber}`);
  sections.push(`sha: ${ctx.newSha}${ctx.prevSha ? ` (from ${ctx.prevSha})` : ""}`);
  if (routes.length > 0) {
    sections.push(`routes: ${routes.join(", ")}`);
  }
  sections.push("");

  if (ctx.deployStatus && ctx.deployStatus !== "unknown") {
    sections.push(`# Deploy status`);
    if (ctx.deployStatus === "failure") {
      sections.push(
        `deploy: FAILURE on this sha — treat as an automatic non-approve signal unless every visual concern is unambiguously unrelated to the deploy.`,
      );
    } else if (ctx.deployStatus === "success") {
      sections.push(`deploy: success — green on this sha.`);
    } else if (ctx.deployStatus === "pending") {
      sections.push(`deploy: pending — not yet complete.`);
    }
    sections.push("");
  }

  sections.push(`# Instruction`);
  sections.push(
    `You will receive one or more BEFORE/AFTER screenshot pairs. Compare them region by region. Call submit_review exactly once with your verdict, blockers (if any), and a one-paragraph summary. If no pairs are attached, respond verdict=approve with summary noting the missing artifacts.`,
  );

  if (ctx.priors && ctx.priors.length > 0) {
    sections.push("");
    sections.push(`# Round ${ctx.round ?? 2} — other agents' verdicts from the previous round`);
    sections.push(
      `Read each agent's verdict + blockers. Update your verdict ONLY if you see a real visual issue you missed, or a false-positive you can now retract. Do not mirror the majority — the design lens is often the dissenting one.`,
    );
    sections.push("");
    for (const p of ctx.priors) {
      sections.push(`## ${p.agent}: ${p.verdict}`);
      if (p.blockers.length > 0) {
        for (const b of p.blockers.slice(0, 5)) {
          sections.push(`- [${b.severity}/${b.category}] ${b.message}`);
        }
      } else {
        sections.push(`- (no blockers)`);
      }
      sections.push("");
    }
  }

  return sections.join("\n");
}
