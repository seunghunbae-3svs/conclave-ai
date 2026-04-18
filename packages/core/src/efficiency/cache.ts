import { createHash } from "node:crypto";

export interface CacheEntry<T> {
  value: T;
  storedAt: number;
}

export interface CacheOptions {
  /** Time-to-live in milliseconds. Defaults to Anthropic's 5-minute prompt-cache window. */
  ttlMs?: number;
  /** Max entries held in memory. Oldest-first eviction. */
  maxEntries?: number;
}

/**
 * Anthropic prompt-cache 5-minute TTL is the design constraint:
 * - On a HIT, downstream can signal `cache_control: ephemeral` to the API and save ~90% input cost
 * - On a MISS within a live window, the request should still mark the large static prefix as `ephemeral`
 *   so the NEXT identical call within 5 min hits the provider cache.
 *
 * PromptCache here tracks our view of whether we've recently issued a matching prefix — it does not
 * store LLM output. The provider is the source of truth for what's actually cached server-side.
 */
export const ANTHROPIC_PROMPT_CACHE_TTL_MS = 5 * 60 * 1000;

export class PromptCache {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly store = new Map<string, CacheEntry<true>>();
  private hits = 0;
  private misses = 0;

  constructor(opts: CacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? ANTHROPIC_PROMPT_CACHE_TTL_MS;
    this.maxEntries = opts.maxEntries ?? 1024;
  }

  /** Stable hash of a prefix string. Exported for tests + debugging. */
  static key(prefix: string, model: string): string {
    return createHash("sha256").update(`${model}\u0000${prefix}`).digest("hex");
  }

  isLive(prefix: string, model: string, now: number = Date.now()): boolean {
    const k = PromptCache.key(prefix, model);
    const entry = this.store.get(k);
    if (!entry) {
      this.misses += 1;
      return false;
    }
    if (now - entry.storedAt > this.ttlMs) {
      this.store.delete(k);
      this.misses += 1;
      return false;
    }
    this.hits += 1;
    return true;
  }

  mark(prefix: string, model: string, now: number = Date.now()): void {
    const k = PromptCache.key(prefix, model);
    if (!this.store.has(k) && this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(k, { value: true, storedAt: now });
  }

  hitRate(): number {
    const total = this.hits + this.misses;
    return total === 0 ? 0 : this.hits / total;
  }

  get stats(): { hits: number; misses: number; size: number } {
    return { hits: this.hits, misses: this.misses, size: this.store.size };
  }

  reset(): void {
    this.store.clear();
    this.hits = 0;
    this.misses = 0;
  }
}
