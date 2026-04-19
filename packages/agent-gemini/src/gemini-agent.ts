import type { Agent, ReviewContext, ReviewResult, Blocker } from "@conclave-ai/core";
import { EfficiencyGate, estimateTokens } from "@conclave-ai/core";
import { REVIEW_RESPONSE_SCHEMA } from "./review-schema.js";
import { SYSTEM_PROMPT, buildReviewPrompt, buildCacheablePrefix } from "./prompts.js";
import { actualCost, estimateCallCost } from "./pricing.js";

/**
 * Minimal shape of @google/genai we rely on. Typed narrowly so tests
 * never instantiate the real SDK and SDK minor-version drift doesn't
 * break the build.
 */
export interface GenAILike {
  models: {
    generateContent(params: GenerateContentParams): Promise<GenerateContentResponse>;
  };
}

export interface GenerateContentParams {
  model: string;
  contents: ReadonlyArray<{
    role: "user" | "model";
    parts: ReadonlyArray<{ text: string }>;
  }>;
  config?: {
    systemInstruction?: { parts: ReadonlyArray<{ text: string }> } | string;
    maxOutputTokens?: number;
    responseMimeType?: "application/json";
    responseSchema?: unknown;
    temperature?: number;
  };
}

export interface GenerateContentResponse {
  text?: string;
  candidates?: ReadonlyArray<{
    content?: { parts?: ReadonlyArray<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
  };
}

export interface GeminiAgentOptions {
  apiKey?: string;
  /** Default: gemini-2.5-pro (long-context slot per decision #10). */
  model?: string;
  maxTokens?: number;
  gate?: EfficiencyGate;
  client?: GenAILike;
  clientFactory?: (apiKey: string) => Promise<GenAILike>;
}

const DEFAULT_MODEL = "gemini-2.5-pro";
const DEFAULT_MAX_TOKENS = 2_048;

async function defaultClientFactory(apiKey: string): Promise<GenAILike> {
  const mod = (await import("@google/genai")) as unknown as {
    GoogleGenAI: new (opts: { apiKey: string }) => GenAILike;
  };
  return new mod.GoogleGenAI({ apiKey });
}

export class GeminiAgent implements Agent {
  readonly id = "gemini";
  readonly displayName = "Gemini";

  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly gate: EfficiencyGate;
  private readonly clientFactory: (apiKey: string) => Promise<GenAILike>;
  private clientPromise: Promise<GenAILike> | null;

  constructor(opts: GeminiAgentOptions = {}) {
    const key = opts.apiKey ?? process.env["GOOGLE_API_KEY"] ?? process.env["GEMINI_API_KEY"] ?? "";
    if (!key && !opts.client) {
      throw new Error("GeminiAgent: GOOGLE_API_KEY (or GEMINI_API_KEY) not set (pass opts.apiKey, opts.client, or the env var)");
    }
    this.apiKey = key;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.gate = opts.gate ?? new EfficiencyGate();
    this.clientFactory = opts.clientFactory ?? defaultClientFactory;
    this.clientPromise = opts.client ? Promise.resolve(opts.client) : null;
  }

  private async getClient(): Promise<GenAILike> {
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
        const response = await client.models.generateContent({
          model,
          contents: [{ role: "user", parts: [{ text: userPrompt }] }],
          config: {
            systemInstruction: { parts: [{ text: cacheablePrefix }] },
            maxOutputTokens: this.maxTokens,
            responseMimeType: "application/json",
            responseSchema: REVIEW_RESPONSE_SCHEMA,
          },
        });
        const latencyMs = Date.now() - started;

        const parsed = parseResponse(response, this.id);
        const usage = response.usageMetadata ?? {};
        const inputTokens = usage.promptTokenCount ?? inputTokenEstimate;
        const outputTokens = usage.candidatesTokenCount ?? 0;
        const cachedInput = usage.cachedContentTokenCount;
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

function parseResponse(response: GenerateContentResponse, agentId: string): ReviewResult {
  const text = extractText(response);
  if (!text) {
    const reason = response.candidates?.[0]?.finishReason ?? "unknown";
    throw new Error(`GeminiAgent: response had no text (finishReason=${reason})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`GeminiAgent: response text was not valid JSON: ${(err as Error).message}`);
  }
  return normalize(parsed, agentId);
}

function extractText(response: GenerateContentResponse): string | null {
  if (typeof response.text === "string" && response.text) return response.text;
  const cand = response.candidates?.[0];
  if (!cand) return null;
  const parts = cand.content?.parts;
  if (!parts) return null;
  let out = "";
  for (const p of parts) {
    if (typeof p.text === "string") out += p.text;
  }
  return out || null;
}

function normalize(raw: unknown, agentId: string): ReviewResult {
  if (!raw || typeof raw !== "object") {
    throw new Error("GeminiAgent: response is not an object");
  }
  const v = (raw as { verdict?: unknown }).verdict;
  if (v !== "approve" && v !== "rework" && v !== "reject") {
    throw new Error(`GeminiAgent: invalid verdict "${String(v)}"`);
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
