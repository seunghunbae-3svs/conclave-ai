import type { Agent, ReviewContext, ReviewResult } from "@ai-conclave/core";

export interface ClaudeAgentOptions {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
}

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_TOKENS = 4096;

/**
 * ClaudeAgent — wraps Anthropic's Claude SDK for council review.
 *
 * Skeleton status: interface correct, implementation returns a stub
 * "approve" verdict. The real tool-use loop with
 * @anthropic-ai/claude-agent-sdk (official TS, bundles MCP + tool_use +
 * compaction) lands in a subsequent PR together with the efficiency
 * gate and RAG-over-answer-keys.
 */
export class ClaudeAgent implements Agent {
  readonly id = "claude";
  readonly displayName = "Claude";

  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxTokens: number;

  constructor(opts: ClaudeAgentOptions = {}) {
    const key = opts.apiKey ?? process.env["ANTHROPIC_API_KEY"] ?? "";
    if (!key) {
      throw new Error("ClaudeAgent: ANTHROPIC_API_KEY not set (pass opts.apiKey or env var)");
    }
    this.apiKey = key;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  async review(ctx: ReviewContext): Promise<ReviewResult> {
    // Skeleton — real implementation will call the SDK with a tool-use
    // loop, RAG context from answer-keys + failure-catalog, and cost
    // metering through the efficiency gate.
    void ctx;
    void this.apiKey;
    void this.model;
    void this.maxTokens;
    return {
      agent: this.id,
      verdict: "approve",
      blockers: [],
      summary: "ClaudeAgent skeleton — real review logic pending.",
    };
  }
}
