# @ai-conclave/observability-langfuse

Langfuse sink for Ai-Conclave's efficiency-gate metrics. Forwards every
LLM call's cost / tokens / latency / cache-hit to Langfuse for trace
inspection.

Self-hosted is the intended deployment target per decision #13. Cloud
works identically — pass the cloud base URL.

## Install

```bash
pnpm add @ai-conclave/observability-langfuse @ai-conclave/core
```

## Usage

```ts
import { EfficiencyGate, MetricsRecorder } from "@ai-conclave/core";
import { LangfuseMetricsSink } from "@ai-conclave/observability-langfuse";

const sink = new LangfuseMetricsSink({
  publicKey: process.env.LANGFUSE_PUBLIC_KEY,
  secretKey: process.env.LANGFUSE_SECRET_KEY,
  baseUrl: process.env.LANGFUSE_BASEURL, // self-hosted URL (optional for cloud)
});

const gate = new EfficiencyGate({
  metrics: new MetricsRecorder({ sink }),
});
```

Call `sink.shutdown()` at process exit to flush pending events.

## Env variables

| Variable | Required | Purpose |
|---|---|---|
| `LANGFUSE_PUBLIC_KEY` | ✓ | Public key from your Langfuse project |
| `LANGFUSE_SECRET_KEY` | ✓ | Secret key from your Langfuse project |
| `LANGFUSE_BASEURL` | optional | Self-hosted URL (defaults to Langfuse cloud) |
