import type { Agent, ReviewContext, ReviewResult, Blocker } from "@ai-conclave/core";
import { EfficiencyGate, estimateTokens } from "@ai-conclave/core";
import { REVIEW_TOOL_NAME, REVIEW_TOOL_DESCRIPTION, REVIEW_TOOL_INPUT_SCHEMA } from "./review-tool.js";
import { buildReviewPrompt, buildCacheablePrefix, SYSTEM_PROMPT } from "./prompts.js";
import { actualCost, estimateCallCost } from "./pricing.js";

/**
 * Minimal shape of the Anthropic SDK client that ClaudeAgent needs.
 * We type against this instead of the full SDK to keep tests cheap to mock
 * and to tolerate SDK minor version churn.
 */
export interface AnthropicLike {
  messages: {
    create(params: AnthropicCreateParams): Promise<AnthropicResponse>;
  };
}

export interface AnthropicCreateParams {
  model: string;
  max_tokens: number;
  system?: string | ReadonlyArray<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }>;
  messages: ReadonlyArray<{ role: "user" | "assistant"; content: string }>;
  tools?: ReadonlyArray<{
    name: string;
    description: string;
    input_schema: unknown;
  }>;
  tool_choice?: { type: "tool"; name: string } | { type: "auto" } | { type: "any" };
}

export interface AnthropicResponse {
  id: string;
  model: string;
  content: ReadonlyArray<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
  >;
  stop_reason?: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export interface ClaudeAgentOptions {
  apiKey?: string;
  /** Defaults to claude-sonnet-4-6. Gate router may force a different model per call. */
  model?: string;
  maxTokens?: number;
  /** Shared gate (recommended). If omitted, the agent creates its own. */
  gate?: EfficiencyGate;
  /** For tests or alternate providers — inject a Messages-compatible client. */
  client?: AnthropicLike;
  /** Factory used when `client` is not supplied. Defaults to lazy-loading @anthropic-ai/sdk. */
  clientFactory?: (apiKey: string) => Promise<AnthropicLike>;
}

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_TOKENS = 2_048;

async function defaultClientFactory(apiKey: string): Promise<AnthropicLike> {
  // Dynamic import so tests that inject a client never pay the SDK load cost.
  const mod = (await import("@anthropic-ai/sdk")) as unknown as {
    default: new (opts: { apiKey: string }) => AnthropicLike;
  };
  const Ctor = mod.default;
  return new Ctor({ apiKey });
}

/**
 * ClaudeAgent — routes a real Claude tool-use review call through the
 * efficiency gate. Returns a parsed ReviewResult.
 */
export class ClaudeAgent implements Agent {
  readonly id = "claude";
  readonly displayName = "Claude";

  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly gate: EfficiencyGate;
  private readonly clientFactory: (apiKey: string) => Promise<AnthropicLike>;
  private clientPromise: Promise<AnthropicLike> | null;

  constructor(opts: ClaudeAgentOptions = {}) {
    const key = opts.apiKey ?? process.env["ANTHROPIC_API_KEY"] ?? "";
    if (!key && !opts.client) {
      throw new Error("ClaudeAgent: ANTHROPIC_API_KEY not set (pass opts.apiKey, opts.client, or the env var)");
    }
    this.apiKey = key;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.gate = opts.gate ?? new EfficiencyGate();
    this.clientFactory = opts.clientFactory ?? defaultClientFactory;
    this.clientPromise = opts.client ? Promise.resolve(opts.client) : null;
  }

  private async getClient(): Promise<AnthropicLike> {
    if (!this.clientPromise) {
      this.clientPromise = this.clientFactory(this.apiKey);
    }
    return this.clientPromise;
  }

  async review(ctx: ReviewContext): Promise<ReviewResult> {
    const cacheablePrefix = buildCacheablePrefix(ctx);
    const userPrompt = buildReviewPrompt(ctx);
    const inputTokenEstimate = estimateTokens(cacheablePrefix) + estimateTokens(userPrompt);
    const estimatedCost = estimateCallCost(this.model, inputTokenEstimate, this.maxTokens);

    const outcome = await this.gate.run<ReviewResult>(
      {
        agent: this.id,
        cacheablePrefix,
        prompt: cacheablePrefix + "\n" + userPrompt,
        estimatedCostUsd: estimatedCost,
        forceModel: this.model,
      },
      async ({ model }) => {
        const started = Date.now();
        const client = await this.getClient();
        const response = await client.messages.create({
          model,
          max_tokens: this.maxTokens,
          system: [{ type: "text", text: cacheablePrefix, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: userPrompt }],
          tools: [
            {
              name: REVIEW_TOOL_NAME,
              description: REVIEW_TOOL_DESCRIPTION,
              input_schema: REVIEW_TOOL_INPUT_SCHEMA,
            },
          ],
          tool_choice: { type: "tool", name: REVIEW_TOOL_NAME },
        });
        const latencyMs = Date.now() - started;

        const parsed = parseReviewToolUse(response, this.id);
        const cost = actualCost(model, {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheCreationTokens: response.usage.cache_creation_input_tokens,
          cacheReadTokens: response.usage.cache_read_input_tokens,
        });

        return {
          result: {
            ...parsed,
            tokensUsed: response.usage.input_tokens + response.usage.output_tokens,
            costUsd: cost,
          },
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          costUsd: cost,
          latencyMs,
        };
      },
    );

    return outcome.result;
  }
}

function parseReviewToolUse(response: AnthropicResponse, agentId: string): ReviewResult {
  const toolUse = response.content.find(
    (block): block is Extract<(typeof response.content)[number], { type: "tool_use" }> =>
      block.type === "tool_use" && block.name === REVIEW_TOOL_NAME,
  );
  if (!toolUse) {
    throw new Error(
      `ClaudeAgent: response did not include a ${REVIEW_TOOL_NAME} tool_use block (stop_reason=${response.stop_reason ?? "?"})`,
    );
  }
  const input = toolUse.input as {
    verdict?: string;
    blockers?: unknown[];
    summary?: string;
  };
  if (input.verdict !== "approve" && input.verdict !== "rework" && input.verdict !== "reject") {
    throw new Error(`ClaudeAgent: invalid verdict "${String(input.verdict)}" in tool_use response`);
  }
  const blockers: Blocker[] = [];
  if (Array.isArray(input.blockers)) {
    for (const raw of input.blockers) {
      if (!raw || typeof raw !== "object") continue;
      const b = raw as Record<string, unknown>;
      const severity = b["severity"];
      const category = b["category"];
      const message = b["message"];
      if (
        (severity === "blocker" || severity === "major" || severity === "minor" || severity === "nit") &&
        typeof category === "string" &&
        typeof message === "string"
      ) {
        const blocker: Blocker = { severity, category, message };
        if (typeof b["file"] === "string") blocker.file = b["file"] as string;
        if (typeof b["line"] === "number") blocker.line = b["line"] as number;
        blockers.push(blocker);
      }
    }
  }
  return {
    agent: agentId,
    verdict: input.verdict,
    blockers,
    summary: typeof input.summary === "string" ? input.summary : "",
  };
}

// Re-export SYSTEM_PROMPT so downstream tools can render/copy it.
export { SYSTEM_PROMPT };
