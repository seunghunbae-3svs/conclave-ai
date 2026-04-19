import { test } from "node:test";
import assert from "node:assert/strict";
import { EfficiencyGate, BudgetExceededError } from "../dist/index.js";

async function fakeExecute(spec) {
  return async ({ model, cacheHit }) => ({
    result: { ok: true, model, cacheHit },
    inputTokens: spec.inputTokens ?? 1_000,
    outputTokens: spec.outputTokens ?? 200,
    costUsd: spec.costUsd ?? 0.015,
    latencyMs: spec.latencyMs ?? 1_100,
  });
}

test("EfficiencyGate.run: happy path routes, executes, records", async () => {
  const gate = new EfficiencyGate({ perPrUsd: 1 });
  const { result, metric, modelChoice } = await gate.run(
    {
      agent: "claude",
      cacheablePrefix: "system + pinned RAG",
      prompt: "some prompt",
      estimatedCostUsd: 0.02,
    },
    await fakeExecute({ costUsd: 0.017 }),
  );
  assert.equal(result.ok, true);
  assert.equal(metric.costUsd, 0.017);
  assert.equal(metric.agent, "claude");
  assert.equal(modelChoice.class, "haiku");
  assert.equal(gate.budget.spentUsd, 0.017);
});

test("EfficiencyGate.run: second identical call sees cacheHit = true", async () => {
  const gate = new EfficiencyGate({ perPrUsd: 1 });
  const input = {
    agent: "claude",
    cacheablePrefix: "identical prefix",
    prompt: "p",
    estimatedCostUsd: 0.01,
  };
  const first = await gate.run(input, await fakeExecute({ costUsd: 0.005 }));
  assert.equal(first.result.cacheHit, false);
  const second = await gate.run(input, await fakeExecute({ costUsd: 0.001 }));
  assert.equal(second.result.cacheHit, true);
});

test("EfficiencyGate.run: reserve throws BudgetExceededError before execute runs", async () => {
  const gate = new EfficiencyGate({ perPrUsd: 0.1 });
  let executed = false;
  await assert.rejects(
    () =>
      gate.run(
        {
          agent: "claude",
          cacheablePrefix: "x",
          prompt: "p",
          estimatedCostUsd: 0.5, // blows the cap
        },
        async () => {
          executed = true;
          throw new Error("should not run");
        },
      ),
    (err) => err instanceof BudgetExceededError,
  );
  assert.equal(executed, false);
});

test("EfficiencyGate.run: forceModel honored", async () => {
  const gate = new EfficiencyGate({ perPrUsd: 1 });
  const { modelChoice } = await gate.run(
    {
      agent: "claude",
      cacheablePrefix: "p",
      prompt: "p",
      estimatedCostUsd: 0.01,
      forceModel: "claude-opus-4-7",
    },
    await fakeExecute({ costUsd: 0.01 }),
  );
  assert.equal(modelChoice.model, "claude-opus-4-7");
});

test("EfficiencyGate.run: multiple calls aggregate metrics", async () => {
  const gate = new EfficiencyGate({ perPrUsd: 1 });
  for (let i = 0; i < 3; i += 1) {
    await gate.run(
      { agent: "claude", cacheablePrefix: `p${i}`, prompt: "p", estimatedCostUsd: 0.01 },
      await fakeExecute({ costUsd: 0.01 }),
    );
  }
  const s = gate.metrics.summary();
  assert.equal(s.callCount, 3);
  assert.equal(s.totalCostUsd.toFixed(3), "0.030");
});
