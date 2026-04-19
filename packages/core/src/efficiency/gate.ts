import { PromptCache } from "./cache.js";
import { BudgetTracker, DEFAULT_PER_PR_BUDGET_USD } from "./budget.js";
import { MetricsRecorder, type CallMetric } from "./metrics.js";
import { selectModel, estimateTokens, type ModelChoice } from "./router.js";

export interface EfficiencyGateOptions {
  perPrUsd?: number;
  cache?: PromptCache;
  budget?: BudgetTracker;
  metrics?: MetricsRecorder;
}

export interface GateCallInput {
  agent: string;
  /** The prefix that is safe to prompt-cache (system prompt + pinned RAG context). */
  cacheablePrefix: string;
  /** The full prompt (prefix + volatile tail). Used for token estimation. */
  prompt: string;
  /** Pre-flight cost estimate in USD (caller computes from token budget + model pricing). */
  estimatedCostUsd: number;
  /** Override model routing if the caller has a specific requirement. */
  forceModel?: string;
}

export interface GateCallOutcome<T> {
  result: T;
  metric: CallMetric;
  modelChoice: ModelChoice;
}

export interface GateExecuteFn<T> {
  (args: { model: string; cacheHit: boolean }): Promise<{
    result: T;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    latencyMs: number;
  }>;
}

/**
 * EfficiencyGate — central orchestrator. Every agent's LLM call MUST route
 * through `run()` so cache, budget, routing, and metrics are uniform.
 *
 * Direct SDK calls outside this gate are a contract violation (decision #22).
 */
export class EfficiencyGate {
  readonly cache: PromptCache;
  readonly budget: BudgetTracker;
  readonly metrics: MetricsRecorder;

  constructor(opts: EfficiencyGateOptions = {}) {
    this.cache = opts.cache ?? new PromptCache();
    this.budget = opts.budget ?? new BudgetTracker({ perPrUsd: opts.perPrUsd ?? DEFAULT_PER_PR_BUDGET_USD });
    this.metrics = opts.metrics ?? new MetricsRecorder();
  }

  async run<T>(input: GateCallInput, execute: GateExecuteFn<T>): Promise<GateCallOutcome<T>> {
    // 1. Reserve budget BEFORE the call — throws if over cap.
    this.budget.reserve(input.estimatedCostUsd);

    // 2. Route to a model class.
    const tokens = estimateTokens(input.prompt);
    const choice: ModelChoice = input.forceModel
      ? { model: input.forceModel, class: "sonnet", reason: "forced by caller" }
      : selectModel(tokens);

    // 3. Check cache liveness for the cacheable prefix.
    const cacheHit = this.cache.isLive(input.cacheablePrefix, choice.model);

    // 4. Execute.
    const call = await execute({ model: choice.model, cacheHit });

    // 5. Mark cache so the NEXT identical call within TTL reports a hit.
    this.cache.mark(input.cacheablePrefix, choice.model);

    // 6. Commit actual spend.
    this.budget.commit(call.costUsd);

    // 7. Record metric.
    const metric: CallMetric = {
      agent: input.agent,
      model: choice.model,
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      costUsd: call.costUsd,
      latencyMs: call.latencyMs,
      cacheHit,
      timestamp: Date.now(),
    };
    this.metrics.record(metric);

    return { result: call.result, metric, modelChoice: choice };
  }
}
