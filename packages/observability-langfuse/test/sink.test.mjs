import { test } from "node:test";
import assert from "node:assert/strict";
import { LangfuseMetricsSink } from "../dist/index.js";

function mockClient() {
  const generated = [];
  const ended = [];
  let flushes = 0;
  let shutdowns = 0;
  return {
    generated,
    ended,
    get flushes() {
      return flushes;
    },
    get shutdowns() {
      return shutdowns;
    },
    generation: (params) => {
      generated.push(params);
      return {
        end: (update) => {
          ended.push({ params, update });
        },
      };
    },
    flushAsync: async () => {
      flushes += 1;
    },
    shutdownAsync: async () => {
      shutdowns += 1;
    },
  };
}

function mkMetric(overrides = {}) {
  return {
    agent: "claude",
    model: "claude-sonnet-4-6",
    inputTokens: 1_000,
    outputTokens: 200,
    costUsd: 0.015,
    latencyMs: 1_200,
    cacheHit: false,
    timestamp: Date.now(),
    ...overrides,
  };
}

async function tick() {
  // Allow queued microtasks from record() to resolve.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

test("LangfuseMetricsSink: record() creates a generation with mapped usage", async () => {
  const client = mockClient();
  const sink = new LangfuseMetricsSink({ client });
  sink.record(mkMetric({ inputTokens: 500, outputTokens: 100, costUsd: 0.01 }));
  await tick();
  assert.equal(client.generated.length, 1);
  const g = client.generated[0];
  assert.equal(g.name, "review.claude");
  assert.equal(g.model, "claude-sonnet-4-6");
  assert.equal(g.usage.input, 500);
  assert.equal(g.usage.output, 100);
  assert.equal(g.usage.total, 600);
  assert.equal(g.usage.totalCost, 0.01);
  assert.equal(g.usage.unit, "TOKENS");
  assert.equal(client.ended.length, 1);
});

test("LangfuseMetricsSink: metadata carries cacheHit + latencyMs", async () => {
  const client = mockClient();
  const sink = new LangfuseMetricsSink({ client });
  sink.record(mkMetric({ cacheHit: true, latencyMs: 850 }));
  await tick();
  const g = client.generated[0];
  assert.equal(g.metadata.cacheHit, true);
  assert.equal(g.metadata.latencyMs, 850);
});

test("LangfuseMetricsSink: startTime / endTime derived from timestamp + latency", async () => {
  const client = mockClient();
  const sink = new LangfuseMetricsSink({ client });
  const now = 1_700_000_000_000;
  sink.record(mkMetric({ timestamp: now, latencyMs: 1_000 }));
  await tick();
  const g = client.generated[0];
  assert.equal(g.endTime.getTime(), now);
  assert.equal(g.startTime.getTime(), now - 1_000);
});

test("LangfuseMetricsSink: traceId propagates when set", async () => {
  const client = mockClient();
  const sink = new LangfuseMetricsSink({ client, traceId: "trace-123" });
  sink.record(mkMetric());
  await tick();
  assert.equal(client.generated[0].traceId, "trace-123");
});

test("LangfuseMetricsSink: setTraceId updates for subsequent records", async () => {
  const client = mockClient();
  const sink = new LangfuseMetricsSink({ client });
  sink.setTraceId("first");
  sink.record(mkMetric());
  sink.setTraceId("second");
  sink.record(mkMetric());
  await tick();
  assert.equal(client.generated[0].traceId, "first");
  assert.equal(client.generated[1].traceId, "second");
});

test("LangfuseMetricsSink: client errors are swallowed to stderr, not thrown", async () => {
  const client = {
    generation: () => {
      throw new Error("langfuse down");
    },
    flushAsync: async () => {},
  };
  const sink = new LangfuseMetricsSink({ client });
  // Capture stderr writes
  const origStderr = process.stderr.write.bind(process.stderr);
  const chunks = [];
  process.stderr.write = (c) => {
    chunks.push(String(c));
    return true;
  };
  try {
    sink.record(mkMetric()); // must not throw
    await tick();
  } finally {
    process.stderr.write = origStderr;
  }
  assert.match(chunks.join(""), /langfuse.*failed to record/i);
});

test("LangfuseMetricsSink: flush awaits client.flushAsync", async () => {
  const client = mockClient();
  const sink = new LangfuseMetricsSink({ client });
  sink.record(mkMetric());
  await tick();
  await sink.flush();
  assert.equal(client.flushes, 1);
});

test("LangfuseMetricsSink: shutdown prefers shutdownAsync over flushAsync", async () => {
  const client = mockClient();
  const sink = new LangfuseMetricsSink({ client });
  sink.record(mkMetric());
  await tick();
  await sink.shutdown();
  assert.equal(client.shutdowns, 1);
  assert.equal(client.flushes, 0);
});

test("LangfuseMetricsSink: shutdown falls back to flushAsync when shutdownAsync absent", async () => {
  const client = {
    generation: () => ({ end: () => {} }),
    flushAsync: async () => {},
  };
  let flushed = 0;
  client.flushAsync = async () => {
    flushed += 1;
  };
  const sink = new LangfuseMetricsSink({ client });
  sink.record(mkMetric());
  await tick();
  await sink.shutdown();
  assert.equal(flushed, 1);
});

test("LangfuseMetricsSink: lazy client init — no client request until first record()", async () => {
  let factoryCalls = 0;
  const client = mockClient();
  const sink = new LangfuseMetricsSink({
    clientFactory: async () => {
      factoryCalls += 1;
      return client;
    },
  });
  assert.equal(factoryCalls, 0);
  sink.record(mkMetric());
  await tick();
  assert.equal(factoryCalls, 1);
  sink.record(mkMetric());
  await tick();
  assert.equal(factoryCalls, 1, "factory should only be called once");
});
