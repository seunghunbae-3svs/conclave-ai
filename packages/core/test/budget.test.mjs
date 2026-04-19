import { test } from "node:test";
import assert from "node:assert/strict";
import { BudgetTracker, BudgetExceededError, DEFAULT_PER_PR_BUDGET_USD } from "../dist/index.js";

test("BudgetTracker: happy path reserve + commit", () => {
  const b = new BudgetTracker({ perPrUsd: 1 });
  b.reserve(0.2);
  b.commit(0.15);
  b.reserve(0.3);
  b.commit(0.3);
  assert.equal(b.spentUsd, 0.45);
  assert.equal(b.remainingUsd, 0.55);
});

test("BudgetTracker: reserve beyond cap throws BudgetExceededError", () => {
  const b = new BudgetTracker({ perPrUsd: 1 });
  b.reserve(0.6);
  b.commit(0.6);
  assert.throws(() => b.reserve(0.5), (err) => {
    assert.ok(err instanceof BudgetExceededError);
    assert.equal(err.capUsd, 1);
    assert.equal(err.spentUsd, 0.6);
    return true;
  });
});

test("BudgetTracker: warning handler fires once at threshold", () => {
  const b = new BudgetTracker({ perPrUsd: 1, warnAt: 0.5 });
  const events = [];
  b.onWarning((spent, cap) => events.push({ spent, cap }));
  b.commit(0.2);
  assert.equal(events.length, 0);
  b.commit(0.4); // 0.6 >= 0.5 cap
  assert.equal(events.length, 1);
  b.commit(0.3); // already warned — no second fire
  assert.equal(events.length, 1);
});

test("BudgetTracker: default perPrUsd exported constant equals 0.5 per decision #20", () => {
  assert.equal(DEFAULT_PER_PR_BUDGET_USD, 0.5);
});

test("BudgetTracker: rejects invalid opts", () => {
  assert.throws(() => new BudgetTracker({ perPrUsd: 0 }));
  assert.throws(() => new BudgetTracker({ perPrUsd: -1 }));
  assert.throws(() => new BudgetTracker({ perPrUsd: 1, warnAt: -0.1 }));
  assert.throws(() => new BudgetTracker({ perPrUsd: 1, warnAt: 1.1 }));
});
