import { Hono } from "hono";
import type { Env } from "../env.js";
import type { FetchLike } from "../github.js";
import { findInstallByTokenHash } from "../db/installs.js";
import {
  findLinkByChatId,
  upsertLink,
  getInstallForDispatch,
  upgradeInstallTokenEncryption,
} from "../db/telegram.js";
import { sha256Hex } from "../util.js";
import {
  TelegramClient,
  dispatchRepositoryEvent,
  eventTypeFor,
  parseCallbackData,
} from "../telegram.js";

/**
 * Factory — injects fetch for tests. Production passes globalThis.fetch.
 * v0.7.3 — default now binds globalThis to avoid the "Illegal
 * invocation" fault when downstream code calls the unbound native
 * fetch (see router.ts for the top-level binding, this is a
 * defence-in-depth layer).
 */
export function createTelegramRoutes(
  fetchImpl: FetchLike = fetch.bind(globalThis) as FetchLike,
): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.post("/telegram/webhook", async (c) => {
    const botToken = c.env.TELEGRAM_BOT_TOKEN;
    if (!botToken || botToken.startsWith("REPLACE_WITH_")) {
      // Accept the update so Telegram doesn't retry indefinitely, but log
      // a useful error. If the operator hasn't set TELEGRAM_BOT_TOKEN yet,
      // the webhook shouldn't even be registered; we still fail soft.
      console.warn("telegram webhook called but TELEGRAM_BOT_TOKEN not set");
      return c.json({ ok: true, note: "bot not configured" });
    }

    // Optional webhook-secret check — set by `wrangler secret put
    // TELEGRAM_WEBHOOK_SECRET` and passed at setWebhook time as
    // `secret_token`. If unset we skip the check (acceptable for alpha).
    if (c.env.TELEGRAM_WEBHOOK_SECRET) {
      const provided = c.req.header("x-telegram-bot-api-secret-token");
      if (provided !== c.env.TELEGRAM_WEBHOOK_SECRET) {
        return c.json({ error: "invalid webhook secret" }, 401);
      }
    }

    const update = (await c.req.json().catch(() => null)) as {
      update_id?: number;
      message?: { chat?: { id?: number }; text?: string; from?: { username?: string; first_name?: string } };
      callback_query?: {
        id?: string;
        data?: string;
        from?: { username?: string; first_name?: string };
        message?: { chat?: { id?: number } };
      };
    } | null;
    if (!update) return c.json({ ok: true });

    const telegram = new TelegramClient({ token: botToken, fetch: fetchImpl });

    // ---- message: handle /start /help /link ------------------------------
    if (update.message && typeof update.message.text === "string" && update.message.chat?.id) {
      const chatId = update.message.chat.id;
      const text = update.message.text.trim();
      const userLabel =
        update.message.from?.username ?? update.message.from?.first_name ?? null;

      if (/^\/start\b/.test(text) || /^\/help\b/.test(text)) {
        await telegram.sendMessage({
          chatId,
          text: [
            "<b>Conclave AI bot</b>",
            "",
            "This bot receives review notifications from your Conclave AI installs and ",
            "fires the 🤖 Auto-fix / ✅ Merge / ❌ Close actions when you tap them.",
            "",
            "To link this chat to a repo install, run <code>conclave init</code> on your ",
            "machine, then send:",
            "",
            "<code>/link YOUR_CONCLAVE_TOKEN</code>",
            "",
            "The token is printed by <code>conclave init</code> once — it is not retrievable.",
          ].join("\n"),
          parseMode: "HTML",
        });
        return c.json({ ok: true });
      }

      const linkMatch = text.match(/^\/link\s+(c_\S+)/);
      if (linkMatch) {
        const token = linkMatch[1]!;
        const tokenHash = await sha256Hex(token);
        const install = await findInstallByTokenHash(c.env, tokenHash);
        if (!install) {
          await telegram.sendMessage({
            chatId,
            text: "❌ That token was not recognised. Run `conclave init` to get a fresh CONCLAVE_TOKEN.",
          });
          return c.json({ ok: true });
        }
        await upsertLink(c.env, {
          chatId,
          installId: install.id,
          linkedAt: new Date().toISOString(),
          userLabel,
        });
        await telegram.sendMessage({
          chatId,
          text: `✅ Linked this chat to <b>${install.repoSlug}</b>. Review notifications and inline actions will now route here.`,
          parseMode: "HTML",
        });
        return c.json({ ok: true });
      }

      // Any other text we don't understand — soft guidance.
      await telegram.sendMessage({
        chatId,
        text: "I only understand /start, /help, and /link &lt;token&gt; right now.",
        parseMode: "HTML",
      });
      return c.json({ ok: true });
    }

    // ---- callback_query: 🔧 / ✅ / ❌ button click ------------------------
    if (update.callback_query && update.callback_query.id && update.callback_query.data) {
      const cq = update.callback_query;
      const parsed = parseCallbackData(cq.data);
      const chatId = cq.message?.chat?.id;
      const user = cq.from?.username ?? cq.from?.first_name ?? null;

      if (!parsed) {
        await telegram.answerCallbackQuery({ id: cq.id!, text: "Unknown button" });
        return c.json({ ok: true });
      }
      if (!chatId) {
        await telegram.answerCallbackQuery({ id: cq.id!, text: "Missing chat context" });
        return c.json({ ok: true });
      }

      const link = await findLinkByChatId(c.env, chatId);
      if (!link) {
        await telegram.answerCallbackQuery({
          id: cq.id!,
          text: "This chat is not linked. DM /link <token> first.",
          showAlert: true,
        });
        return c.json({ ok: true });
      }

      const install = await getInstallForDispatch(c.env, link.installId);
      if (!install || !install.githubAccessToken) {
        await telegram.answerCallbackQuery({
          id: cq.id!,
          text: "Install missing GitHub token — re-run `conclave init` to refresh.",
          showAlert: true,
        });
        return c.json({ ok: true });
      }

      const eventType = eventTypeFor(parsed.outcome);
      const clientPayload = {
        episodic: parsed.episodicId,
        outcome: parsed.outcome,
        triggeredBy: user ?? "telegram",
      };

      try {
        await dispatchRepositoryEvent(
          fetchImpl,
          install.repoSlug,
          install.githubAccessToken,
          eventType,
          clientPayload,
        );
        // v0.5 H — lazy-upgrade the token field to encrypted storage if
        // we just used a plaintext legacy row. Runs after the dispatch
        // succeeds so a KEK mis-set (which would throw here) doesn't
        // block the action the user wanted. We log the error instead of
        // failing the request — the dispatch already succeeded and the
        // user got their ack.
        if (install.needsLazyEncrypt) {
          try {
            await upgradeInstallTokenEncryption(c.env, install.id, install.githubAccessToken);
          } catch (upgradeErr) {
            console.error("token lazy-encrypt upgrade failed:", upgradeErr);
          }
        }
        await telegram.answerCallbackQuery({
          id: cq.id!,
          text: `✓ ${eventType} dispatched on ${install.repoSlug}`,
        });
      } catch (err) {
        console.error("dispatch failed:", err);
        await telegram.answerCallbackQuery({
          id: cq.id!,
          text: "⚠ dispatch failed — see central plane logs",
          showAlert: true,
        });
      }
      return c.json({ ok: true });
    }

    // Any other update type — ignore but 200 so Telegram stops retrying.
    return c.json({ ok: true });
  });

  return app;
}
