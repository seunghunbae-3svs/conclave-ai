/**
 * Phase B.8 — budget enforcement.
 *
 * The user-facing promise: \`.conclaverc.json: budget.perPrUsd: 0.5\`
 * is a HARD ceiling. The system must:
 *   - throw before any LLM call that would push spend over the cap
 *   - keep accumulating across multi-call council runs (debate rounds)
 *   - keep accumulating across chunked diffs (H2 #9 splitter)
 *   - fire the warning callback at the configured threshold (default 80%)
 *   - guard against actual > estimated drift (the gate commits actual,
 *     so the next reserve sees it)
 *   - NEVER allow a single run to silently overspend the cap
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BudgetExceededError,
  BudgetTracker,
  EfficiencyGate,
} from "@conclave-ai/core";

test("B.8: hard cap — second reserve over the limit throws BudgetExceededError", () => {
  const t = new BudgetTracker({ perPrUsd: 1.0 });
  t.reserve(0.4);
  t.commit(0.4);
  t.reserve(0.5);
  t.commit(0.5);
  // spent = 0.9, cap = 1.0
  assert.throws(() => t.reserve(0.2), BudgetExceededError, "0.9 + 0.2 = 1.1 > 1.0 must throw");
  // remaining stays correct
  assert.equal(t.spentUsd, 0.9);
  assert.equal(Number(t.remainingUsd.toFixed(2)), 0.1);
});

test("B.8: actual > estimated — drift surfaces on the NEXT reserve, not silently absorbed", () => {
  const t = new BudgetTracker({ perPrUsd: 1.0 });
  // Estimate $0.10 but actual was $0.50 (4x overshoot — common for vision)
  t.reserve(0.1);
  t.commit(0.5);
  // Now claim $0.4 more — would seem fine via estimate, but spent is
  // already $0.5, so $0.5 + $0.4 = $0.9 ≤ cap → fine.
  t.reserve(0.4);
  t.commit(0.4);
  // Try $0.2 more — $0.9 + $0.2 = $1.1 > cap → throws.
  assert.throws(() => t.reserve(0.2), BudgetExceededError);
  assert.equal(t.spentUsd, 0.9);
});

test("B.8: warning callback fires once at the configured threshold (default 80%)", () => {
  const t = new BudgetTracker({ perPrUsd: 1.0 });
  let callCount = 0;
  let warnedAt = 0;
  t.onWarning((spent) => {
    callCount += 1;
    warnedAt = spent;
  });
  // Stay under 80% → no fire.
  t.reserve(0.5);
  t.commit(0.5);
  assert.equal(callCount, 0);
  // Cross 80% → fires once.
  t.reserve(0.4);
  t.commit(0.4);
  assert.equal(callCount, 1);
  assert.ok(warnedAt >= 0.8, `warned at ${warnedAt}, must be ≥ 0.8`);
  // Don't refire on subsequent commits within the cap.
  t.reserve(0.05);
  t.commit(0.05);
  assert.equal(callCount, 1, "warning is one-shot — does not refire");
});

test("B.8: warning fires again after raiseCap (multi-modal vision scaling)", () => {
  const t = new BudgetTracker({ perPrUsd: 1.0 });
  let callCount = 0;
  t.onWarning(() => callCount++);
  t.reserve(0.85);
  t.commit(0.85); // crosses 80% → 1 warning
  assert.equal(callCount, 1);
  t.raiseCap(2.0); // doubles cap; reset warned flag
  t.reserve(0.8);
  t.commit(0.8); // total 1.65 / 2.0 → crosses new 80% → another warning
  assert.equal(callCount, 2, "raised cap re-arms the warning");
});

test("B.8: raiseCap NEVER lowers (production safety)", () => {
  const t = new BudgetTracker({ perPrUsd: 1.0 });
  t.raiseCap(0.5); // attempt to lower — must no-op
  assert.equal(t.capacityUsd, 1.0, "raiseCap must not lower the cap");
  t.raiseCap(2.5);
  assert.equal(t.capacityUsd, 2.5);
});

test("B.8: zero / negative perPrUsd rejected at construction", () => {
  assert.throws(() => new BudgetTracker({ perPrUsd: 0 }), /perPrUsd must be > 0/);
  assert.throws(() => new BudgetTracker({ perPrUsd: -0.1 }), /perPrUsd must be > 0/);
});

test("B.8: negative reserve / commit rejected (no malicious bookkeeping)", () => {
  const t = new BudgetTracker({ perPrUsd: 1.0 });
  assert.throws(() => t.reserve(-0.1), /negative/);
  assert.throws(() => t.commit(-0.1), /negative/);
});

test("B.8: BudgetExceededError carries actionable fields", () => {
  const t = new BudgetTracker({ perPrUsd: 0.5 });
  t.reserve(0.4);
  t.commit(0.4);
  try {
    t.reserve(0.2);
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(err instanceof BudgetExceededError);
    assert.equal(err.attemptedUsd, 0.2);
    assert.equal(err.capUsd, 0.5);
    assert.equal(err.spentUsd, 0.4);
    assert.match(err.message, /\$0\.20.*\$0\.50/);
  }
});

test("B.8: EfficiencyGate.run throws BudgetExceededError BEFORE invoking execute when over cap", async () => {
  const gate = new EfficiencyGate({
    budget: new BudgetTracker({ perPrUsd: 0.1 }),
  });
  let executeCalled = false;
  await assert.rejects(
    gate.run(
      {
        agent: "claude",
        prompt: "x".repeat(1000),
        cacheablePrefix: "system-prompt",
        estimatedCostUsd: 0.5, // way over cap
      },
      async () => {
        executeCalled = true;
        return { costUsd: 0.5, inputTokens: 100, outputTokens: 10, latencyMs: 100 };
      },
    ),
    BudgetExceededError,
  );
  assert.equal(executeCalled, false, "execute must NOT be called when reserve fails");
});

test("B.8: EfficiencyGate accumulates spend across multiple run() calls", async () => {
  const gate = new EfficiencyGate({
    budget: new BudgetTracker({ perPrUsd: 1.0 }),
  });
  // 4 calls of $0.2 each = $0.8 total, fits.
  for (let i = 0; i < 4; i += 1) {
    await gate.run(
      {
        agent: "claude",
        prompt: "x",
        cacheablePrefix: "p",
        estimatedCostUsd: 0.2,
      },
      async () => ({ costUsd: 0.2, inputTokens: 10, outputTokens: 5, latencyMs: 10 }),
    );
  }
  assert.equal(Number(gate.budget.spentUsd.toFixed(4)), 0.8);
  // 5th call would put us at $1.0 — exactly the cap. Allowed (≤).
  await gate.run(
    {
      agent: "claude",
      prompt: "x",
      cacheablePrefix: "p",
      estimatedCostUsd: 0.2,
    },
    async () => ({ costUsd: 0.2, inputTokens: 10, outputTokens: 5, latencyMs: 10 }),
  );
  assert.equal(Number(gate.budget.spentUsd.toFixed(4)), 1.0);
  // 6th call MUST throw.
  await assert.rejects(
    gate.run(
      { agent: "claude", prompt: "x", cacheablePrefix: "p", estimatedCostUsd: 0.01 },
      async () => ({ costUsd: 0.01, inputTokens: 1, outputTokens: 1, latencyMs: 1 }),
    ),
    BudgetExceededError,
  );
});

test("B.8: actual cost overruns trigger throw on the NEXT call (not silently)", async () => {
  const gate = new EfficiencyGate({
    budget: new BudgetTracker({ perPrUsd: 0.5 }),
  });
  // First call: estimate $0.1, but actual $0.4. Reserve passes; commit
  // pushes spend to $0.4.
  await gate.run(
    { agent: "claude", prompt: "x", cacheablePrefix: "p", estimatedCostUsd: 0.1 },
    async () => ({ costUsd: 0.4, inputTokens: 10, outputTokens: 5, latencyMs: 10 }),
  );
  // Second call: estimate $0.2. spent + estimate = 0.4 + 0.2 = 0.6 > cap.
  await assert.rejects(
    gate.run(
      { agent: "claude", prompt: "x", cacheablePrefix: "p", estimatedCostUsd: 0.2 },
      async () => ({ costUsd: 0.2, inputTokens: 10, outputTokens: 5, latencyMs: 10 }),
    ),
    BudgetExceededError,
  );
});

test("B.8: warning fires from EfficiencyGate.run path (not just direct BudgetTracker)", async () => {
  let warned = false;
  const tracker = new BudgetTracker({ perPrUsd: 1.0 });
  tracker.onWarning(() => {
    warned = true;
  });
  const gate = new EfficiencyGate({ budget: tracker });
  await gate.run(
    { agent: "claude", prompt: "x", cacheablePrefix: "p", estimatedCostUsd: 0.85 },
    async () => ({ costUsd: 0.85, inputTokens: 10, outputTokens: 5, latencyMs: 10 }),
  );
  assert.equal(warned, true, "warning must fire when crossing 80% via gate.run");
});
