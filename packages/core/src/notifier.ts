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
 * v0.11 — progress-streaming stages emitted by the CLI during a review or
 * autofix run. A stage is a coarse milestone (one per phase boundary) —
 * not per-token streaming, and not per-round. The notifier accumulates
 * stages into a single message that updates in place via
 * `editMessageText` (Telegram) or the equivalent on other surfaces.
 *
 * Emitter contract: stages MUST be emitted in this rough order within a
 * single (episodicId, prNumber) anchor:
 *
 *   review-started               (always, before deliberate)
 *   visual-capture-started       (optional, only when visual gate fires)
 *   visual-capture-done          (optional, paired)
 *   tier1-done                   (after deliberate, always for TieredCouncil)
 *   escalating-to-tier2          (optional, only when tier-2 ran)
 *   tier2-done                   (optional, paired)
 *   autofix-iter-started         (per autofix iteration; payload.iteration = N)
 *   autofix-iter-done            (paired with iter-started)
 *
 * The final verdict is NOT emitted as a progress stage — it stays on the
 * existing `notifyReview` channel so action buttons remain on a separate
 * message (so a user clicking ✅ doesn't dismiss the progress timeline).
 */
export type ProgressStage =
  | "review-started"
  | "visual-capture-started"
  | "visual-capture-done"
  | "tier1-done"
  | "escalating-to-tier2"
  | "tier2-done"
  | "autofix-iter-started"
  | "autofix-iter-done";

/**
 * Optional payload carried with a progress stage. Notifiers render this
 * into a one-line summary; missing fields are silently omitted from the
 * rendered text.
 */
export interface ProgressPayload {
  /** Repo slug (acme/app). Required so multi-repo dashboards can route. */
  repo?: string;
  /** PR number. Drives the (episodic, pr) anchor key for message edits. */
  pullNumber?: number;
  /** Tier-1 / tier-2 agent ids resolved for THIS run (one per stage). */
  agentIds?: string[];
  /** Total blockers discovered after the named tier completes. */
  blockerCount?: number;
  /** Number of debate rounds that ran in the named tier. */
  rounds?: number;
  /** Visual capture: number of before/after image pairs emitted. */
  artifactCount?: number;
  /** Visual capture: route count + viewport labels (rendered as prose). */
  routes?: string[];
  /** Visual capture / tier completion: total elapsed milliseconds. */
  totalMs?: number;
  /** Autofix: 1-based iteration number. */
  iteration?: number;
  /** Autofix iter result: how many fixes verified (build+tests passed). */
  fixesVerified?: number;
  /** Free-form reason / failure tail. Truncated by the notifier renderer. */
  reason?: string;
}

export interface NotifyProgressInput {
  /**
   * Anchor for the message-edit chain. The notifier persists a single
   * (episodicId, pullNumber) → message_id mapping per call site. The same
   * episodicId across multiple stages MUST update the same message.
   */
  episodicId: string;
  /** Stage that just transitioned. */
  stage: ProgressStage;
  /** Optional renderer payload. Empty-object means "stage line, no detail". */
  payload?: ProgressPayload;
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
 *   - `notifyProgress` (v0.11+) is OPTIONAL; notifiers that don't
 *     implement it silently drop progress stages. Callers MUST NOT depend
 *     on a notifier acknowledging a progress stage — it's fire-and-
 *     forget telemetry, and the absence of an implementation is a no-op.
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
  /**
   * v0.11 — optional progress streaming. Surfaces that support
   * edit-in-place (Telegram, Slack, Discord) accumulate stages onto a
   * single message via the platform's edit primitive. Surfaces without
   * an edit primitive (email) MAY drop progress entirely — the contract
   * only requires `notifyReview`.
   */
  notifyProgress?(input: NotifyProgressInput): Promise<void>;
}
