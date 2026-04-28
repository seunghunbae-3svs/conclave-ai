/**
 * OP-2 — per-item retry guard.
 *
 * Pre-OP-2, the orchestrator only had `consecutiveFailures` (any
 * failure across any item bumped it). H1.5 B's history note showed 5
 * retries on the SAME item — the loop kept burning cycles even though
 * the item was clearly stuck.
 *
 * evaluatePerItemCeiling pins down the contract:
 *   - fresh state → 0/ceiling, allowed
 *   - new item → reset to 0/ceiling, allowed
 *   - same item, count < ceiling → allowed
 *   - same item, count >= ceiling → freeze
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluatePerItemCeiling } from "../../../scripts/dev-loop/run-next.mjs";

test("OP-2: fresh state (no perItemRetries) → reset to count=0, allowed", () => {
  const r = evaluatePerItemCeiling(null, "H2 #6", 3);
  assert.deepEqual(r.next, { item: "H2 #6", count: 0 });
  assert.equal(r.shouldFreeze, false);
});

test("OP-2: undefined prev → reset (defensive)", () => {
  const r = evaluatePerItemCeiling(undefined, "H2 #6", 3);
  assert.deepEqual(r.next, { item: "H2 #6", count: 0 });
  assert.equal(r.shouldFreeze, false);
});

test("OP-2: empty object prev → reset", () => {
  const r = evaluatePerItemCeiling({}, "H2 #6", 3);
  assert.deepEqual(r.next, { item: "H2 #6", count: 0 });
  assert.equal(r.shouldFreeze, false);
});

test("OP-2: new item → reset count to 0 (prior failures on different item don't poison new item)", () => {
  const r = evaluatePerItemCeiling({ item: "H1 #5", count: 3 }, "H2 #6", 3);
  // Old count carried OVER would have frozen us before we even started.
  assert.equal(r.next.item, "H2 #6");
  assert.equal(r.next.count, 0);
  assert.equal(r.shouldFreeze, false);
});

test("OP-2: same item with count < ceiling → unchanged + allowed", () => {
  const r = evaluatePerItemCeiling({ item: "H2 #6", count: 1 }, "H2 #6", 3);
  assert.deepEqual(r.next, { item: "H2 #6", count: 1 });
  assert.equal(r.shouldFreeze, false);
});

test("OP-2: same item, count == ceiling → FREEZE", () => {
  const r = evaluatePerItemCeiling({ item: "H2 #6", count: 3 }, "H2 #6", 3);
  assert.equal(r.shouldFreeze, true, "ceiling reached → must freeze");
});

test("OP-2: same item, count > ceiling (corrupt state) → FREEZE (defensive)", () => {
  const r = evaluatePerItemCeiling({ item: "H2 #6", count: 99 }, "H2 #6", 3);
  assert.equal(r.shouldFreeze, true);
});

test("OP-2: H1.5 B-style scenario — 5 retries on same item across 3-ceiling → frozen on the 4th attempt", () => {
  // Simulate the H1.5 B postmortem trajectory:
  //   attempt 1: prev=null              → next={item, 0}, allowed
  //   (run fails, caller bumps count to 1)
  //   attempt 2: prev={item, 1}         → next={item, 1}, allowed
  //   (fail, bump to 2)
  //   attempt 3: prev={item, 2}         → next={item, 2}, allowed
  //   (fail, bump to 3)
  //   attempt 4: prev={item, 3}         → SHOULD FREEZE
  let prev = null;
  let allowedCount = 0;
  for (let i = 0; i < 10; i += 1) {
    const r = evaluatePerItemCeiling(prev, "H1.5 B", 3);
    if (r.shouldFreeze) break;
    allowedCount += 1;
    prev = { ...r.next, count: r.next.count + 1 }; // simulate caller bumping post-fail
  }
  assert.equal(
    allowedCount,
    3,
    "with ceiling 3, only 3 attempts should be allowed before the 4th freezes",
  );
});

test("OP-2: ceiling is parameterizable (not hard-coded)", () => {
  const r1 = evaluatePerItemCeiling({ item: "x", count: 4 }, "x", 5);
  assert.equal(r1.shouldFreeze, false, "below custom ceiling 5");
  const r2 = evaluatePerItemCeiling({ item: "x", count: 5 }, "x", 5);
  assert.equal(r2.shouldFreeze, true, "at custom ceiling 5");
});

test("OP-2: count carries verbatim — helper does NOT silently bump (caller controls)", () => {
  const r = evaluatePerItemCeiling({ item: "x", count: 1 }, "x", 3);
  assert.equal(r.next.count, 1, "evaluator does not bump count; that's the caller's job after the run completes");
});
