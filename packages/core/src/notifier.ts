import type { ReviewContext } from "./agent.js";
import type { CouncilOutcome } from "./council.js";
import type { PlainSummary } from "./plain-summary.js";

export interface NotifyReviewInput {
  outcome: CouncilOutcome;
  ctx: ReviewContext;
  episodicId: string;
  totalCostUsd: number;
  /** Optional PR URL if the SCM adapter resolved one — lets notifiers link directly. */
  prUrl?: string;
  /**
   * Optional plain-language summary (v0.6.1). When present, notifiers that
   * target non-dev surfaces (Telegram / Discord / Slack) SHOULD use it as
   * the primary body and relegate the technical verdict to a "full report"
   * link. When absent, notifiers preserve their original formatting for
   * backward compatibility.
   */
  plainSummary?: PlainSummary;
  /**
   * v0.8 — autonomy loop telemetry. `reworkCycle` is the zero-based
   * counter of auto-rework cycles that have completed BEFORE this review
   * (i.e. first review on a fresh PR is cycle 0; after one rework push
   * it's cycle 1). `maxReworkCycles` is the hard stop from config.
   * When both are present, the central plane renders the 4-state
   * autonomy keyboard instead of the legacy 3-button keyboard.
   */
  reworkCycle?: number;
  maxReworkCycles?: number;
  /** v0.8 — allow the unsafe-merge button at max cycles. */
  allowUnsafeMerge?: boolean;
  /** v0.8 — count of blockers in the current review (for UI prose). */
  blockerCount?: number;
}

/**
 * Notifier — pluggable notification surface.
 *
 * Decision #24: Telegram / Discord / Slack / Email are EQUAL-WEIGHT
 * integrations alongside CLI / Web / IDE. None is the "hero". Any
 * integration package implements this interface and consumers register
 * zero-or-more notifiers on the council run.
 *
 * Contract:
 *   - `notifyReview` is called once per completed council deliberation.
 *   - Implementations are fire-and-forget from the caller's perspective.
 *     They may throw; the caller is expected to catch + log + continue
 *     (a failed notification must not kill a review).
 *   - Implementations should NOT call LLM APIs. If they need
 *     summarization, take a pre-summarized field on NotifyReviewInput or
 *     compose the summary from existing `outcome.results[].summary`.
 */
export interface Notifier {
  readonly id: string;
  readonly displayName: string;
  notifyReview(input: NotifyReviewInput): Promise<void>;
}
