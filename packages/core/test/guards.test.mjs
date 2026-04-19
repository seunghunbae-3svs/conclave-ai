import { test } from "node:test";
import assert from "node:assert/strict";
import { LoopGuard, CircuitBreaker, LoopDetectedError, CircuitOpenError } from "../dist/index.js";

// ---------------------------------------------------------------------
// LoopGuard
// ---------------------------------------------------------------------

function clock() {
  let t = 1_700_000_000_000;
  return {
    now: () => t,
    advance(ms) {
      t += ms;
    },
  };
}

test("LoopGuard: up to threshold is OK", () => {
  const c = clock();
  const g = new LoopGuard({ threshold: 5, windowMs: 60_000, now: c.now });
  for (let i = 0; i < 5; i += 1) g.check("acme/repo#1@abc");
  assert.equal(g.count("acme/repo#1@abc"), 5);
});

test("LoopGuard: one-over throws LoopDetectedError", () => {
  const c = clock();
  const g = new LoopGuard({ threshold: 3, now: c.now });
  g.check("k");
  g.check("k");
  g.check("k");
  assert.throws(() => g.check("k"), LoopDetectedError);
});

test("LoopGuard: stale entries outside window don't count", () => {
  const c = clock();
  const g = new LoopGuard({ threshold: 3, windowMs: 60_000, now: c.now });
  g.check("k");
  g.check("k");
  g.check("k");
  c.advance(120_000); // past the 60s window
  // All 3 prior entries are now stale — this is the FIRST live attempt
  g.check("k");
  assert.equal(g.count("k"), 1);
});

test("LoopGuard: different keys track independently", () => {
  const c = clock();
  const g = new LoopGuard({ threshold: 2, now: c.now });
  g.check("a");
  g.check("a");
  // 'a' is at threshold; 'b' is fresh
  g.check("b");
  assert.equal(g.count("a"), 2);
  assert.equal(g.count("b"), 1);
});

test("LoopGuard: LoopDetectedError carries diagnostic context", () => {
  const c = clock();
  const g = new LoopGuard({ threshold: 2, windowMs: 60_000, now: c.now });
  g.check("k");
  g.check("k");
  try {
    g.check("k");
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(err instanceof LoopDetectedError);
    assert.equal(err.key, "k");
    assert.equal(err.count, 3);
    assert.equal(err.windowMs, 60_000);
  }
});

test("LoopGuard: reset clears all state", () => {
  const c = clock();
  const g = new LoopGuard({ threshold: 2, now: c.now });
  g.check("a");
  g.check("a");
  g.reset();
  g.check("a");
  assert.equal(g.count("a"), 1);
});

// ---------------------------------------------------------------------
// CircuitBreaker
// ---------------------------------------------------------------------

test("CircuitBreaker: success path returns result + resets", async () => {
  const c = clock();
  const b = new CircuitBreaker({ failureThreshold: 3, now: c.now });
  const out = await b.guard("openai", async () => "ok");
  assert.equal(out, "ok");
  assert.equal(b.failureCount("openai"), 0);
  assert.equal(b.isOpen("openai"), false);
});

test("CircuitBreaker: counts consecutive failures up to threshold", async () => {
  const c = clock();
  const b = new CircuitBreaker({ failureThreshold: 3, now: c.now });
  for (let i = 0; i < 2; i += 1) {
    await assert.rejects(() => b.guard("openai", async () => { throw new Error("nope"); }));
  }
  assert.equal(b.failureCount("openai"), 2);
  assert.equal(b.isOpen("openai"), false);
});

test("CircuitBreaker: third consecutive failure opens the circuit", async () => {
  const c = clock();
  const b = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 300_000, now: c.now });
  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(() => b.guard("openai", async () => { throw new Error("nope"); }));
  }
  assert.equal(b.isOpen("openai"), true);
  await assert.rejects(
    () => b.guard("openai", async () => "never runs"),
    CircuitOpenError,
  );
});

test("CircuitBreaker: success between failures resets the counter", async () => {
  const c = clock();
  const b = new CircuitBreaker({ failureThreshold: 3, now: c.now });
  await assert.rejects(() => b.guard("openai", async () => { throw new Error("1"); }));
  await assert.rejects(() => b.guard("openai", async () => { throw new Error("2"); }));
  assert.equal(b.failureCount("openai"), 2);
  await b.guard("openai", async () => "good");
  assert.equal(b.failureCount("openai"), 0);
});

test("CircuitBreaker: different providers track independently", async () => {
  const c = clock();
  const b = new CircuitBreaker({ failureThreshold: 2, now: c.now });
  await assert.rejects(() => b.guard("openai", async () => { throw new Error("x"); }));
  await assert.rejects(() => b.guard("openai", async () => { throw new Error("x"); }));
  assert.equal(b.isOpen("openai"), true);
  assert.equal(b.isOpen("claude"), false);
  const ok = await b.guard("claude", async () => "ok");
  assert.equal(ok, "ok");
});

test("CircuitBreaker: circuit closes after cooldown (half-open on next call)", async () => {
  const c = clock();
  const b = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 60_000, now: c.now });
  await assert.rejects(() => b.guard("openai", async () => { throw new Error("x"); }));
  await assert.rejects(() => b.guard("openai", async () => { throw new Error("x"); }));
  assert.equal(b.isOpen("openai"), true);
  c.advance(61_000);
  assert.equal(b.isOpen("openai"), false);
  const ok = await b.guard("openai", async () => "recovered");
  assert.equal(ok, "recovered");
});

test("CircuitBreaker: CircuitOpenError carries diagnostics", async () => {
  const c = clock();
  const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 60_000, now: c.now });
  await assert.rejects(() => b.guard("gemini", async () => { throw new Error("429"); }));
  try {
    await b.guard("gemini", async () => "never");
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(err instanceof CircuitOpenError);
    assert.equal(err.provider, "gemini");
    assert.ok(err.openUntil > c.now());
  }
});
