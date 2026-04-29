import { Hono } from "hono";
import {
  AUTONOMY_DEFAULT_MAX_CYCLES,
  buttonsToInlineKeyboard,
  clampMaxCycles,
  decideAutonomyState,
  renderAutonomyMessage,
  type AutonomyContext,
  type AutonomyState,
} from "@conclave-ai/core/autonomy";
import type { PlainSummary, PlainSummaryLocale } from "@conclave-ai/core/plain-summary";
import type { Env } from "../env.js";
import type { FetchLike } from "../github.js";
import { findInstallByTokenHash, touchInstall, addMonthlySpend } from "../db/installs.js";
import { getInstallForDispatch } from "../db/telegram.js";
import {
  findProgressMessage,
  insertProgressMessage,
  updateProgressMessage,
} from "../db/progress.js";
import { sha256Hex } from "../util.js";
import { TelegramClient, dispatchRepositoryEvent } from "../telegram.js";
import {
  renderProgressLine,
  renderProgressMessage,
  TELEGRAM_TEXT_LIMIT_LINES,
  type ProgressLine,
  type ProgressPayload,
  type ProgressStage,
} from "../progress-format.js";

/**
 * POST /review/notify — v0.8 autonomous pipeline dispatcher.
 *
 * Bearer-auth'd endpoint that the CLI notifier hits after every review
 * run. Branches on `verdict` + `rework_cycle`:
 *
 *   approve → send "ready to merge" + [Merge & Push][Close]
 *   rework  → fire GitHub repository_dispatch `conclave-rework`
 *             with the next cycle number + send "auto-fixing, wait" msg
 *             (cycle + 1 still below max) OR send max-cycles msg
 *             with unsafe-merge buttons (cycle at/above max).
 *   reject  → send "discard PR" + [Close][Open PR]
 *
 * Safety:
 *   - maxReworkCycles is clamped by `clampMaxCycles` (hard ceiling of 5).
 *   - A rework-dispatch failure does NOT fail the notifier response —
 *     logged and 200 returned so the consumer CLI doesn't retry. The
 *     next scheduled review run will retry the loop naturally.
 *   - `allow_unsafe_merge: false` suppresses the merge-unsafe button
 *     in the max-cycles state; user must open the PR on GitHub instead.
 *
 * Request body (v0.8 additions marked):
 *   repo_slug:     string                  required
 *   message:       string                  required (legacy prose fallback)
 *   pr_number:     number                  required for dispatch path
 *   verdict:       "approve"|"rework"|"reject"
 *   episodic_id:   string                  required when action buttons wanted
 *   plain_summary: PlainSummary (optional)
 *   rework_cycle:  number = 0              v0.8 — current cycle that just completed
 *   max_rework_cycles: number (optional)   v0.8 — client-requested max (clamped)
 *   allow_unsafe_merge: boolean (optional) v0.8 — default true
 *   blocker_count: number (optional)       v0.8 — current-cycle blocker count
 *   pr_url: string (optional)              v0.8 — override the derived GH URL
 */
export function createReviewRoutes(
  fetchImpl: FetchLike = fetch.bind(globalThis) as FetchLike,
): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.post("/review/notify", async (c) => {
    const auth = c.req.header("authorization") ?? c.req.header("Authorization");
    if (!auth || !/^Bearer\s+(.+)$/i.test(auth)) {
      return c.json({ error: "missing or malformed Authorization: Bearer <token>" }, 401);
    }
    const token = auth.replace(/^Bearer\s+/i, "").trim();
    if (!token) return c.json({ error: "empty bearer token" }, 401);

    const body = (await c.req.json().catch(() => null)) as
      | {
          repo_slug?: unknown;
          message?: unknown;
          pr_number?: unknown;
          verdict?: unknown;
          episodic_id?: unknown;
          plain_summary?: unknown;
          rework_cycle?: unknown;
          max_rework_cycles?: unknown;
          allow_unsafe_merge?: unknown;
          blocker_count?: unknown;
          pr_url?: unknown;
          cost_usd?: unknown;
        }
      | null;
    if (!body || typeof body !== "object") {
      return c.json({ error: "invalid JSON body" }, 400);
    }

    // ---- manual shape validation (no zod dep in the Worker bundle) ----
    if (typeof body.repo_slug !== "string" || body.repo_slug.length === 0) {
      return c.json({ error: "repo_slug: expected non-empty string" }, 400);
    }
    if (typeof body.message !== "string" || body.message.length === 0) {
      return c.json({ error: "message: expected non-empty string" }, 400);
    }
    if (
      body.pr_number !== undefined &&
      (typeof body.pr_number !== "number" || !Number.isFinite(body.pr_number))
    ) {
      return c.json({ error: "pr_number: expected finite number" }, 400);
    }
    if (
      body.verdict !== undefined &&
      body.verdict !== "approve" &&
      body.verdict !== "rework" &&
      body.verdict !== "reject"
    ) {
      return c.json({ error: "verdict: expected 'approve' | 'rework' | 'reject'" }, 400);
    }
    if (body.episodic_id !== undefined && typeof body.episodic_id !== "string") {
      return c.json({ error: "episodic_id: expected string" }, 400);
    }
    if (body.plain_summary !== undefined) {
      if (body.plain_summary === null || typeof body.plain_summary !== "object") {
        return c.json({ error: "plain_summary: expected object" }, 400);
      }
      const ps = body.plain_summary as Record<string, unknown>;
      if (typeof ps["whatChanged"] !== "string") {
        return c.json({ error: "plain_summary.whatChanged: expected string" }, 400);
      }
      if (typeof ps["verdictInPlain"] !== "string") {
        return c.json({ error: "plain_summary.verdictInPlain: expected string" }, 400);
      }
      if (typeof ps["nextAction"] !== "string") {
        return c.json({ error: "plain_summary.nextAction: expected string" }, 400);
      }
      if (ps["locale"] !== "en" && ps["locale"] !== "ko") {
        return c.json({ error: "plain_summary.locale: expected 'en' | 'ko'" }, 400);
      }
    }
    if (
      body.rework_cycle !== undefined &&
      (typeof body.rework_cycle !== "number" || !Number.isFinite(body.rework_cycle) || body.rework_cycle < 0)
    ) {
      return c.json({ error: "rework_cycle: expected non-negative finite number" }, 400);
    }
    if (
      body.max_rework_cycles !== undefined &&
      (typeof body.max_rework_cycles !== "number" || !Number.isFinite(body.max_rework_cycles) || body.max_rework_cycles < 0)
    ) {
      return c.json({ error: "max_rework_cycles: expected non-negative finite number" }, 400);
    }
    if (body.allow_unsafe_merge !== undefined && typeof body.allow_unsafe_merge !== "boolean") {
      return c.json({ error: "allow_unsafe_merge: expected boolean" }, 400);
    }
    if (
      body.blocker_count !== undefined &&
      (typeof body.blocker_count !== "number" || !Number.isFinite(body.blocker_count) || body.blocker_count < 0)
    ) {
      return c.json({ error: "blocker_count: expected non-negative finite number" }, 400);
    }
    if (body.pr_url !== undefined && typeof body.pr_url !== "string") {
      return c.json({ error: "pr_url: expected string" }, 400);
    }
    // v0.13.20 (H1 #5) — per-episodic LLM cost in USD. Optional for
    // backward compat with pre-v0.13.20 CLIs; when present, drives
    // the install's monthly_spend_usd accumulator + soft-cap alert.
    if (
      body.cost_usd !== undefined &&
      (typeof body.cost_usd !== "number" || !Number.isFinite(body.cost_usd) || body.cost_usd < 0)
    ) {
      return c.json({ error: "cost_usd: expected non-negative finite number" }, 400);
    }

    // ---- auth: SHA-256(token) → installs.token_hash ----
    const tokenHash = await sha256Hex(token);
    const install = await findInstallByTokenHash(c.env, tokenHash);
    if (!install) {
      return c.json({ error: "unknown or revoked token" }, 401);
    }

    const now = new Date().toISOString();
    await touchInstall(c.env, install.id, now).catch((err) => {
      console.warn("touchInstall failed:", err);
    });

    const botToken = c.env.TELEGRAM_BOT_TOKEN;
    if (!botToken || botToken.startsWith("REPLACE_WITH_")) {
      return c.json(
        { ok: false, delivered: 0, error: "TELEGRAM_BOT_TOKEN not configured on central plane" },
        503,
      );
    }

    const telegram = new TelegramClient({ token: botToken, fetch: fetchImpl });

    // ---- v0.7.5 idempotency — dedupe on (install_id, episodic_id, repo_slug)
    // within a 5-minute window. CI retries on transient failures re-enter
    // this endpoint for the same logical event; users saw 2–3 duplicate
    // messages per PR before this check.
    const DEDUPE_WINDOW_MS = 5 * 60 * 1000;
    const episodicIdStr = typeof body.episodic_id === "string" ? body.episodic_id : "";
    if (episodicIdStr.length > 0) {
      try {
        const existing = await c.env.DB.prepare(
          "SELECT notified_at, delivered FROM review_notify_dedupe WHERE install_id = ? AND episodic_id = ? AND repo_slug = ?",
        )
          .bind(install.id, episodicIdStr, body.repo_slug)
          .first<{ notified_at: string; delivered: number }>();
        if (existing && existing.notified_at) {
          const prevMs = Date.parse(existing.notified_at);
          if (Number.isFinite(prevMs) && Date.now() - prevMs < DEDUPE_WINDOW_MS) {
            console.log(
              `review/notify dedupe hit: install=${install.id} episodic=${episodicIdStr} window=${Math.floor((Date.now() - prevMs) / 1000)}s`,
            );
            return c.json({
              ok: true,
              delivered: existing.delivered,
              deduped: true,
              reason: "duplicate_within_5min",
            });
          }
        }
      } catch (dedupeErr) {
        console.warn("review/notify dedupe lookup failed (non-fatal):", dedupeErr);
      }
    }

    // ---- autonomy decision (v0.8) --------------------------------------
    const verdict = body.verdict as "approve" | "rework" | "reject" | undefined;
    const episodicId = typeof body.episodic_id === "string" ? body.episodic_id : undefined;
    const reworkCycle =
      typeof body.rework_cycle === "number" ? Math.max(0, Math.floor(body.rework_cycle)) : 0;
    const maxReworkCycles = clampMaxCycles(
      typeof body.max_rework_cycles === "number" ? body.max_rework_cycles : undefined,
    );
    const allowUnsafeMerge =
      body.allow_unsafe_merge === undefined ? true : Boolean(body.allow_unsafe_merge);
    const plainSummary = body.plain_summary as PlainSummary | undefined;
    const locale: PlainSummaryLocale =
      plainSummary?.locale === "ko" ? "ko" : "en";
    const prNumber = typeof body.pr_number === "number" ? body.pr_number : 0;
    const prUrl =
      (typeof body.pr_url === "string" && body.pr_url.length > 0
        ? body.pr_url
        : prNumber > 0
          ? `https://github.com/${install.repoSlug}/pull/${prNumber}`
          : `https://github.com/${install.repoSlug}`);

    const useAutonomy = verdict !== undefined && episodicId !== undefined;
    const state: AutonomyState | undefined = useAutonomy
      ? decideAutonomyState({ verdict: verdict!, cycle: reworkCycle, maxCycles: maxReworkCycles })
      : undefined;

    // ---- auto-dispatch rework on first rework verdict ---------------
    let dispatchError: string | null = null;
    if (state === "reworking") {
      try {
        const installWithToken = await getInstallForDispatch(c.env, install.id);
        if (!installWithToken || !installWithToken.githubAccessToken) {
          dispatchError = "install has no github_access_token — cannot auto-dispatch rework";
          console.warn(dispatchError);
        } else {
          const nextCycle = reworkCycle + 1;
          await dispatchRepositoryEvent(
            fetchImpl,
            install.repoSlug,
            installWithToken.githubAccessToken,
            "conclave-rework",
            {
              episodic: episodicId,
              repo_slug: install.repoSlug,
              pr_number: prNumber,
              cycle: nextCycle,
              max_cycles: maxReworkCycles,
              triggered_by: "autonomy-loop",
            },
          );
        }
      } catch (err) {
        dispatchError = (err as Error).message ?? String(err);
        console.warn("auto-rework dispatch failed:", dispatchError);
      }
    }

    // ---- telegram_links fanout ----
    const chatRows = await c.env.DB.prepare(
      "SELECT chat_id FROM telegram_links WHERE install_id = ?",
    )
      .bind(install.id)
      .all<{ chat_id: number }>();
    const chatIds = (chatRows.results ?? []).map((r) => r.chat_id);
    if (chatIds.length === 0) {
      return c.json({
        ok: true,
        delivered: 0,
        reason: "no_linked_chat",
        hint: "DM @conclave_ai_bot with /link <your CONCLAVE_TOKEN> to route notifications to this chat.",
        state: state ?? "legacy",
        dispatched: state === "reworking" && dispatchError === null,
        ...(dispatchError ? { dispatchError } : {}),
      });
    }

    // ---- message text + reply_markup -----------------------------------
    let text = body.message as string;
    let replyMarkup:
      | { inline_keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>> }
      | undefined;

    if (useAutonomy && state && episodicId) {
      const ctx: AutonomyContext = {
        state,
        cycle: reworkCycle,
        maxCycles: maxReworkCycles,
        prNumber,
        prUrl,
      };
      if (typeof body.blocker_count === "number") {
        if (state === "reworking") ctx.blockerCountBefore = body.blocker_count;
        if (state === "max-cycles-reached") ctx.blockerCountAfter = body.blocker_count;
      }
      if (plainSummary) ctx.plainSummary = plainSummary;
      const rendered = renderAutonomyMessage(ctx, locale, episodicId);
      text = rendered.text;
      // Filter out the merge-unsafe button if the install's config
      // forbids it. We still render the row so other buttons stay.
      const filtered = allowUnsafeMerge
        ? rendered.buttons
        : rendered.buttons.filter(
            (b) => !(b.kind === "callback" && b.callbackData.endsWith(":merge-unsafe")),
          );
      replyMarkup = buttonsToInlineKeyboard(filtered);
      if (replyMarkup.inline_keyboard.length === 0) replyMarkup = undefined;
    } else if (episodicId) {
      // v0.7 legacy fallback — no verdict provided, keep the 3-button row
      // so existing CLI versions without v0.8 body fields keep working.
      replyMarkup = {
        inline_keyboard: [
          [
            { text: "🔧 Rework", callback_data: `ep:${episodicId}:reworked` },
            { text: "✅ Merge", callback_data: `ep:${episodicId}:merged` },
            { text: "❌ Reject", callback_data: `ep:${episodicId}:rejected` },
          ],
        ],
      };
    }

    let delivered = 0;
    for (const chatId of chatIds) {
      try {
        await telegram.sendMessage({
          chatId,
          text,
          parseMode: "HTML",
          ...(replyMarkup ? { replyMarkup } : {}),
        });
        delivered += 1;
      } catch (err) {
        console.warn(`sendMessage to chat ${chatId} failed:`, err);
      }
    }

    // v0.7.5 idempotency — record the send so retries within the window
    // are deduped. Best-effort.
    if (episodicIdStr.length > 0) {
      try {
        await c.env.DB.prepare(
          `INSERT INTO review_notify_dedupe (install_id, episodic_id, repo_slug, pr_number, notified_at, delivered)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(install_id, episodic_id, repo_slug) DO UPDATE SET
             pr_number = excluded.pr_number,
             notified_at = excluded.notified_at,
             delivered = excluded.delivered`,
        )
          .bind(install.id, episodicIdStr, body.repo_slug, prNumber, now, delivered)
          .run();
      } catch (dedupeWriteErr) {
        console.warn("review/notify dedupe write failed (non-fatal):", dedupeWriteErr);
      }
    }

    // v0.13.20 (H1 #5) — accumulate monthly spend + alert on cap
    // crossings. Best-effort: any DB error degrades to a warning so
    // /review/notify stays operational even if migration 0008 isn't
    // applied yet.
    let monthlySpend: { newSpendUsd: number; capUsd: number; rolledOver: boolean } | null = null;
    if (typeof body.cost_usd === "number" && body.cost_usd > 0) {
      monthlySpend = await addMonthlySpend(c.env, install.id, body.cost_usd);
      if (monthlySpend) {
        // Cap-crossing alert: when this episodic just pushed total
        // over 80% or 100% of the cap, send a one-shot Telegram alert.
        // Detection: was previous total below threshold AND new total
        // is at/above. We approximate "previous" as newSpend - delta.
        const prevSpend = Math.max(0, monthlySpend.newSpendUsd - body.cost_usd);
        const threshold80 = monthlySpend.capUsd * 0.8;
        const threshold100 = monthlySpend.capUsd;
        let alert: string | null = null;
        if (prevSpend < threshold100 && monthlySpend.newSpendUsd >= threshold100) {
          alert = `🛑 <b>Monthly LLM cost cap reached</b>\n\nThis install has spent <b>$${monthlySpend.newSpendUsd.toFixed(2)}</b> of the <b>$${monthlySpend.capUsd.toFixed(2)}</b> cap on <b>${body.repo_slug}</b>.\n\nFurther reviews will continue to fire (the cap is a soft alert), but consider pausing the autonomy loop to avoid runaway spend.`;
        } else if (prevSpend < threshold80 && monthlySpend.newSpendUsd >= threshold80) {
          alert = `⚠️ <b>Monthly LLM cost approaching cap</b>\n\nThis install has spent <b>$${monthlySpend.newSpendUsd.toFixed(2)}</b> (80%+ of <b>$${monthlySpend.capUsd.toFixed(2)}</b>) on <b>${body.repo_slug}</b>.`;
        }
        if (alert) {
          for (const chatId of chatIds) {
            try {
              await telegram.sendMessage({ chatId, text: alert, parseMode: "HTML" });
            } catch (err) {
              console.warn(`monthly-spend alert to chat ${chatId} failed:`, err);
            }
          }
        }
      }
    }

    return c.json({
      ok: true,
      delivered,
      state: state ?? "legacy",
      cycle: reworkCycle,
      maxCycles: maxReworkCycles,
      dispatched: state === "reworking" && dispatchError === null,
      ...(dispatchError ? { dispatchError } : {}),
      ...(monthlySpend
        ? {
            monthlySpend: {
              usd: monthlySpend.newSpendUsd,
              capUsd: monthlySpend.capUsd,
              rolledOver: monthlySpend.rolledOver,
            },
          }
        : {}),
      _defaultMax: AUTONOMY_DEFAULT_MAX_CYCLES,
    });
  });

  /**
   * v0.11 — POST /review/notify-progress
   *
   * Fire-and-forget progress emission from the CLI. Each call carries
   * one ProgressStage; the central plane:
   *
   *   1. Looks up `progress_messages` for (install, episodic, chat).
   *   2. If no row exists → `sendMessage` and INSERT the message_id.
   *   3. If a row exists  → render the accumulated timeline and
   *      `editMessageText` the same message_id, then UPDATE the row.
   *
   * The route fans out per linked chat (a single install can be linked
   * to multiple chats — DM + team group). Each chat owns its own
   * message_id; an edit to chat A cannot reach chat B's message.
   *
   * Response shape:
   *   { ok: true, delivered: number, sent: number, edited: number }
   *
   * `delivered` = sent + edited. The split is diagnostic. Consumers
   * (CLI) treat any 2xx as success and don't retry — re-emitting a
   * stage on transient failure would corrupt the timeline.
   */
  const VALID_STAGES: readonly ProgressStage[] = [
    "review-started",
    "visual-capture-started",
    "visual-capture-done",
    "tier1-done",
    "escalating-to-tier2",
    "tier2-done",
    "autofix-iter-started",
    "autofix-iter-done",
    // UX-2 / UX-3 — added in cli@0.14.2. Pre-update the central plane
    // returned HTTP 400 for these and Telegram never saw cycle-ended /
    // per-blocker progress. LIVE-caught on eventbadge PR #40 rework run
    // #25121646235 — every emit failed, the message stopped updating
    // after "auto fixing 1/3" again.
    "autofix-cycle-ended",
    "autofix-blocker-started",
    "autofix-blocker-done",
    // UX-4 — terminal user-facing report.
    "review-finished",
  ];

  app.post("/review/notify-progress", async (c) => {
    const auth = c.req.header("authorization") ?? c.req.header("Authorization");
    if (!auth || !/^Bearer\s+(.+)$/i.test(auth)) {
      return c.json({ error: "missing or malformed Authorization: Bearer <token>" }, 401);
    }
    const token = auth.replace(/^Bearer\s+/i, "").trim();
    if (!token) return c.json({ error: "empty bearer token" }, 401);

    const body = (await c.req.json().catch(() => null)) as
      | {
          repo_slug?: unknown;
          episodic_id?: unknown;
          stage?: unknown;
          payload?: unknown;
        }
      | null;
    if (!body || typeof body !== "object") {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (typeof body.repo_slug !== "string" || body.repo_slug.length === 0) {
      return c.json({ error: "repo_slug: expected non-empty string" }, 400);
    }
    if (typeof body.episodic_id !== "string" || body.episodic_id.length === 0) {
      return c.json({ error: "episodic_id: expected non-empty string" }, 400);
    }
    const stageValue = body.stage;
    if (typeof stageValue !== "string" || !VALID_STAGES.includes(stageValue as ProgressStage)) {
      return c.json({ error: `stage: expected one of ${VALID_STAGES.join("|")}` }, 400);
    }
    const stage = stageValue as ProgressStage;
    const payload: ProgressPayload =
      body.payload && typeof body.payload === "object"
        ? (body.payload as ProgressPayload)
        : {};

    const tokenHash = await sha256Hex(token);
    const install = await findInstallByTokenHash(c.env, tokenHash);
    if (!install) {
      return c.json({ error: "unknown or revoked token" }, 401);
    }

    const now = new Date().toISOString();
    await touchInstall(c.env, install.id, now).catch((err) => {
      console.warn("touchInstall failed:", err);
    });

    const botToken = c.env.TELEGRAM_BOT_TOKEN;
    if (!botToken || botToken.startsWith("REPLACE_WITH_")) {
      return c.json(
        { ok: false, delivered: 0, error: "TELEGRAM_BOT_TOKEN not configured on central plane" },
        503,
      );
    }
    const telegram = new TelegramClient({ token: botToken, fetch: fetchImpl });

    const chatRows = await c.env.DB.prepare(
      "SELECT chat_id FROM telegram_links WHERE install_id = ?",
    )
      .bind(install.id)
      .all<{ chat_id: number }>();
    const chatIds = (chatRows.results ?? []).map((r) => r.chat_id);
    if (chatIds.length === 0) {
      return c.json({
        ok: true,
        delivered: 0,
        sent: 0,
        edited: 0,
        reason: "no_linked_chat",
      });
    }

    const newLine = renderProgressLine(stage, payload);
    const meta = {
      episodicId: body.episodic_id,
      repo: body.repo_slug,
      ...(typeof payload.pullNumber === "number" ? { pullNumber: payload.pullNumber } : {}),
    };
    const prNumber = typeof payload.pullNumber === "number" ? payload.pullNumber : null;

    let sent = 0;
    let edited = 0;
    for (const chatId of chatIds) {
      try {
        // UX-4 — review-finished is a SEPARATE terminal report message,
        // not an append to the progress chain. Send via sendMessage so
        // it lands as a fresh Telegram message in the chat. The progress
        // chain message stays put as the running log; the terminal
        // report is a single big "여기서 끝났습니다" card.
        if (stage === "review-finished") {
          // UX-7 — action buttons (승인 / 보류 / 거부). Reuse the
          // existing ep:<id>:<outcome> callback_data vocabulary so the
          // existing webhook handler routes the click correctly:
          //   - 승인 → "merged" (signals approve+merge)
          //   - 보류 → "hold" (no-op; user revisits later)
          //   - 거부 → "rejected"
          await telegram.sendMessage({
            chatId,
            text: newLine.text,
            parseMode: "HTML",
            replyMarkup: {
              inline_keyboard: [
                [
                  { text: "✅ 승인", callback_data: `ep:${body.episodic_id}:merged` },
                  { text: "⏸ 보류", callback_data: `ep:${body.episodic_id}:hold` },
                  { text: "❌ 거부", callback_data: `ep:${body.episodic_id}:rejected` },
                ],
              ],
            },
          });
          sent += 1;
          continue;
        }
        // UX-5 — review-started ALWAYS creates a fresh message in this
        // chat (no findProgressMessage lookup). Each cycle's review.yml
        // run emits its own review-started, so each cycle gets its own
        // Telegram message. Subsequent stages within the cycle update
        // the most recent message via the standard find→edit path.
        // Pre-UX-5, all cycles' progress collapsed into ONE long edited
        // message — Bae could see "blocker 1/10..10/10" but had no
        // separation between cycle 1 and cycle 2 events.
        const existing = stage === "review-started"
          ? null
          : await findProgressMessage(c.env, install.id, body.episodic_id, chatId);
        if (!existing) {
          const lines: ProgressLine[] = [newLine];
          const text = renderProgressMessage(lines, meta);
          const result = await telegram.sendMessage({
            chatId,
            text,
            parseMode: "HTML",
          });
          if (result && typeof result.messageId === "number") {
            await insertProgressMessage(c.env, {
              installId: install.id,
              episodicId: body.episodic_id,
              chatId,
              messageId: result.messageId,
              prNumber,
              repoSlug: body.repo_slug,
              lastLines: JSON.stringify(lines),
              lastText: text,
              now,
            });
            sent += 1;
          }
          continue;
        }
        // Existing chain — append the new line and editMessageText.
        let priorLines: ProgressLine[];
        try {
          const parsed = JSON.parse(existing.lastLines) as unknown;
          priorLines = Array.isArray(parsed) ? (parsed as ProgressLine[]) : [];
        } catch {
          priorLines = [];
        }
        const truncated = priorLines.slice(-Math.max(TELEGRAM_TEXT_LIMIT_LINES - 1, 1));
        const lines = [...truncated, newLine];
        const text = renderProgressMessage(lines, meta);
        if (text === existing.lastText) {
          // Identical render — Telegram returns 400 "message is not
          // modified". Skip the API call and refresh updated_at so the
          // pruner doesn't reap an active chain.
          await updateProgressMessage(c.env, {
            installId: install.id,
            episodicId: body.episodic_id,
            chatId,
            messageId: existing.messageId,
            lastLines: JSON.stringify(lines),
            lastText: text,
            now,
          });
          edited += 1;
          continue;
        }
        await telegram.editMessageText({
          chatId,
          messageId: existing.messageId,
          text,
          parseMode: "HTML",
        });
        await updateProgressMessage(c.env, {
          installId: install.id,
          episodicId: body.episodic_id,
          chatId,
          messageId: existing.messageId,
          lastLines: JSON.stringify(lines),
          lastText: text,
          now,
        });
        edited += 1;
      } catch (err) {
        console.warn(`progress emit chat=${chatId} stage=${stage} failed:`, err);
      }
    }

    return c.json({
      ok: true,
      delivered: sent + edited,
      sent,
      edited,
      stage,
    });
  });

  return app;
}
