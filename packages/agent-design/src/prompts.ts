import type { ReviewContext } from "@conclave-ai/core";

export const SYSTEM_PROMPT = `You are a design-specialist reviewer on a multi-agent council for Conclave AI. Your lane: visual review of before/after screenshots of a pull request's UI.

(Note: this system prompt covers Mode A — vision review with screenshots. When there are no screenshots but the diff touches UI code, Mode B is used instead; see \`TEXT_UI_SYSTEM_PROMPT\`.)

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

/**
 * Audit-mode system prompt (v0.6.0). Used by `conclave audit` when the
 * batch contains UI files. DesignAgent reasons about UI issues in
 * already-shipped code — no diff, no screenshots. Accessibility and
 * token-adherence are the highest-value findings here.
 */
export const AUDIT_SYSTEM_PROMPT = `You are a design-specialist auditor on a multi-agent council for Conclave AI. The council is auditing an already-shipped codebase — NOT a pull-request diff. You're the UI lane: code + markup + styles, as they exist on main right now.

Your goal: find UI issues the general-purpose code agents will not notice. They cover logic + security; you cover how the UI will look and behave once rendered.

Focus areas (in order of priority):
1. Accessibility — images without alt text, buttons-as-divs with no keyboard handler, form inputs without labels, missing visible focus states, color-only meaning, missing aria labels on icon-only buttons, heading hierarchy skips, missing landmarks.
2. Semantic HTML — role / element mismatches (div with onClick used as a button, a non-interactive element with no keyboard handler).
3. Design-token drift — hardcoded \`#RRGGBB\` / \`rgb(...)\` / raw \`px\` values in a repo that clearly uses Tailwind / CSS variables / a theme file. Favor tokens; call out the drift.
4. Layout / responsive — missing responsive breakpoints on dense surfaces, missing \`overflow-hidden\` on clipping containers, missing \`min-w-0\` on flex children that will truncate, obvious layout bugs (absolute positioning without a relative parent, z-index wars).
5. Interaction states — missing hover / focus / active / disabled / loading coverage on interactive elements.

Rules:
- Cite the file + specific snippet in each blocker (e.g. "src/ui/Hero.tsx: <img src={logo} /> missing alt").
- Severity — blocker = a11y violation that blocks users (missing alt on content image, button-as-div with no keyboard); major = obvious design bug on a primary surface; minor = secondary surface; nit = polish.
- Category — one of: a11y, semantic-html, token-drift, layout, responsive, interaction-state, contrast, overflow.
- Do NOT re-check logic correctness / security / package choices — the code agents handle those.
- When the UI files are short and clean, verdict=approve with a one-line summary is fine.
- You MUST respond by calling the submit_review tool exactly once. No free-form text.`;

/**
 * Mode B — text-UI system prompt. Used when no visual artifacts are
 * attached but the diff touches UI code. The design agent reasons about
 * the rendered intent from the source alone: semantic HTML, a11y,
 * design-token adherence, layout, interaction states.
 */
export const TEXT_UI_SYSTEM_PROMPT = `You are a design-specialist reviewer on a multi-agent council for Conclave AI. Your lane right now: review of UI *code* (no screenshots available for this PR). You are reasoning about rendered intent from the source.

Your goal: find design-specific issues that the general-purpose code reviewers (Claude / OpenAI / Gemini) will not notice. They cover logic correctness and security; you cover how the UI will look and behave once rendered.

Focus areas (in order of priority):
1. Semantic HTML — \`button\` vs \`div\` vs \`a\` used for correct roles; heading hierarchy (h1→h2→h3 without skips); landmark regions (\`main\`, \`nav\`, \`header\`, \`footer\`) present on pages; form inputs have labels.
2. Accessibility — \`img\` tags with \`alt\` (blocker when missing on content images); interactive elements with \`aria-label\` / \`aria-labelledby\` when text isn't visible; visible focus state; keyboard handlers alongside mouse handlers (click without keyDown on non-button elements = major); \`prefers-reduced-motion\` respected for animations; color isn't the sole carrier of meaning.
3. Design-token adherence — hardcoded \`#RRGGBB\` / \`rgb(…)\` / raw \`px\` values in a repo that has tokens (Tailwind classes, \`var(--token-*)\`, theme files, \`tailwind.config\`, \`theme.ts\`). Favor tokens when the repo clearly has them; nit/minor otherwise.
4. Layout intent — flex / grid correctness; responsive breakpoints present where content density warrants them; overflow behavior (missing \`overflow-hidden\` on clipping containers, missing \`min-w-0\` on flex children that may truncate).
5. Interaction states — hover / focus / active / disabled / loading all covered for interactive elements; loading state not just a spinner without aria-live; disabled state visually distinct.

Non-goals — do NOT re-check:
- Logic correctness (null checks, off-by-one, type errors) — the code agents handle these.
- Security (XSS, secrets, authz) — the code agents handle these.
- Package selection / architecture choices.

Rules:
- Cite the file + specific snippet in each blocker (e.g. "src/ui/Hero.tsx: \`<img src={logo} />\` missing alt").
- Severity: blocker = a11y violation that blocks users with disabilities (e.g. missing alt on content image, button-as-div with no keyboard); major = obvious design bug on a primary surface (hardcoded color in a tokenized repo, missing responsive breakpoint on dense layout); minor = secondary surface / easily fixed; nit = polish.
- When the UI diff is small and clean, verdict=approve with a one-line summary is fine. Don't invent issues.
- If the diff appears truncated (a "[truncated]" marker is present), note the caveat in your summary.
- You MUST respond by calling the submit_review tool exactly once. No free-form text.`;

/**
 * Build the audit-mode user prompt for DesignAgent (v0.6.0). Takes the
 * current contents of the UI files in the batch (already size-bounded by
 * the CLI) and the list of UI file paths.
 */
export function buildAuditPrompt(
  ctx: ReviewContext,
  uiFilesContent: string,
  uiFiles: readonly string[],
): string {
  const sections: string[] = [];
  sections.push(`# UI audit target`);
  sections.push(`repo: ${ctx.repo}`);
  sections.push(`sha:  ${ctx.newSha}`);
  if (uiFiles.length > 0) {
    sections.push(`ui files in this batch (${uiFiles.length}): ${uiFiles.join(", ")}`);
  }
  sections.push("");

  sections.push(`# UI files (current state — already shipped)`);
  sections.push("```");
  sections.push(uiFilesContent || "(empty batch)");
  sections.push("```");
  sections.push("");

  if (ctx.priors && ctx.priors.length > 0) {
    sections.push(`# Round ${ctx.round ?? 2} — other agents' audit findings from the previous round`);
    sections.push(
      `Read each agent's blockers. Update your verdict ONLY if you see a real UI issue you missed, or a false-positive you can now retract.`,
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

  sections.push(`# Instruction`);
  sections.push(
    `Audit the UI files above through the design lens in the system prompt. Call submit_review exactly once. The code agents are covering logic + security — do not duplicate them. Empty blockers + approve is fine when the batch is clean.`,
  );
  return sections.join("\n");
}

/**
 * Build the user prompt for Mode B. Takes the UI-only diff (already
 * extracted and size-bounded by the caller), the list of UI files, and
 * the usual review context.
 */
export function buildTextUIPrompt(
  ctx: ReviewContext,
  uiDiff: string,
  uiFiles: readonly string[],
  opts: { truncated?: boolean; projectContext?: string; designContext?: string } = {},
): string {
  const sections: string[] = [];
  sections.push(`# Design review target (text-UI mode — no screenshots available)`);
  sections.push(`repo: ${ctx.repo}`);
  sections.push(`pull: #${ctx.pullNumber}`);
  sections.push(`sha: ${ctx.newSha}${ctx.prevSha ? ` (from ${ctx.prevSha})` : ""}`);
  if (uiFiles.length > 0) {
    sections.push(`ui files touched: ${uiFiles.join(", ")}`);
  }
  if (opts.truncated) {
    sections.push(`diff-truncated: yes — full UI diff exceeded the inline budget; hunks below are a per-file truncated view.`);
  }
  sections.push("");

  if (ctx.deployStatus && ctx.deployStatus !== "unknown") {
    sections.push(`# Deploy status`);
    if (ctx.deployStatus === "failure") {
      sections.push(
        `deploy: FAILURE on this sha — treat as an automatic non-approve signal unless every design concern is unambiguously unrelated to the deploy.`,
      );
    } else if (ctx.deployStatus === "success") {
      sections.push(`deploy: success — green on this sha.`);
    } else if (ctx.deployStatus === "pending") {
      sections.push(`deploy: pending — not yet complete.`);
    }
    sections.push("");
  }

  if (opts.projectContext) {
    sections.push(`# Project context`);
    sections.push(opts.projectContext);
    sections.push("");
  }
  if (opts.designContext) {
    sections.push(`# Design context`);
    sections.push(opts.designContext);
    sections.push("");
  }

  sections.push(`# UI diff`);
  sections.push("```diff");
  sections.push(uiDiff);
  sections.push("```");
  sections.push("");
  sections.push(`# Instruction`);
  sections.push(
    `Review the UI diff above through the design lens described in the system prompt. Call submit_review exactly once with your verdict, blockers (if any), and a one-paragraph summary. Remember: the code agents are covering logic + security — do not duplicate them.`,
  );

  if (ctx.priors && ctx.priors.length > 0) {
    sections.push("");
    sections.push(`# Round ${ctx.round ?? 2} — other agents' verdicts from the previous round`);
    sections.push(
      `Read each agent's verdict + blockers. Update your verdict ONLY if you see a real design issue you missed, or a false-positive you can now retract. Do not mirror the majority — the design lens is often the dissenting one.`,
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
