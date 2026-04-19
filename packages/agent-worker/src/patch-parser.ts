import type { AnthropicResponse } from "./anthropic-types.js";
import { PATCH_TOOL_NAME } from "./patch-tool.js";
import type { WorkerOutcome } from "./types.js";

export class WorkerParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerParseError";
  }
}

/**
 * Parse the Claude tool_use response into a WorkerOutcome.
 *
 * Validation rules:
 * - exactly one `submit_patch` tool_use block must be present
 * - `commitMessage` and `summary` are strings
 * - `filesTouched` is an array of strings
 * - `patch` is a string (may be empty when the worker gives up — we
 *   preserve that signal instead of throwing, so the caller can decide)
 * - if `patch` is non-empty, it must look like a unified diff (one of
 *   `diff --git`, `--- `, or `Index:` at the start of a line) — this
 *   catches the common failure where the model returns a code snippet
 *   in prose form instead of a patch
 */
export function parsePatchToolUse(response: AnthropicResponse): Omit<WorkerOutcome, "tokensUsed" | "costUsd"> {
  const toolUse = response.content.find(
    (block): block is Extract<(typeof response.content)[number], { type: "tool_use" }> =>
      block.type === "tool_use" && block.name === PATCH_TOOL_NAME,
  );
  if (!toolUse) {
    throw new WorkerParseError(
      `Worker: response did not include a ${PATCH_TOOL_NAME} tool_use block (stop_reason=${response.stop_reason ?? "?"})`,
    );
  }

  const input = toolUse.input as {
    patch?: unknown;
    commitMessage?: unknown;
    filesTouched?: unknown;
    summary?: unknown;
  };

  if (typeof input.patch !== "string") {
    throw new WorkerParseError(`Worker: submit_patch.patch must be a string`);
  }
  if (typeof input.commitMessage !== "string" || input.commitMessage.trim().length === 0) {
    throw new WorkerParseError(`Worker: submit_patch.commitMessage must be a non-empty string`);
  }
  if (!Array.isArray(input.filesTouched) || !input.filesTouched.every((f) => typeof f === "string")) {
    throw new WorkerParseError(`Worker: submit_patch.filesTouched must be an array of strings`);
  }

  const patch = input.patch;
  if (patch.length > 0 && !looksLikeUnifiedDiff(patch)) {
    throw new WorkerParseError(
      `Worker: submit_patch.patch does not look like a unified diff (expected 'diff --git', '--- ', or 'Index:' header)`,
    );
  }

  return {
    patch,
    message: input.commitMessage.trim(),
    appliedFiles: (input.filesTouched as string[]).map((f) => f.trim()).filter((f) => f.length > 0),
  };
}

const UNIFIED_DIFF_HEADER = /(^|\n)(diff --git |--- |Index: )/;

export function looksLikeUnifiedDiff(patch: string): boolean {
  return UNIFIED_DIFF_HEADER.test(patch);
}
