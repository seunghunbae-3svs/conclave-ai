/**
 * ClaudeHaikuPlainSummaryLlm — the default `PlainSummaryLlm` impl for the
 * CLI. One cheap Anthropic call per summary, claude-haiku-4-5 by default.
 *
 * Kept in the CLI package (not core) because:
 *   - it pulls @anthropic-ai/sdk, which core must not depend on
 *   - alternate hosts (Workers, central plane, self-hosted) may prefer to
 *     implement their own `PlainSummaryLlm` (OpenAI, local, etc.) —
 *     keeping the interface in core + adapter here means any package can
 *     build its own without a core change.
 */
import type { PlainSummaryLlm } from "@conclave-ai/core";
import { resolveKey } from "./credentials.js";

const DEFAULT_MODEL = "claude-haiku-4-5";
const DEFAULT_MAX_TOKENS = 512;

interface AnthropicLike {
  messages: {
    create(params: {
      model: string;
      max_tokens: number;
      system?: string;
      messages: ReadonlyArray<{ role: "user" | "assistant"; content: string }>;
      temperature?: number;
    }): Promise<{
      content: ReadonlyArray<{ type: string; text?: string }>;
    }>;
  };
}

export interface ClaudeHaikuPlainSummaryLlmOptions {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  /** Injected for tests — skips the real SDK load. */
  client?: AnthropicLike;
  clientFactory?: (apiKey: string) => Promise<AnthropicLike>;
}

async function defaultClientFactory(apiKey: string): Promise<AnthropicLike> {
  const mod = (await import("@anthropic-ai/sdk")) as unknown as {
    default: new (opts: { apiKey: string }) => AnthropicLike;
  };
  const Ctor = mod.default;
  return new Ctor({ apiKey });
}

export class ClaudeHaikuPlainSummaryLlm implements PlainSummaryLlm {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly clientFactory: (apiKey: string) => Promise<AnthropicLike>;
  private clientPromise: Promise<AnthropicLike> | null;

  constructor(opts: ClaudeHaikuPlainSummaryLlmOptions = {}) {
    // v0.7.4 — resolveKey honors env first, then stored credentials.
    const key = opts.apiKey ?? resolveKey("anthropic") ?? "";
    if (!key && !opts.client) {
      throw new Error(
        "ClaudeHaikuPlainSummaryLlm: anthropic key not set (run `conclave config` or pass opts.apiKey)",
      );
    }
    this.apiKey = key;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.clientFactory = opts.clientFactory ?? defaultClientFactory;
    this.clientPromise = opts.client ? Promise.resolve(opts.client) : null;
  }

  private async getClient(): Promise<AnthropicLike> {
    if (!this.clientPromise) {
      this.clientPromise = this.clientFactory(this.apiKey);
    }
    return this.clientPromise;
  }

  async summarize(input: { system: string; user: string }): Promise<string> {
    const client = await this.getClient();
    const resp = await client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: input.system,
      messages: [{ role: "user", content: input.user }],
      temperature: 0.3,
    });
    const text = resp.content
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("\n")
      .trim();
    if (!text) {
      throw new Error("ClaudeHaikuPlainSummaryLlm: empty text response");
    }
    return text;
  }
}
