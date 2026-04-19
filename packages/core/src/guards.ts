/**
 * Guards — anti-loop + circuit breaker per ARCHITECTURE.md layer 3.
 *
 * Two independent primitives, both in-memory + clock-injectable for tests:
 *
 *   - `LoopGuard`: bound how many times the same (repo, pr, sha) gets
 *     reviewed in a rolling window. Prevents infinite rework cycles where
 *     an agent's patch reopens a review that agents reject, which
 *     triggers another patch, ad infinitum. Throws `LoopDetectedError`.
 *
 *   - `CircuitBreaker`: track consecutive failures per provider. After
 *     the threshold trips, refuse calls for a cooldown. Prevents burning
 *     budget on a dead provider while also letting healthy providers
 *     continue. Wrap each call with `breaker.guard(provider, fn)`.
 *
 * Neither guard is wired into Council / EfficiencyGate by default —
 * callers opt-in via the orchestrator template (`conclave review`
 * composes them around the Council). Keeps the primitives unit-testable
 * and the gate free of mandatory behaviour that's only right for one
 * deployment shape.
 */

export class LoopDetectedError extends Error {
  constructor(
    message: string,
    readonly key: string,
    readonly count: number,
    readonly windowMs: number,
  ) {
    super(message);
    this.name = "LoopDetectedError";
  }
}

export class CircuitOpenError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly openUntil: number,
  ) {
    super(message);
    this.name = "CircuitOpenError";
  }
}

export interface LoopGuardOptions {
  /** Max review attempts per key inside `windowMs`. Default 5. */
  threshold?: number;
  /** Rolling-window length in ms. Default 60 minutes. */
  windowMs?: number;
  /** Injectable clock (for tests). Default `Date.now`. */
  now?: () => number;
}

/**
 * Bounded-frequency counter. `check(key)` records an attempt + throws
 * when the same key has been seen more than `threshold` times inside
 * the current rolling window. Purely in-memory — state lives on the
 * single process running Council.
 */
export class LoopGuard {
  private readonly threshold: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly attempts: Map<string, number[]> = new Map();

  constructor(opts: LoopGuardOptions = {}) {
    this.threshold = opts.threshold ?? 5;
    this.windowMs = opts.windowMs ?? 60 * 60 * 1_000;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Record an attempt for `key`. Throws `LoopDetectedError` if the
   * recent attempt count would exceed `threshold` after this record.
   * Call this at the TOP of every review so the attempt count
   * accumulates per (repo, pr, sha) or whatever key you pass in.
   */
  check(key: string): void {
    const now = this.now();
    const cutoff = now - this.windowMs;
    const prior = (this.attempts.get(key) ?? []).filter((t) => t >= cutoff);
    prior.push(now);
    this.attempts.set(key, prior);
    if (prior.length > this.threshold) {
      throw new LoopDetectedError(
        `LoopGuard: ${key} was reviewed ${prior.length} times in the last ${Math.round(this.windowMs / 60_000)} min (threshold ${this.threshold}).`,
        key,
        prior.length,
        this.windowMs,
      );
    }
  }

  /** Test helper — number of live (within-window) attempts for a key. */
  count(key: string): number {
    const cutoff = this.now() - this.windowMs;
    return (this.attempts.get(key) ?? []).filter((t) => t >= cutoff).length;
  }

  reset(): void {
    this.attempts.clear();
  }
}

export interface CircuitBreakerOptions {
  /** Consecutive failures that trip the breaker. Default 3. */
  failureThreshold?: number;
  /** How long the circuit stays open in ms. Default 5 minutes. */
  cooldownMs?: number;
  /** Injectable clock. */
  now?: () => number;
}

interface CircuitState {
  consecutiveFailures: number;
  openUntil: number | null;
}

/**
 * Per-provider circuit breaker. Wrap every external-provider call with
 * `breaker.guard(providerId, fn)`.
 *
 *   closed  → normal, counting failures
 *   open    → refuses calls, throws `CircuitOpenError` until `openUntil`
 *   half-open → (implicit, when `openUntil` passes) — the NEXT call
 *     through is allowed; on success closes + resets, on failure
 *     re-opens with fresh cooldown.
 *
 * Independence across providers means a Gemini 429 doesn't throttle
 * Claude + OpenAI.
 */
export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly states: Map<string, CircuitState> = new Map();

  constructor(opts: CircuitBreakerOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? 3;
    this.cooldownMs = opts.cooldownMs ?? 5 * 60 * 1_000;
    this.now = opts.now ?? (() => Date.now());
  }

  async guard<T>(provider: string, fn: () => Promise<T>): Promise<T> {
    const state = this.states.get(provider) ?? { consecutiveFailures: 0, openUntil: null };

    if (state.openUntil !== null && this.now() < state.openUntil) {
      throw new CircuitOpenError(
        `CircuitBreaker: ${provider} is open until ${new Date(state.openUntil).toISOString()}.`,
        provider,
        state.openUntil,
      );
    }

    try {
      const result = await fn();
      // Success — close the circuit, reset the counter.
      state.consecutiveFailures = 0;
      state.openUntil = null;
      this.states.set(provider, state);
      return result;
    } catch (err) {
      state.consecutiveFailures += 1;
      if (state.consecutiveFailures >= this.failureThreshold) {
        state.openUntil = this.now() + this.cooldownMs;
      }
      this.states.set(provider, state);
      throw err;
    }
  }

  /** Test helpers. */
  isOpen(provider: string): boolean {
    const s = this.states.get(provider);
    return !!(s && s.openUntil !== null && this.now() < s.openUntil);
  }
  failureCount(provider: string): number {
    return this.states.get(provider)?.consecutiveFailures ?? 0;
  }
  reset(provider?: string): void {
    if (provider) this.states.delete(provider);
    else this.states.clear();
  }
}
