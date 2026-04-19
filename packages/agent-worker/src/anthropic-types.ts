/**
 * Minimal shape of the Anthropic SDK client that ClaudeWorker needs.
 * Structurally identical to the one in agent-claude — duplicated here
 * rather than imported so each agent package can evolve independently
 * and so tests can inject mocks without pulling the agent-claude build.
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
