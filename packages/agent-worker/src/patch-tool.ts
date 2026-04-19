/**
 * Tool-use schema that forces Claude to emit a structured patch.
 * Mirrors the single-tool pattern used by agent-claude's `submit_review`
 * — one tool, `tool_choice: { type: "tool", name }` — so we get reliable
 * structured output without any regex scraping of free-form text.
 */
export const PATCH_TOOL_NAME = "submit_patch";

export const PATCH_TOOL_DESCRIPTION =
  "Submit a unified-diff patch that fixes every blocker the council raised. Call this exactly once at the end of your analysis.";

export const PATCH_TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    patch: {
      type: "string",
      description:
        "A unified diff patch (the exact format `git apply` expects). Must start with `diff --git ` or `--- ` headers. Include full hunks with @@ line ranges. If a fix is impossible, return an empty string and explain in `summary`.",
    },
    commitMessage: {
      type: "string",
      description:
        "Single-line commit subject (≤ 72 chars), conventional-commit style when it fits (e.g. `fix(auth): ...`). This becomes the actual git commit message.",
    },
    filesTouched: {
      type: "array",
      description:
        "Every file path the patch modifies or creates — repo-relative, forward slashes. Used for post-apply sanity checks.",
      items: { type: "string" },
    },
    summary: {
      type: "string",
      description:
        "One-paragraph rationale: which blockers this patch addresses, which (if any) it could not and why, and any follow-up the reviewer should know about.",
    },
  },
  required: ["patch", "commitMessage", "filesTouched", "summary"],
} as const;
