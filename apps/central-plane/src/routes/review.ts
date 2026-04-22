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
import { findInstallByTokenHash, touchInstall } from "../db/installs.js";
import { getInstallForDispatch } from "../db/telegram.js";
import { sha256Hex } from "../util.js";
import { TelegramClient, dispatchRepositoryEvent } from "../telegram.js";

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

    // ---- autonomy decision (v0.8) --------------------------------------
    // The verdict drives state. Cycle + max decide between `reworking` vs
    // `max-cycles-reached` on the rework branch. Approve/reject map
    // directly. When verdict/episodic_id are absent (legacy caller), we
    // fall back to the v0.7 keyboard for compatibility.
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
    // Fired EARLY (before Telegram fanout) so a flaky Telegram API
    // doesn't starve the pipeline. A dispatch failure is logged but
    // doesn't fail the response — the next scheduled review will
    // recover the loop.
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
        reason: "no linked chat",
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

    return c.json({
      ok: true,
      delivered,
      state: state ?? "legacy",
      cycle: reworkCycle,
      maxCycles: maxReworkCycles,
      dispatched: state === "reworking" && dispatchError === null,
      ...(dispatchError ? { dispatchError } : {}),
      _defaultMax: AUTONOMY_DEFAULT_MAX_CYCLES,
    });
  });

  return app;
}
