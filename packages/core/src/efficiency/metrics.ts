export interface CallMetric {
  agent: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  cacheHit: boolean;
  timestamp: number;
}

export interface MetricsSummary {
  callCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  totalLatencyMs: number;
  cacheHitRate: number;
  byAgent: Record<string, { calls: number; costUsd: number }>;
  byModel: Record<string, { calls: number; costUsd: number }>;
}

export interface MetricsSink {
  record(metric: CallMetric): void;
}

/**
 * MetricsRecorder — collects per-call metrics in memory and optionally
 * forwards to an external sink (Langfuse self-hosted planned; stub here).
 *
 * Real Langfuse OTLP wiring lands when observability package is added;
 * until then this is the source of truth for cost/tokens/latency.
 */
export class MetricsRecorder {
  private readonly records: CallMetric[] = [];
  private readonly sink: MetricsSink | undefined;

  constructor(opts: { sink?: MetricsSink } = {}) {
    this.sink = opts.sink;
  }

  record(metric: CallMetric): void {
    this.records.push(metric);
    this.sink?.record(metric);
  }

  all(): readonly CallMetric[] {
    return this.records;
  }

  summary(): MetricsSummary {
    if (this.records.length === 0) {
      return {
        callCount: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCostUsd: 0,
        totalLatencyMs: 0,
        cacheHitRate: 0,
        byAgent: {},
        byModel: {},
      };
    }

    const byAgent: Record<string, { calls: number; costUsd: number }> = {};
    const byModel: Record<string, { calls: number; costUsd: number }> = {};
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    let latencyMs = 0;
    let cacheHits = 0;

    for (const r of this.records) {
      inputTokens += r.inputTokens;
      outputTokens += r.outputTokens;
      costUsd += r.costUsd;
      latencyMs += r.latencyMs;
      if (r.cacheHit) cacheHits += 1;
      const ag = byAgent[r.agent] ?? { calls: 0, costUsd: 0 };
      ag.calls += 1;
      ag.costUsd += r.costUsd;
      byAgent[r.agent] = ag;
      const md = byModel[r.model] ?? { calls: 0, costUsd: 0 };
      md.calls += 1;
      md.costUsd += r.costUsd;
      byModel[r.model] = md;
    }

    return {
      callCount: this.records.length,
      totalInputTokens: inputTokens,
      totalOutputTokens: outputTokens,
      totalCostUsd: costUsd,
      totalLatencyMs: latencyMs,
      cacheHitRate: cacheHits / this.records.length,
      byAgent,
      byModel,
    };
  }

  reset(): void {
    this.records.length = 0;
  }
}
