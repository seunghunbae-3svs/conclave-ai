import type { Agent, Blocker, ReviewContext, ReviewResult } from "@conclave-ai/core";
import { EfficiencyGate, estimateTokens } from "@conclave-ai/core";
import {
  REVIEW_TOOL_NAME,
  REVIEW_TOOL_DESCRIPTION,
  REVIEW_TOOL_INPUT_SCHEMA,
  SYSTEM_PROMPT,
  TEXT_UI_SYSTEM_PROMPT,
  AUDIT_SYSTEM_PROMPT,
  buildUserPrompt,
  buildTextUIPrompt,
  buildAuditPrompt,
} from "./prompts.js";
import { diffTouchesUi, isUiPath } from "./ui-globs.js";
import { extractUiDiff, MAX_UI_DIFF_CHARS } from "./text-ui-extract.js";

/**
 * Minimal shape of the Anthropic vision-capable messages API. Narrowed so
 * tests can inject a mock without loading the SDK.
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
  tools?: ReadonlyArray<{
    name: string;
    description: string;
    input_schema: unknown;
  }>;
  tool_choice?: { type: "tool"; name: string } | { type: "auto" } | { type: "any" };
}

export interface AnthropicResponse {
  id?: string;
  model?: string;
  content: ReadonlyArray<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
  >;
  stop_reason?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export interface DesignAgentOptions {
  apiKey?: string;
  /** Override the vision model. Defaults to `claude-opus-4-7` (authoritative tier). */
  model?: string;
  maxTokens?: number;
  /** Shared efficiency gate. If omitted, the agent creates its own. */
  gate?: EfficiencyGate;
  /** For tests / alternate providers — inject a Messages-compatible client. */
  client?: AnthropicLike;
  /** Factory used when `client` is not supplied. Defaults to lazy-loading @anthropic-ai/sdk. */
  clientFactory?: (apiKey: string) => Promise<AnthropicLike>;
}

const DEFAULT_MODEL = "claude-opus-4-7";
const DEFAULT_MAX_TOKENS = 4_096;

async function defaultClientFactory(apiKey: string): Promise<AnthropicLike> {
  const mod = (await import("@anthropic-ai/sdk")) as unknown as {
    default: new (opts: { apiKey: string }) => AnthropicLike;
  };
  const Ctor = mod.default;
  return new Ctor({ apiKey });
}

/**
 * DesignAgent — primary visual design reviewer. Consumes
 * `ctx.visualArtifacts` (before/after PNG pairs), sends them to a
 * vision-capable Claude model, and returns a standard `ReviewResult`
 * so the Council debate loop treats it identically to the text-based
 * reviewers.
 *
 * When no artifacts are attached to `ctx`, returns a graceful
 * `approve` verdict with a summary flagging the missing artifacts —
 * never throws. This keeps design domain useful during v0.5.0-alpha
 * before the screenshot capture pipeline lands on `review`.
 */
export class DesignAgent implements Agent {
  readonly id = "design";
  readonly displayName = "Design";

  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly gate: EfficiencyGate;
  private readonly clientFactory: (apiKey: string) => Promise<AnthropicLike>;
  private clientPromise: Promise<AnthropicLike> | null;

  constructor(opts: DesignAgentOptions = {}) {
    const key = opts.apiKey ?? process.env["ANTHROPIC_API_KEY"] ?? "";
    if (!key && !opts.client) {
      throw new Error(
        "DesignAgent: ANTHROPIC_API_KEY not set (pass opts.apiKey, opts.client, or the env var)",
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

  async review(ctx: ReviewContext): Promise<ReviewResult> {
    // v0.6.0 — audit mode. Full file contents in `ctx.diff`, UI paths in
    // `ctx.auditFiles`. If no UI files are in the batch, graceful approve.
    if (ctx.mode === "audit") {
      return this.reviewAudit(ctx);
    }
    const artifacts = ctx.visualArtifacts ?? [];
    // Mode A — vision: screenshots present. Highest-signal mode; always
    // wins over Mode B when both are available.
    if (artifacts.length > 0) {
      return this.reviewVision(ctx, artifacts);
    }
    // Mode B — text-UI: no screenshots, but the diff touches UI code.
    // Reason about rendered intent from the source alone.
    if (diffTouchesUi(ctx.diff)) {
      return this.reviewTextUI(ctx);
    }
    // Mode C — skip: no screenshots, no UI code. Graceful approve so
    // the council doesn't treat the absence of signal as a block.
    return {
      agent: this.id,
      verdict: "approve",
      blockers: [],
      summary:
        "skipped — no visual artifacts and no UI-relevant files in the diff. Design agent has nothing to review; approving by default.",
    };
  }

  /**
   * v0.6.0 — audit mode. The batch's full file contents arrive in
   * `ctx.diff` and the list of files in `ctx.auditFiles`. We filter down
   * to UI-relevant files and, when there are any, run a design-focused
   * audit prompt. When there are none, graceful approve.
   */
  private async reviewAudit(ctx: ReviewContext): Promise<ReviewResult> {
    const files = (ctx.auditFiles ?? []).filter((p) => isUiPath(p));
    if (files.length === 0) {
      return {
        agent: this.id,
        verdict: "approve",
        blockers: [],
        summary:
          "skipped — no UI-relevant files in this audit batch. Nothing to review from the design lens.",
      };
    }
    const userText = buildAuditPrompt(ctx, ctx.diff, files);
    const inputTokenEstimate =
      estimateTokens(AUDIT_SYSTEM_PROMPT) + estimateTokens(userText);
    const estimatedCostUsd =
      (inputTokenEstimate * 15) / 1_000_000 + (this.maxTokens * 75) / 1_000_000;

    const outcome = await this.gate.run<ReviewResult>(
      {
        agent: this.id,
        cacheablePrefix: AUDIT_SYSTEM_PROMPT,
        prompt: AUDIT_SYSTEM_PROMPT + "\n" + userText,
        estimatedCostUsd,
        forceModel: this.model,
      },
      async ({ model }) => {
        const started = Date.now();
        const client = await this.getClient();
        const response = await client.messages.create({
          model,
          max_tokens: this.maxTokens,
          system: [
            { type: "text", text: AUDIT_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
          ],
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: userText },
                {
                  type: "text",
                  text: "Respond by calling submit_review exactly once.",
                },
              ],
            },
          ],
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

        const parsed = parseReviewResponse(response, this.id);
        const usage = response.usage ?? { input_tokens: 0, output_tokens: 0 };
        const costUsd = estimateActualCost(model, usage);

        return {
          result: {
            ...parsed,
            tokensUsed: usage.input_tokens + usage.output_tokens,
            costUsd,
          },
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          costUsd,
          latencyMs,
        };
      },
    );

    return outcome.result;
  }

  /**
   * Mode A — vision review. v0.6.4 adds optional brand-reference images
   * (ctx.designReferences) rendered ahead of the PR before/after pairs
   * so the model sees "what this brand looks like when it's right"
   * before judging the diff.
   */
  private async reviewVision(
    ctx: ReviewContext,
    artifacts: NonNullable<ReviewContext["visualArtifacts"]>,
  ): Promise<ReviewResult> {
    const routes = artifacts.map((a) => a.route);
    const userText = buildUserPrompt(ctx, routes);
    const designRefs = ctx.designReferences ?? [];
    // Rough token estimate for budget reservation. Images cost ~1.5k tokens
    // each for Anthropic vision; we over-estimate to stay safe.
    const perImageTokens = 1_500;
    const inputTokenEstimate =
      estimateTokens(SYSTEM_PROMPT) +
      estimateTokens(userText) +
      (artifacts.length * 2 + designRefs.length) * perImageTokens;
    // Rough pre-flight cost. EfficiencyGate only uses this to reserve
    // against the per-PR budget; it does not gate on the exact number.
    // We pick a conservative USD/1M-input-tokens figure for Opus vision.
    const estimatedCostUsd = (inputTokenEstimate * 15) / 1_000_000 + (this.maxTokens * 75) / 1_000_000;

    const outcome = await this.gate.run<ReviewResult>(
      {
        agent: this.id,
        cacheablePrefix: SYSTEM_PROMPT,
        prompt: SYSTEM_PROMPT + "\n" + userText,
        estimatedCostUsd,
        forceModel: this.model,
      },
      async ({ model }) => {
        const started = Date.now();
        const client = await this.getClient();
        const content = buildVisionContent(userText, artifacts, designRefs);
        const response = await client.messages.create({
          model,
          max_tokens: this.maxTokens,
          system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content }],
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

        const parsed = parseReviewResponse(response, this.id);
        const usage = response.usage ?? { input_tokens: 0, output_tokens: 0 };
        const costUsd = estimateActualCost(model, usage);

        return {
          result: {
            ...parsed,
            tokensUsed: usage.input_tokens + usage.output_tokens,
            costUsd,
          },
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          costUsd,
          latencyMs,
        };
      },
    );

    return outcome.result;
  }

  /**
   * Mode B — text-UI review. No screenshots, but the diff touches UI
   * files. Extract the UI-only hunks, cap to `MAX_UI_DIFF_CHARS`, and
   * send to a design-focused prompt that reasons about rendered intent.
   *
   * Uses the same `submit_review` tool schema as Mode A so response
   * parsing is shared.
   */
  private async reviewTextUI(ctx: ReviewContext): Promise<ReviewResult> {
    const extracted = extractUiDiff(ctx.diff, MAX_UI_DIFF_CHARS);
    const textUIOpts: {
      truncated?: boolean;
      projectContext?: string;
      designContext?: string;
    } = { truncated: extracted.truncated };
    if (ctx.projectContext) textUIOpts.projectContext = ctx.projectContext;
    if (ctx.designContext) textUIOpts.designContext = ctx.designContext;
    const userText = buildTextUIPrompt(ctx, extracted.text, extracted.files, textUIOpts);
    const inputTokenEstimate =
      estimateTokens(TEXT_UI_SYSTEM_PROMPT) + estimateTokens(userText);
    const estimatedCostUsd =
      (inputTokenEstimate * 15) / 1_000_000 + (this.maxTokens * 75) / 1_000_000;

    const outcome = await this.gate.run<ReviewResult>(
      {
        agent: this.id,
        cacheablePrefix: TEXT_UI_SYSTEM_PROMPT,
        prompt: TEXT_UI_SYSTEM_PROMPT + "\n" + userText,
        estimatedCostUsd,
        forceModel: this.model,
      },
      async ({ model }) => {
        const started = Date.now();
        const client = await this.getClient();
        const response = await client.messages.create({
          model,
          max_tokens: this.maxTokens,
          system: [
            { type: "text", text: TEXT_UI_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
          ],
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: userText },
                {
                  type: "text",
                  text: "Respond by calling submit_review exactly once.",
                },
              ],
            },
          ],
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

        const parsed = parseReviewResponse(response, this.id);
        const usage = response.usage ?? { input_tokens: 0, output_tokens: 0 };
        const costUsd = estimateActualCost(model, usage);

        return {
          result: {
            ...parsed,
            tokensUsed: usage.input_tokens + usage.output_tokens,
            costUsd,
          },
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          costUsd,
          latencyMs,
        };
      },
    );

    return outcome.result;
  }
}

/**
 * Turn each (before, after) pair into an interleaved text + image block
 * sequence, prefaced by the textual prompt. Anthropic's vision API
 * accepts multiple images per user message; we clearly label each so the
 * model doesn't confuse ordering.
 */
function buildVisionContent(
  userText: string,
  artifacts: ReadonlyArray<{ before: Buffer | string; after: Buffer | string; route: string }>,
  designReferences: ReadonlyArray<{ filename: string; bytes: Buffer | Uint8Array }> = [],
): Array<
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: "image/png"; data: string } }
> {
  const blocks: Array<
    | { type: "text"; text: string }
    | { type: "image"; source: { type: "base64"; media_type: "image/png"; data: string } }
  > = [{ type: "text", text: userText }];
  // v0.6.4 — brand reference images come FIRST so the model sees what
  // "good" looks like before it judges the PR's before/after pair. Each
  // gets an explicit "Brand reference" label so ordering can't be
  // confused with visualArtifacts.
  if (designReferences.length > 0) {
    blocks.push({
      type: "text",
      text: `--- Brand reference images (use these as the visual target for this product's brand) ---`,
    });
    for (const ref of designReferences) {
      blocks.push({ type: "text", text: `--- Brand reference: ${ref.filename} ---` });
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: "image/png", data: toBase64(ref.bytes) },
      });
    }
    blocks.push({
      type: "text",
      text: `--- End brand references. PR-specific before/after pairs follow. ---`,
    });
  }
  for (const art of artifacts) {
    blocks.push({ type: "text", text: `--- Route: ${art.route} — BEFORE ---` });
    blocks.push({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: toBase64(art.before) },
    });
    blocks.push({ type: "text", text: `--- Route: ${art.route} — AFTER ---` });
    blocks.push({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: toBase64(art.after) },
    });
  }
  blocks.push({
    type: "text",
    text: "Respond by calling submit_review exactly once.",
  });
  return blocks;
}

function toBase64(input: Buffer | Uint8Array | string): string {
  if (typeof input === "string") {
    // Treat the string as already-base64. Stripping whitespace/newlines
    // guards against accidental pretty-printing.
    return input.replace(/\s+/g, "");
  }
  return Buffer.from(input).toString("base64");
}

function parseReviewResponse(response: AnthropicResponse, agentId: string): ReviewResult {
  const toolUse = response.content.find(
    (block): block is Extract<(typeof response.content)[number], { type: "tool_use" }> =>
      block.type === "tool_use" && block.name === REVIEW_TOOL_NAME,
  );
  if (!toolUse) {
    return errorResult(
      agentId,
      `design agent: response did not include a ${REVIEW_TOOL_NAME} tool_use block (stop_reason=${response.stop_reason ?? "?"}).`,
    );
  }
  const input = toolUse.input as {
    verdict?: unknown;
    blockers?: unknown;
    summary?: unknown;
  };
  const verdict = input.verdict;
  if (verdict !== "approve" && verdict !== "rework" && verdict !== "reject") {
    return errorResult(
      agentId,
      `design agent: invalid verdict "${String(verdict)}" in tool_use response.`,
    );
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
    verdict,
    blockers,
    summary: typeof input.summary === "string" ? input.summary : "",
  };
}

/**
 * Graceful error shape — returned in place of throwing when the vision
 * response can't be parsed. Rendered as a `rework` so the council
 * doesn't mistake a tool-call failure for a clean approve.
 */
function errorResult(agentId: string, reason: string): ReviewResult {
  return {
    agent: agentId,
    verdict: "rework",
    blockers: [
      {
        severity: "major",
        category: "agent-error",
        message: reason,
      },
    ],
    summary: reason,
  };
}

/**
 * Approximate USD cost for a vision call on Claude Opus 4.7. We don't
 * import `@conclave-ai/agent-claude`'s pricing table to keep the
 * dependency graph tight; the efficiency gate uses this only for the
 * per-PR budget accounting. Accuracy within ~20% is good enough.
 */
function estimateActualCost(
  model: string,
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number },
): number {
  // Defaults: claude-opus-4-7 — $15/1M input, $75/1M output.
  let inputPerMTok = 15;
  let outputPerMTok = 75;
  let cacheReadPerMTok = 1.5;
  let cacheWritePerMTok = 18.75;
  if (model === "claude-haiku-4-5") {
    inputPerMTok = 0.25;
    outputPerMTok = 1.25;
    cacheReadPerMTok = 0.025;
    cacheWritePerMTok = 0.3125;
  } else if (model === "claude-sonnet-4-6") {
    inputPerMTok = 3;
    outputPerMTok = 15;
    cacheReadPerMTok = 0.3;
    cacheWritePerMTok = 3.75;
  }
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const baseInput = Math.max(0, usage.input_tokens - cacheRead - cacheWrite);
  return (
    (baseInput * inputPerMTok +
      cacheRead * cacheReadPerMTok +
      cacheWrite * cacheWritePerMTok +
      usage.output_tokens * outputPerMTok) /
    1_000_000
  );
}
