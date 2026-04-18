import { test } from "node:test";
import assert from "node:assert/strict";
import { MetricsRecorder } from "../dist/index.js";

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

test("MetricsRecorder: empty summary", () => {
  const r = new MetricsRecorder();
  const s = r.summary();
  assert.equal(s.callCount, 0);
  assert.equal(s.totalCostUsd, 0);
  assert.equal(s.cacheHitRate, 0);
});

test("MetricsRecorder: aggregates by agent and model", () => {
  const r = new MetricsRecorder();
  r.record(mkMetric({ agent: "claude", model: "claude-sonnet-4-6", costUsd: 0.02 }));
  r.record(mkMetric({ agent: "claude", model: "claude-haiku-4-5", costUsd: 0.005 }));
  r.record(mkMetric({ agent: "openai", model: "gpt-4.1", costUsd: 0.03 }));
  const s = r.summary();
  assert.equal(s.callCount, 3);
  assert.equal(s.totalCostUsd.toFixed(3), "0.055");
  assert.equal(s.byAgent["claude"].calls, 2);
  assert.equal(s.byAgent["openai"].calls, 1);
  assert.equal(s.byModel["claude-sonnet-4-6"].costUsd, 0.02);
});

test("MetricsRecorder: cache hit rate", () => {
  const r = new MetricsRecorder();
  r.record(mkMetric({ cacheHit: true }));
  r.record(mkMetric({ cacheHit: true }));
  r.record(mkMetric({ cacheHit: false }));
  r.record(mkMetric({ cacheHit: false }));
  assert.equal(r.summary().cacheHitRate, 0.5);
});

test("MetricsRecorder: forwards to external sink", () => {
  const forwarded = [];
  const r = new MetricsRecorder({ sink: { record: (m) => forwarded.push(m) } });
  r.record(mkMetric({ agent: "claude" }));
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].agent, "claude");
});

test("MetricsRecorder: reset clears state", () => {
  const r = new MetricsRecorder();
  r.record(mkMetric());
  r.reset();
  assert.equal(r.summary().callCount, 0);
});
