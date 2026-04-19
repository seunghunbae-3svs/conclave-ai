import type { CallMetric, MetricsSink } from "@ai-conclave/core";

/**
 * Minimal subset of the Langfuse SDK surface the sink consumes. Typed
 * narrowly so tests never instantiate the real client and SDK minor
 * version bumps don't break the build.
 */
export interface LangfuseLike {
  generation(params: LangfuseGenerationParams): LangfuseGenerationHandle;
  flushAsync(): Promise<void>;
  shutdownAsync?(): Promise<void>;
}

export interface LangfuseGenerationParams {
  name: string;
  model: string;
  startTime?: Date;
  endTime?: Date;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  usage?: {
    input?: number;
    output?: number;
    total?: number;
    unit?: "TOKENS" | "CHARACTERS";
    inputCost?: number;
    outputCost?: number;
    totalCost?: number;
  };
  traceId?: string;
}

export interface LangfuseGenerationHandle {
  end(update?: Partial<LangfuseGenerationParams>): void;
}

export interface LangfuseSinkOptions {
  /** Pre-built Langfuse client. Used by tests + callers who want shared state. */
  client?: LangfuseLike;
  /** Factory invoked when `client` is not supplied. Defaults to lazy import of `langfuse`. */
  clientFactory?: () => Promise<LangfuseLike>;
  /** Host override for self-hosted (decision #13). Defaults to env LANGFUSE_BASEURL. */
  baseUrl?: string;
  publicKey?: string;
  secretKey?: string;
  /** Optional trace id so all metrics in a single review share a parent span. */
  traceId?: string;
}

async function defaultClientFactory(opts: LangfuseSinkOptions): Promise<LangfuseLike> {
  const publicKey = opts.publicKey ?? process.env["LANGFUSE_PUBLIC_KEY"];
  const secretKey = opts.secretKey ?? process.env["LANGFUSE_SECRET_KEY"];
  const baseUrl = opts.baseUrl ?? process.env["LANGFUSE_BASEURL"];
  if (!publicKey || !secretKey) {
    throw new Error("LangfuseMetricsSink: LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY required");
  }
  const mod = (await import("langfuse")) as unknown as {
    Langfuse: new (opts: {
      publicKey: string;
      secretKey: string;
      baseUrl?: string;
    }) => LangfuseLike;
  };
  const ctorOpts: { publicKey: string; secretKey: string; baseUrl?: string } = {
    publicKey,
    secretKey,
  };
  if (baseUrl) ctorOpts.baseUrl = baseUrl;
  return new mod.Langfuse(ctorOpts);
}

/**
 * LangfuseMetricsSink — drops in as the `sink` on `MetricsRecorder`.
 * Every per-call metric becomes a Langfuse `generation` (the SDK's model
 * for a single LLM invocation).
 *
 * The sink is fire-and-forget on the record() path (synchronous per
 * MetricsSink contract); actual HTTP is Langfuse's internal queue. Call
 * `shutdown()` at process exit to flush pending events.
 *
 * Self-hosted Langfuse is the deployment target per decision #13. Cloud
 * works identically (`baseUrl` omitted or set to the cloud URL).
 */
export class LangfuseMetricsSink implements MetricsSink {
  private readonly opts: LangfuseSinkOptions;
  private readonly clientFactory: () => Promise<LangfuseLike>;
  private clientPromise: Promise<LangfuseLike> | null;
  private clientReady: LangfuseLike | null;
  private traceId: string | undefined;

  constructor(opts: LangfuseSinkOptions = {}) {
    this.opts = opts;
    this.clientFactory = opts.clientFactory ?? (() => defaultClientFactory(opts));
    this.clientPromise = opts.client ? Promise.resolve(opts.client) : null;
    this.clientReady = opts.client ?? null;
    this.traceId = opts.traceId;
  }

  setTraceId(id: string | undefined): void {
    this.traceId = id;
  }

  /**
   * MetricsSink.record is synchronous — we kick off the Langfuse call and
   * let the SDK queue handle delivery. Errors are swallowed to stderr so
   * observability failure never kills a running review.
   */
  record(metric: CallMetric): void {
    this.submit(metric).catch((err) => {
      process.stderr.write(
        `[langfuse] failed to record metric for ${metric.agent}/${metric.model}: ${(err as Error).message}\n`,
      );
    });
  }

  private async submit(metric: CallMetric): Promise<void> {
    const client = await this.getClient();
    const startTime = new Date(metric.timestamp - metric.latencyMs);
    const endTime = new Date(metric.timestamp);
    const params: LangfuseGenerationParams = {
      name: `review.${metric.agent}`,
      model: metric.model,
      startTime,
      endTime,
      usage: {
        input: metric.inputTokens,
        output: metric.outputTokens,
        total: metric.inputTokens + metric.outputTokens,
        unit: "TOKENS",
        totalCost: metric.costUsd,
      },
      metadata: {
        cacheHit: metric.cacheHit,
        latencyMs: metric.latencyMs,
      },
    };
    if (this.traceId) params.traceId = this.traceId;
    const gen = client.generation(params);
    // Generations in the Langfuse SDK expect an `end()` call to finalize.
    gen.end();
  }

  private async getClient(): Promise<LangfuseLike> {
    if (!this.clientPromise) this.clientPromise = this.clientFactory();
    if (!this.clientReady) this.clientReady = await this.clientPromise;
    return this.clientReady;
  }

  async flush(): Promise<void> {
    if (!this.clientPromise) return;
    const client = await this.clientPromise;
    await client.flushAsync();
  }

  async shutdown(): Promise<void> {
    if (!this.clientPromise) return;
    const client = await this.clientPromise;
    if (client.shutdownAsync) await client.shutdownAsync();
    else await client.flushAsync();
  }
}
