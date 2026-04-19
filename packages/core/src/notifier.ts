import type { ReviewContext } from "./agent.js";
import type { CouncilOutcome } from "./council.js";

export interface NotifyReviewInput {
  outcome: CouncilOutcome;
  ctx: ReviewContext;
  episodicId: string;
  totalCostUsd: number;
  /** Optional PR URL if the SCM adapter resolved one — lets notifiers link directly. */
  prUrl?: string;
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
