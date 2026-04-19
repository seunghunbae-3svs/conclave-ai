/**
 * Gemini response schema for structured output.
 *
 * Gemini enforces structure via `generationConfig: { responseMimeType:
 * "application/json", responseSchema: <OpenAPI-like schema> }`.
 * The shape here mirrors agent-claude's tool_use schema + agent-openai's
 * strict json_schema so all three agents emit compatible `ReviewResult`
 * payloads.
 *
 * Gemini's schema is a subset of OpenAPI 3.0 — notably `additionalProperties`
 * is NOT supported and `null` union is expressed by `nullable: true`.
 */
export const REVIEW_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    verdict: {
      type: "STRING",
      enum: ["approve", "rework", "reject"],
    },
    blockers: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          severity: { type: "STRING", enum: ["blocker", "major", "minor", "nit"] },
          category: { type: "STRING" },
          message: { type: "STRING" },
          file: { type: "STRING", nullable: true },
          line: { type: "INTEGER", nullable: true },
        },
        required: ["severity", "category", "message"],
      },
    },
    summary: { type: "STRING" },
  },
  required: ["verdict", "blockers", "summary"],
} as const;
