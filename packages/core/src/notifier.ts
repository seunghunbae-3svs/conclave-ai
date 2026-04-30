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
  | "autofix-iter-done"
  /**
   * UX-2 — terminal stage for any cycle ending (success OR bail). Emits
   * once per autofix run, with `bailStatus` carrying the AutofixResult
   * status tag ("approved" / "awaiting-approval" / "deferred-to-next-review"
   * / "bailed-no-patches" / "bailed-build-failed" / "bailed-tests-failed"
   * / "bailed-secret-guard" / "bailed-max-iterations" / "bailed-budget"
   * / "loop-guard-trip"). Pre-UX-2 the terminal state went only to PR
   * comment via UX-1 — Telegram users never saw cycle outcome.
   */
  | "autofix-cycle-ended"
  /**
   * UX-3 — emitted before each per-blocker worker call so the user sees
   * concrete progress ("fixing blocker 3/9: Stray console.log"). One
   * emit per blocker per iteration; pre-UX-3 the only visible signal was
   * the iteration-level "auto fixing 1/3".
   */
  | "autofix-blocker-started"
  | "autofix-blocker-done"
  /**
   * UX-13 — emitted when a rework dispatch starts a new autonomy cycle
   * (cycle 2, 3, ...). Pre-UX-13, only cycle 1's `conclave review` emitted
   * `review-started`, which is what the central plane uses to create a
   * fresh Telegram message. Subsequent cycles dispatched by AF-2 ran
   * `conclave autofix` directly (no review.ts), so no new message ever
   * landed — all per-cycle progress collapsed back into cycle 1's
   * message and the user only saw "1/3" forever.
   *
   * The central plane treats `rework-cycle-started` like `review-started`:
   * always create a NEW Telegram message anchored on (episodicId + the
   * implicit chat row's most-recent semantics), so each cycle gets its
   * own running log and the cycle counter in the header advances.
   */
  | "rework-cycle-started"
  /**
   * UX-4 — terminal user-facing report. Fires ONCE at the end of the
   * autonomy loop (approve / awaiting-approval / cycle-ceiling / bail-
   * with-no-recovery), AFTER deploy status has settled. Renderer writes
   * a non-developer summary in the user's language: what was found,
   * what was fixed, what's left, how much it cost, and a verdict
   * recommendation. Action buttons (approve / hold / reject) are
   * appended by the notifier when the surface supports them
   * (Telegram inline keyboard).
   *
   * Distinct from autofix-cycle-ended (per-cycle status line). One
   * cycle has many cycle-ended emits over its lifetime; the loop has
   * exactly ONE review-finished.
   */
  | "review-finished";

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
  /**
   * UX-2 — terminal AutofixResult.status tag. Notifier renders a
   * status-specific glyph + headline (✅ approved, ⚠️ deferred, 🛑 bailed-*).
   */
  bailStatus?: string;
  /** UX-2 — total iterations attempted (1..maxIterations). */
  iterationsAttempted?: number;
  /** UX-2 — total cost spent across the cycle (USD). */
  totalCostUsd?: number;
  /** UX-2 — count of blockers still unresolved at terminal time. */
  remainingBlockerCount?: number;
  /**
   * UX-3 — 1-based blocker index within the iteration (1..blockerTotal).
   */
  blockerIndex?: number;
  /** UX-3 — total blocker count for this iteration. */
  blockerTotal?: number;
  /** UX-3 — short label for the blocker being worked ("category: msg head"). */
  blockerLabel?: string;
  /** UX-3 — per-blocker outcome: "ready" / "skipped" / "conflict" / "secret-block" / "worker-error". */
  blockerOutcome?: string;
  // UX-4 — terminal user-facing report fields. Notifier renders these
  // in the user's language (defaults to Korean for Bae's install; CLI
  // config selects locale).
  /** Total cycles that ran (1..maxCycles). */
  cyclesRun?: number;
  /** Total blockers caught across all cycles. */
  totalBlockersFound?: number;
  /** Blockers that autofix successfully patched + landed. */
  blockersAutofixed?: number;
  /** Blockers still requiring human attention. */
  blockersOutstanding?: number;
  /**
   * Short non-dev summary lines describing what was fixed. Each entry
   * is a one-line bullet rendered as-is. The renderer joins them.
   */
  fixedItems?: string[];
  /**
   * Short non-dev summary lines describing what's still outstanding.
   */
  outstandingItems?: string[];
  /**
   * Deploy outcome at terminal time: "success" | "failure" | "pending"
   * | "unknown". Used to pick the verdict glyph.
   */
  deployOutcome?: string;
  /**
   * Verdict recommendation: "approve" | "hold" | "reject". Notifier
   * highlights this on the corresponding action button.
   */
  recommendation?: string;
  /**
   * UX-15 — preview URL for the live deploy of THIS PR head commit.
   * Pulled from Vercel/Netlify/CF commit-status target_url at terminal
   * time. Surfaced in the review-finished card so non-devs can click
   * and SEE the result instead of reading code-shaped descriptions.
   */
  previewUrl?: string;
  /**
   * UX-15 — PR URL (github.com/...) so the user can land on the
   * full PR view from the Telegram card.
   */
  prUrl?: string;
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
