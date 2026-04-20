import { Hono } from "hono";
import type { Env } from "../env.js";
import type { FetchLike } from "../github.js";
import { findInstallByTokenHash, touchInstall } from "../db/installs.js";
import { sha256Hex } from "../util.js";
import { TelegramClient } from "../telegram.js";

/**
 * POST /review/notify
 *
 * Bearer-auth'd endpoint that the CLI notifier hits when
 * `CONCLAVE_TOKEN` is set. The central plane resolves the caller's
 * install by SHA-256 of the bearer token, looks up every telegram_link
 * row pointing at that install, and fans the `sendMessage` out to the
 * central @Conclave_ai_bot. Consumer repos no longer need their own
 * bot token — they already have CONCLAVE_TOKEN installed by
 * `conclave init`.
 *
 * Shape of the request body:
 *   {
 *     repo_slug: string,
 *     message:   string,
 *     pr_number?: number,
 *     verdict?:  "approve" | "rework" | "reject",
 *     episodic_id?: string,
 *   }
 *
 * Inline action keyboard (🔧 rework / ✅ merge / ❌ reject) is attached
 * ONLY when `episodic_id` is provided — button callbacks are keyed by
 * episodic, so without one the webhook handler can't do anything with a
 * click. Keep parity with `apps/central-plane/src/routes/telegram.ts`
 * which parses `ep:<episodicId>:<outcome>` callbacks.
 */
export function createReviewRoutes(fetchImpl: FetchLike = fetch): Hono<{ Bindings: Env }> {
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

    // ---- auth: SHA-256(token) → installs.token_hash ----
    const tokenHash = await sha256Hex(token);
    const install = await findInstallByTokenHash(c.env, tokenHash);
    if (!install) {
      return c.json({ error: "unknown or revoked token" }, 401);
    }

    const now = new Date().toISOString();
    // last_seen_at bump — best-effort; don't block dispatch on it.
    await touchInstall(c.env, install.id, now).catch((err) => {
      console.warn("touchInstall failed:", err);
    });

    // ---- telegram_links fanout ----
    const chatRows = await c.env.DB.prepare(
      "SELECT chat_id FROM telegram_links WHERE install_id = ?",
    )
      .bind(install.id)
      .all<{ chat_id: number }>();
    const chatIds = (chatRows.results ?? []).map((r) => r.chat_id);
    if (chatIds.length === 0) {
      return c.json({ ok: true, delivered: 0, reason: "no linked chat" });
    }

    const botToken = c.env.TELEGRAM_BOT_TOKEN;
    if (!botToken || botToken.startsWith("REPLACE_WITH_")) {
      // Operator misconfiguration — surface plainly, don't silently
      // swallow. Consumer CLI will log the 503 and continue.
      return c.json(
        { ok: false, delivered: 0, error: "TELEGRAM_BOT_TOKEN not configured on central plane" },
        503,
      );
    }

    const telegram = new TelegramClient({ token: botToken, fetch: fetchImpl });

    // Optional inline keyboard — only useful when we have an episodic_id
    // to put in callback_data. See parseCallbackData in telegram.ts.
    const episodicId = typeof body.episodic_id === "string" ? body.episodic_id : undefined;
    const replyMarkup = episodicId
      ? {
          inline_keyboard: [
            [
              { text: "🔧 Rework", callback_data: `ep:${episodicId}:reworked` },
              { text: "✅ Merge", callback_data: `ep:${episodicId}:merged` },
              { text: "❌ Reject", callback_data: `ep:${episodicId}:rejected` },
            ],
          ],
        }
      : undefined;

    let delivered = 0;
    for (const chatId of chatIds) {
      try {
        await telegram.sendMessage({
          chatId,
          text: body.message,
          parseMode: "HTML",
          ...(replyMarkup ? { replyMarkup } : {}),
        });
        delivered += 1;
      } catch (err) {
        // Per-chat failure shouldn't abort the rest of the fanout —
        // one dead chat shouldn't starve the others.
        console.warn(`sendMessage to chat ${chatId} failed:`, err);
      }
    }

    return c.json({ ok: true, delivered });
  });

  return app;
}
