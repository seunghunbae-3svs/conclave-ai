export interface BudgetOptions {
  /** Max total USD that may be spent across all LLM calls within this run. */
  perPrUsd: number;
  /** Optional soft-warning threshold as a fraction of perPrUsd (0..1). Defaults to 0.8. */
  warnAt?: number;
}

/** Thrown when a spend attempt would exceed the per-PR budget cap. */
export class BudgetExceededError extends Error {
  readonly attemptedUsd: number;
  readonly capUsd: number;
  readonly spentUsd: number;

  constructor(attemptedUsd: number, capUsd: number, spentUsd: number) {
    super(
      `budget: attempt to spend $${attemptedUsd.toFixed(4)} would take total to $${(spentUsd + attemptedUsd).toFixed(4)} (cap $${capUsd.toFixed(2)})`,
    );
    this.name = "BudgetExceededError";
    this.attemptedUsd = attemptedUsd;
    this.capUsd = capUsd;
    this.spentUsd = spentUsd;
  }
}

/** Default per-PR budget per decision #20. User-configurable via opts.perPrUsd. */
export const DEFAULT_PER_PR_BUDGET_USD = 0.5;

export class BudgetTracker {
  private readonly capUsd: number;
  private readonly warnAt: number;
  private spent = 0;
  private warned = false;
  private warningHandler: ((spentUsd: number, capUsd: number) => void) | undefined;

  constructor(opts: BudgetOptions) {
    if (opts.perPrUsd <= 0) throw new Error("budget: perPrUsd must be > 0");
    this.capUsd = opts.perPrUsd;
    this.warnAt = opts.warnAt ?? 0.8;
    if (this.warnAt < 0 || this.warnAt > 1) {
      throw new Error("budget: warnAt must be in [0, 1]");
    }
  }

  /** Attach a one-shot warning callback that fires when spending crosses the warn threshold. */
  onWarning(handler: (spentUsd: number, capUsd: number) => void): void {
    this.warningHandler = handler;
  }

  /** Throws BudgetExceededError if adding `usd` would exceed the cap. Call BEFORE the LLM call. */
  reserve(usd: number): void {
    if (usd < 0) throw new Error("budget: cannot reserve negative USD");
    if (this.spent + usd > this.capUsd) {
      throw new BudgetExceededError(usd, this.capUsd, this.spent);
    }
  }

  /** Record actual spend after the call lands. No throw — we've already reserved. */
  commit(usd: number): void {
    if (usd < 0) throw new Error("budget: cannot commit negative USD");
    this.spent += usd;
    if (!this.warned && this.spent / this.capUsd >= this.warnAt) {
      this.warned = true;
      this.warningHandler?.(this.spent, this.capUsd);
    }
  }

  get spentUsd(): number {
    return this.spent;
  }

  get remainingUsd(): number {
    return Math.max(0, this.capUsd - this.spent);
  }

  get capacityUsd(): number {
    return this.capUsd;
  }

  reset(): void {
    this.spent = 0;
    this.warned = false;
  }
}
