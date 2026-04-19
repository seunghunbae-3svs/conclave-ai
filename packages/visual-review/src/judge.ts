import type { ReviewContext } from "@ai-conclave/core";

export type VisualJudgmentCategory =
  | "intentional" // deliberate redesign, working as expected
  | "regression" // unintended change, degraded UX / broke something
  | "accessibility" // contrast / sizing / keyboard-trap / readable-text concern
  | "mixed" // some intentional + some regression in the same diff
  | "unreviewable"; // vision model can't tell (blank / error page / scaled too small)

export interface VisualJudgment {
  category: VisualJudgmentCategory;
  /** 0..1 — model's self-reported confidence. */
  confidence: number;
  /** One-paragraph natural-language explanation. */
  summary: string;
  /**
   * Specific regions / concerns the reviewer flagged. Empty when
   * category is `intentional`.
   */
  concerns: VisualConcern[];
}

export interface VisualConcern {
  /** Short category tag: `contrast`, `layout-shift`, `missing-content`, `scroll-jank`, etc. */
  kind: string;
  severity: "blocker" | "major" | "minor";
  message: string;
}

export interface VisionJudgeContext {
  /** Why the reviewer is looking: "PR merges a login redesign", "hotfix for safari render bug", etc. */
  changeHint?: string;
  /** Code review verdict + summary, so the vision judge can be consistent with council consensus. */
  codeReviewContext?: Pick<ReviewContext, "repo" | "pullNumber" | "diff">;
}

/**
 * VisionJudge — pluggable interface for semantic before/after image
 * comparison. The pixel-diff layer (`PixelmatchDiff`) measures HOW MUCH
 * changed; the vision judge measures WHETHER it's good.
 *
 * Default implementation uses Anthropic's multimodal Claude API through
 * a minimal provided client. Users can inject a different implementation
 * (e.g. GPT-4o vision, Gemini 1.5 Pro vision) by supplying their own
 * `VisionJudge`.
 *
 * Contract:
 *   - `judge(before, after, ctx)` returns a `VisualJudgment`.
 *   - Must NEVER throw on ambiguous inputs — return
 *     `{ category: "unreviewable", confidence: 0, ... }` instead.
 *     Hard errors (auth / network) MAY throw.
 */
export interface VisionJudge {
  readonly id: string;
  judge(
    before: Uint8Array,
    after: Uint8Array,
    ctx?: VisionJudgeContext,
  ): Promise<VisualJudgment>;
}

/**
 * Minimal Anthropic messages API subset we rely on for vision calls.
 * Narrowly typed so tests can mock without loading the SDK.
 */
export interface AnthropicVisionLike {
  messages: {
    create(params: AnthropicVisionParams): Promise<AnthropicVisionResponse>;
  };
}

export interface AnthropicVisionParams {
  model: string;
  max_tokens: number;
  system?: string | ReadonlyArray<{ type: "text"; text: string }>;
  messages: ReadonlyArray<{
    role: "user" | "assistant";
    content:
      | string
      | ReadonlyArray<
          | { type: "text"; text: string }
          | {
              type: "image";
              source: { type: "base64"; media_type: "image/png" | "image/jpeg"; data: string };
            }
        >;
  }>;
  tools?: ReadonlyArray<{ name: string; description: string; input_schema: unknown }>;
  tool_choice?: { type: "tool"; name: string };
}

export interface AnthropicVisionResponse {
  content: ReadonlyArray<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
  >;
  stop_reason?: string;
  usage?: { input_tokens: number; output_tokens: number };
}

export interface ClaudeVisionJudgeOptions {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  client?: AnthropicVisionLike;
  clientFactory?: (apiKey: string) => Promise<AnthropicVisionLike>;
}

const SUBMIT_TOOL_NAME = "submit_visual_judgment";

const SUBMIT_TOOL_SCHEMA = {
  type: "object",
  properties: {
    category: {
      type: "string",
      enum: ["intentional", "regression", "accessibility", "mixed", "unreviewable"],
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description: "0..1 — your confidence in the category judgment.",
    },
    summary: {
      type: "string",
      description: "One paragraph explaining what changed and why it's ok / not ok.",
    },
    concerns: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            description:
              "Short tag: contrast, layout-shift, missing-content, cropped-text, scroll-jank, keyboard-trap, etc.",
          },
          severity: { type: "string", enum: ["blocker", "major", "minor"] },
          message: { type: "string" },
        },
        required: ["kind", "severity", "message"],
      },
    },
  },
  required: ["category", "confidence", "summary", "concerns"],
} as const;

const SYSTEM_PROMPT = `You are the vision arm of an Ai-Conclave review council. Your job: compare the BEFORE and AFTER screenshots of a web page and classify the change.

Categories:
  intentional    - deliberate redesign / new feature / working as expected.
  regression     - unintended change. Content missing, layout broke, visual bug.
  accessibility  - contrast, sizing, focus/keyboard, text-readability concerns.
  mixed          - the diff contains BOTH intentional AND regression.
  unreviewable   - can't tell (blank image, error page, or screenshots too small/similar to judge).

Rules:
- Focus on REAL, user-visible issues. Do not flag imperceptible pixel-level noise.
- If the change reads as a deliberate, well-executed redesign, category=intentional + concerns=[].
- Regression / accessibility calls MUST name specific regions or elements ("header CTA button now cropped", "body text contrast dropped below AA").
- Confidence: 0.9+ when you're sure, 0.5-0.8 when the diff is ambiguous, <0.5 when screenshots are degenerate.
- You MUST call submit_visual_judgment exactly once. No free-form text.`;

/**
 * ClaudeVisionJudge — default implementation of `VisionJudge` using
 * Claude Sonnet's multimodal API. Sends BEFORE + AFTER PNG buffers as
 * base64 image blocks + a compact diff hint, and forces structured
 * output via the `submit_visual_judgment` tool.
 */
export class ClaudeVisionJudge implements VisionJudge {
  readonly id = "claude-vision";

  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly clientFactory: (apiKey: string) => Promise<AnthropicVisionLike>;
  private clientPromise: Promise<AnthropicVisionLike> | null;

  constructor(opts: ClaudeVisionJudgeOptions = {}) {
    const key = opts.apiKey ?? process.env["ANTHROPIC_API_KEY"] ?? "";
    if (!key && !opts.client) {
      throw new Error("ClaudeVisionJudge: ANTHROPIC_API_KEY not set (pass opts.apiKey, opts.client, or env var)");
    }
    this.apiKey = key;
    this.model = opts.model ?? "claude-sonnet-4-6";
    this.maxTokens = opts.maxTokens ?? 1_024;
    this.clientFactory =
      opts.clientFactory ??
      (async () => {
        if (opts.client) return opts.client;
        const mod = (await import("@anthropic-ai/sdk")) as unknown as {
          default: new (o: { apiKey: string }) => AnthropicVisionLike;
        };
        return new mod.default({ apiKey: this.apiKey });
      });
    this.clientPromise = opts.client ? Promise.resolve(opts.client) : null;
  }

  async judge(
    before: Uint8Array,
    after: Uint8Array,
    ctx: VisionJudgeContext = {},
  ): Promise<VisualJudgment> {
    const client = await this.getClient();
    const userText = buildUserPrompt(ctx);
    const beforeB64 = toBase64(before);
    const afterB64 = toBase64(after);
    const response = await client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: userText },
            { type: "text", text: "BEFORE:" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: beforeB64 } },
            { type: "text", text: "AFTER:" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: afterB64 } },
            { type: "text", text: "Respond by calling submit_visual_judgment exactly once." },
          ],
        },
      ],
      tools: [
        {
          name: SUBMIT_TOOL_NAME,
          description: "Return your structured visual judgment. Call exactly once.",
          input_schema: SUBMIT_TOOL_SCHEMA,
        },
      ],
      tool_choice: { type: "tool", name: SUBMIT_TOOL_NAME },
    });
    return parseResponse(response);
  }

  private async getClient(): Promise<AnthropicVisionLike> {
    if (!this.clientPromise) this.clientPromise = this.clientFactory(this.apiKey);
    return this.clientPromise;
  }
}

function buildUserPrompt(ctx: VisionJudgeContext): string {
  const parts: string[] = [];
  parts.push(
    "Compare the BEFORE and AFTER screenshots of the same web page. Classify the visual change.",
  );
  if (ctx.changeHint) {
    parts.push(`Change hint from the author: ${ctx.changeHint}`);
  }
  if (ctx.codeReviewContext) {
    const { repo, pullNumber, diff } = ctx.codeReviewContext;
    parts.push(`Code change: ${repo}${pullNumber ? ` #${pullNumber}` : ""}.`);
    const diffSnippet = (diff ?? "").slice(0, 500);
    if (diffSnippet) parts.push(`Diff excerpt (first 500 chars):\n${diffSnippet}`);
  }
  return parts.join("\n\n");
}

function parseResponse(response: AnthropicVisionResponse): VisualJudgment {
  const toolUse = response.content.find(
    (b): b is Extract<(typeof response.content)[number], { type: "tool_use" }> =>
      b.type === "tool_use" && b.name === SUBMIT_TOOL_NAME,
  );
  if (!toolUse) {
    return {
      category: "unreviewable",
      confidence: 0,
      summary: `Model did not call submit_visual_judgment (stop_reason=${response.stop_reason ?? "?"}).`,
      concerns: [],
    };
  }
  const raw = toolUse.input as {
    category?: unknown;
    confidence?: unknown;
    summary?: unknown;
    concerns?: unknown;
  };
  const category = coerceCategory(raw.category);
  const confidence = typeof raw.confidence === "number" ? clamp01(raw.confidence) : 0;
  const summary = typeof raw.summary === "string" ? raw.summary : "";
  const concerns: VisualConcern[] = [];
  if (Array.isArray(raw.concerns)) {
    for (const item of raw.concerns) {
      if (!item || typeof item !== "object") continue;
      const c = item as Record<string, unknown>;
      const kind = c["kind"];
      const severity = c["severity"];
      const message = c["message"];
      if (
        typeof kind === "string" &&
        (severity === "blocker" || severity === "major" || severity === "minor") &&
        typeof message === "string"
      ) {
        concerns.push({ kind, severity, message });
      }
    }
  }
  return { category, confidence, summary, concerns };
}

function coerceCategory(v: unknown): VisualJudgmentCategory {
  if (
    v === "intentional" ||
    v === "regression" ||
    v === "accessibility" ||
    v === "mixed" ||
    v === "unreviewable"
  ) {
    return v;
  }
  return "unreviewable";
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/** Native `Buffer.from(ab).toString('base64')` — explicit for test-path clarity. */
function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}
