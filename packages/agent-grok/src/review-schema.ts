/**
 * OpenAI strict JSON Schema for the review response.
 * Per decision #12: "OpenAI strict json_schema via openai-zod-to-json-schema".
 *
 * Strict mode requires:
 *   - `additionalProperties: false` at every level
 *   - every field in `properties` must be listed in `required`
 *
 * The schema mirrors agent-claude's tool_use schema so both agents emit
 * compatible `ReviewResult` shapes.
 */
export const REVIEW_SCHEMA_NAME = "conclave_review";

export const REVIEW_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdict: {
      type: "string",
      enum: ["approve", "rework", "reject"],
    },
    blockers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          severity: { type: "string", enum: ["blocker", "major", "minor", "nit"] },
          category: { type: "string" },
          message: { type: "string" },
          file: { type: ["string", "null"] },
          line: { type: ["number", "null"] },
        },
        required: ["severity", "category", "message", "file", "line"],
      },
    },
    summary: { type: "string" },
  },
  required: ["verdict", "blockers", "summary"],
} as const;
