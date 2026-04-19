import { EfficiencyGate, estimateTokens } from "@conclave-ai/core";
import type { AnthropicCreateParams, AnthropicLike, AnthropicResponse } from "./anthropic-types.js";
import { PATCH_TOOL_NAME, PATCH_TOOL_DESCRIPTION, PATCH_TOOL_INPUT_SCHEMA } from "./patch-tool.js";
import { buildWorkerPrompt, buildCacheablePrefix, WORKER_SYSTEM_PROMPT } from "./prompts.js";
import { parsePatchToolUse } from "./patch-parser.js";
import { actualCost, estimateCallCost } from "./pricing.js";
import type { WorkerContext, WorkerOutcome } from "./types.js";

export interface ClaudeWorkerOptions {
  apiKey?: string;
  /** Defaults to claude-sonnet-4-6. Gate router may force a different model per call. */
  model?: string;
  maxTokens?: number;
  /** Shared gate (recommended). If omitted, the worker creates its own. */
  gate?: EfficiencyGate;
  /** For tests or alternate providers — inject a Messages-compatible client. */
  client?: AnthropicLike;
  /** Factory used when `client` is not supplied. Defaults to lazy-loading @anthropic-ai/sdk. */
  clientFactory?: (apiKey: string) => Promise<AnthropicLike>;
}

const DEFAULT_MODEL = "claude-sonnet-4-6";
/**
 * Output budget for worker calls is larger than review — a patch with
 * a few hunks can easily run 4-5K output tokens, and truncating the
 * patch midway corrupts the diff.
 */
const DEFAULT_MAX_TOKENS = 16_384;

async function defaultClientFactory(apiKey: string): Promise<AnthropicLike> {
  const mod = (await import("@anthropic-ai/sdk")) as unknown as {
    default: new (opts: { apiKey: string }) => AnthropicLike;
  };
  const Ctor = mod.default;
  return new Ctor({ apiKey });
}

/**
 * ClaudeWorker — turns Council blockers into a unified-diff patch.
 *
 * Deliberately does NOT implement `Agent` (which is a review-producing
 * interface). A worker consumes reviews and emits a patch; conflating
 * the two at the type level would force either side to carry fields
 * the other doesn't use.
 *
 * The worker is pure w.r.t. the filesystem — it never reads files or
 * shells out to git. The caller (typically the `conclave rework` CLI)
 * is responsible for reading file snapshots, applying the returned
 * patch, and committing back to the PR branch. That separation lets
 * us unit-test the LLM layer without a git fixture.
 */
export class ClaudeWorker {
  readonly id = "worker";
  readonly displayName = "Worker";

  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly gate: EfficiencyGate;
  private readonly clientFactory: (apiKey: string) => Promise<AnthropicLike>;
  private clientPromise: Promise<AnthropicLike> | null;

  constructor(opts: ClaudeWorkerOptions = {}) {
    const key = opts.apiKey ?? process.env["ANTHROPIC_API_KEY"] ?? "";
    if (!key && !opts.client) {
      throw new Error(
        "ClaudeWorker: ANTHROPIC_API_KEY not set (pass opts.apiKey, opts.client, or the env var)",
      );
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

  async work(ctx: WorkerContext): Promise<WorkerOutcome> {
    const cacheablePrefix = buildCacheablePrefix(ctx);
    const userPrompt = buildWorkerPrompt(ctx);
    const inputTokenEstimate = estimateTokens(cacheablePrefix) + estimateTokens(userPrompt);
    const estimatedCost = estimateCallCost(this.model, inputTokenEstimate, this.maxTokens);

    const outcome = await this.gate.run<Omit<WorkerOutcome, "tokensUsed" | "costUsd">>(
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
        const params: AnthropicCreateParams = {
          model,
          max_tokens: this.maxTokens,
          system: [{ type: "text", text: cacheablePrefix, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: userPrompt }],
          tools: [
            {
              name: PATCH_TOOL_NAME,
              description: PATCH_TOOL_DESCRIPTION,
              input_schema: PATCH_TOOL_INPUT_SCHEMA,
            },
          ],
          tool_choice: { type: "tool", name: PATCH_TOOL_NAME },
        };
        const response: AnthropicResponse = await client.messages.create(params);
        const latencyMs = Date.now() - started;

        const parsed = parsePatchToolUse(response);
        const cost = actualCost(model, {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheCreationTokens: response.usage.cache_creation_input_tokens,
          cacheReadTokens: response.usage.cache_read_input_tokens,
        });

        return {
          result: parsed,
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          costUsd: cost,
          latencyMs,
        };
      },
    );

    return {
      ...outcome.result,
      tokensUsed: outcome.metric.inputTokens + outcome.metric.outputTokens,
      costUsd: outcome.metric.costUsd,
    };
  }
}

export { WORKER_SYSTEM_PROMPT };
