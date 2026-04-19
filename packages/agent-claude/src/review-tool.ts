/**
 * Tool-use schema that forces Claude to return a structured review.
 * Decision #12 — Zod → JSON Schema per-provider adapter; for Anthropic we
 * use a SINGLE-TOOL pattern (`tool_choice: { type: "tool", name: ... }`)
 * which gives us reliable structured output without relying on response
 * parsing heuristics.
 */
export const REVIEW_TOOL_NAME = "submit_review";

export const REVIEW_TOOL_DESCRIPTION =
  "Submit your structured review of the diff. Call this exactly once at the end of your analysis.";

export const REVIEW_TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    verdict: {
      type: "string",
      enum: ["approve", "rework", "reject"],
      description:
        "approve = ship as-is; rework = fixable blockers (agent should attempt auto-fix); reject = fundamentally wrong approach (do not merge, human must intervene).",
    },
    blockers: {
      type: "array",
      description: "Ordered list of issues found. Empty when verdict is approve.",
      items: {
        type: "object",
        properties: {
          severity: {
            type: "string",
            enum: ["blocker", "major", "minor", "nit"],
            description:
              "blocker = must fix; major = should fix; minor = worth fixing; nit = optional polish.",
          },
          category: {
            type: "string",
            description:
              "Short tag like 'type-error' / 'missing-test' / 'security' / 'accessibility' / 'regression'. Used for precision/recall metrics.",
          },
          message: {
            type: "string",
            description: "One-sentence description of the problem + what to change.",
          },
          file: { type: "string", description: "Relative path to the file, if applicable." },
          line: { type: "number", description: "Line number, if applicable." },
        },
        required: ["severity", "category", "message"],
      },
    },
    summary: {
      type: "string",
      description:
        "One-paragraph summary of the review. Include the overall verdict reasoning, not just a restatement of blockers.",
    },
  },
  required: ["verdict", "blockers", "summary"],
} as const;
