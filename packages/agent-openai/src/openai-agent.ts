import type { Agent, ReviewContext, ReviewResult, Blocker } from "@conclave-ai/core";
import { EfficiencyGate, estimateTokens } from "@conclave-ai/core";
import { REVIEW_SCHEMA_NAME, REVIEW_JSON_SCHEMA } from "./review-schema.js";
import { SYSTEM_PROMPT, buildReviewPrompt, buildCacheablePrefix } from "./prompts.js";
import { actualCost, estimateCallCost } from "./pricing.js";

/**
 * Minimal shape of the OpenAI SDK client that OpenAIAgent needs.
 * Typed against this subset to keep tests cheap to mock and tolerate SDK
 * minor-version churn.
 */
export interface OpenAILike {
  chat: {
    completions: {
      create(params: ChatCompletionParams): Promise<ChatCompletionResponse>;
    };
  };
}

export interface ChatCompletionParams {
  model: string;
  max_completion_tokens?: number;
  max_tokens?: number;
  messages: ReadonlyArray<{ role: "system" | "user" | "assistant"; content: string }>;
  response_format?: {
    type: "json_schema";
    json_schema: { name: string; strict: true; schema: unknown };
  };
}

export interface ChatCompletionResponse {
  id: string;
  model: string;
  choices: ReadonlyArray<{
    index: number;
    finish_reason: string;
    message: {
      role: "assistant";
      content: string | null;
      refusal?: string | null;
    };
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

export interface OpenAIAgentOptions {
  apiKey?: string;
  /** Defaults to gpt-5-mini. Gate router may override per call. */
  model?: string;
  maxTokens?: number;
  gate?: EfficiencyGate;
  client?: OpenAILike;
  clientFactory?: (apiKey: string) => Promise<OpenAILike>;
}

const DEFAULT_MODEL = "gpt-5-mini";
const DEFAULT_MAX_TOKENS = 8_192;

async function defaultClientFactory(apiKey: string): Promise<OpenAILike> {
  const mod = (await import("openai")) as unknown as {
    default: new (opts: { apiKey: string }) => OpenAILike;
  };
  const Ctor = mod.default;
  return new Ctor({ apiKey });
}

/**
 * OpenAIAgent — routes a real OpenAI structured-output review call through
 * the efficiency gate. Uses strict JSON Schema response format so the
 * response is guaranteed to match `ReviewResult` shape (decision #12).
 */
export class OpenAIAgent implements Agent {
  readonly id = "openai";
  readonly displayName = "OpenAI";

  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly gate: EfficiencyGate;
  private readonly clientFactory: (apiKey: string) => Promise<OpenAILike>;
  private clientPromise: Promise<OpenAILike> | null;

  constructor(opts: OpenAIAgentOptions = {}) {
    const key = opts.apiKey ?? process.env["OPENAI_API_KEY"] ?? "";
    if (!key && !opts.client) {
      throw new Error("OpenAIAgent: OPENAI_API_KEY not set (pass opts.apiKey, opts.client, or the env var)");
    }
    this.apiKey = key;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.gate = opts.gate ?? new EfficiencyGate();
    this.clientFactory = opts.clientFactory ?? defaultClientFactory;
    this.clientPromise = opts.client ? Promise.resolve(opts.client) : null;
  }

  private async getClient(): Promise<OpenAILike> {
    if (!this.clientPromise) this.clientPromise = this.clientFactory(this.apiKey);
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
        const response = await client.chat.completions.create({
          model,
          max_completion_tokens: this.maxTokens,
          messages: [
            { role: "system", content: cacheablePrefix },
            { role: "user", content: userPrompt },
          ],
          response_format: {
            type: "json_schema",
            json_schema: { name: REVIEW_SCHEMA_NAME, strict: true, schema: REVIEW_JSON_SCHEMA },
          },
        });
        const latencyMs = Date.now() - started;

        const parsed = parseReviewResponse(response, this.id);
        const usage = response.usage;
        const inputTokens = usage?.prompt_tokens ?? inputTokenEstimate;
        const outputTokens = usage?.completion_tokens ?? 0;
        const cachedInput = usage?.prompt_tokens_details?.cached_tokens;
        const costParts: { inputTokens: number; outputTokens: number; cachedInputTokens?: number } = {
          inputTokens,
          outputTokens,
        };
        if (cachedInput !== undefined) costParts.cachedInputTokens = cachedInput;
        const cost = actualCost(model, costParts);

        return {
          result: {
            ...parsed,
            tokensUsed: inputTokens + outputTokens,
            costUsd: cost,
          },
          inputTokens,
          outputTokens,
          costUsd: cost,
          latencyMs,
        };
      },
    );

    return outcome.result;
  }
}

function parseReviewResponse(response: ChatCompletionResponse, agentId: string): ReviewResult {
  const choice = response.choices[0];
  if (!choice) throw new Error("OpenAIAgent: response had no choices");
  if (choice.message.refusal) {
    throw new Error(`OpenAIAgent: model refused to respond — ${choice.message.refusal}`);
  }
  const text = choice.message.content;
  if (!text) throw new Error(`OpenAIAgent: response had no content (finish_reason=${choice.finish_reason})`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`OpenAIAgent: response content was not valid JSON: ${(err as Error).message}`);
  }
  return normalizeReview(parsed, agentId);
}

function normalizeReview(raw: unknown, agentId: string): ReviewResult {
  if (!raw || typeof raw !== "object") {
    throw new Error("OpenAIAgent: response is not an object");
  }
  const v = (raw as { verdict?: unknown }).verdict;
  if (v !== "approve" && v !== "rework" && v !== "reject") {
    throw new Error(`OpenAIAgent: invalid verdict "${String(v)}"`);
  }
  const blockersRaw = (raw as { blockers?: unknown[] }).blockers;
  const blockers: Blocker[] = [];
  if (Array.isArray(blockersRaw)) {
    for (const item of blockersRaw) {
      if (!item || typeof item !== "object") continue;
      const b = item as Record<string, unknown>;
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
  const summary = typeof (raw as { summary?: unknown }).summary === "string" ? (raw as { summary: string }).summary : "";
  return { agent: agentId, verdict: v, blockers, summary };
}

export { SYSTEM_PROMPT };
