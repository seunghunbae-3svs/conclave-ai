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
  classifyOutcome,
  dispatchRepositoryEvent,
  escapeHtml,
  eventTypeFor,
  labelForOutcome,
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
    const providedSecret = c.req.header("x-telegram-bot-api-secret-token");
    console.log(JSON.stringify({
      event: "webhook.received",
      has_secret_env: !!c.env.TELEGRAM_WEBHOOK_SECRET,
      secret_header_present: !!providedSecret,
      secret_match: c.env.TELEGRAM_WEBHOOK_SECRET ? providedSecret === c.env.TELEGRAM_WEBHOOK_SECRET : null,
    }));
    if (c.env.TELEGRAM_WEBHOOK_SECRET) {
      if (providedSecret !== c.env.TELEGRAM_WEBHOOK_SECRET) {
        console.warn("webhook: secret mismatch — returning 401");
        return c.json({ error: "invalid webhook secret" }, 401);
      }
    }

    const rawBody = await c.req.text();
    let update: {
      update_id?: number;
      message?: { chat?: { id?: number }; text?: string; from?: { username?: string; first_name?: string } };
      callback_query?: {
        id?: string;
        data?: string;
        from?: { username?: string; first_name?: string };
        message?: { chat?: { id?: number } };
      };
    } | null;
    try {
      update = JSON.parse(rawBody);
    } catch {
      update = null;
    }
    console.log(JSON.stringify({
      event: "webhook.body_parsed",
      body_len: rawBody.length,
      body_keys: update ? Object.keys(update) : null,
      has_message: !!update?.message,
      has_callback_query: !!update?.callback_query,
      callback_data: update?.callback_query?.data ?? null,
    }));
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

      console.log(JSON.stringify({
        event: "callback_query.received",
        cq_id: cq.id,
        cq_data: cq.data,
        chat_id: chatId,
        from_username: cq.from?.username,
      }));
      if (!parsed) {
        console.warn("callback_query: parsed=null (unknown button)");
        await telegram.answerCallbackQuery({ id: cq.id!, text: "Unknown button" });
        return c.json({ ok: true });
      }
      if (!chatId) {
        console.warn("callback_query: chatId missing");
        await telegram.answerCallbackQuery({ id: cq.id!, text: "Missing chat context" });
        return c.json({ ok: true });
      }

      const link = await findLinkByChatId(c.env, chatId);
      console.log(JSON.stringify({
        event: "callback_query.link_lookup",
        chat_id: chatId,
        found: !!link,
        install_id: link?.installId ?? null,
      }));
      if (!link) {
        console.warn("callback_query: link not found for chat_id=" + chatId);
        await telegram.answerCallbackQuery({
          id: cq.id!,
          text: "This chat is not linked. DM /link <token> first.",
          showAlert: true,
        });
        return c.json({ ok: true });
      }

      const classified = classifyOutcome(parsed.outcome);

      // v0.8 — "cancel" is a no-op: the user backed out of the unsafe
      // merge confirmation. Just ack the query so the spinner stops.
      // UX-7 follow-on — "hold" maps to kind=cancel (no-op ack), but
      // the user clicked the explicit 보류 button on the review-finished
      // card and deserves a meaningful Korean ack message + a Telegram
      // chat reply so they know the click registered. Pre-this they
      // clicked 보류 and saw nothing change; click felt broken.
      if (classified.kind === "cancel") {
        const isHold = parsed.outcome === "hold";
        const ackText = isHold ? "⏸ 보류됨 — 나중에 다시 검토해주세요." : "Cancelled";
        await telegram.answerCallbackQuery({
          id: cq.id!,
          text: ackText,
        });
        if (isHold) {
          // Also drop a chat message so the chat history shows the
          // decision (callback acks are ephemeral toast pop-ups).
          try {
            await telegram.sendMessage({
              chatId,
              text: "⏸ <b>보류 처리되었습니다.</b>\n남은 항목은 사람 검토가 필요합니다. PR을 다시 보시고 결정되면 Telegram에서 ✅ 승인 / ❌ 거부 버튼을 누르거나 PR 페이지에서 직접 처리해주세요.",
              parseMode: "HTML",
            });
          } catch (err) {
            console.warn("hold ack chat message failed:", err);
          }
        }
        return c.json({ ok: true });
      }

      // v0.8 — "merge-unsafe" is a two-step action: show a warning
      // message with [Yes, accept risk] + [Cancel] buttons. The
      // dispatch itself fires from the follow-up "merge-confirmed"
      // callback (which classifies as a regular dispatch).
      if (classified.kind === "confirm-unsafe") {
        try {
          await telegram.sendMessage({
            chatId,
            text: [
              "<b>⚠️ Unresolved issues on this PR</b>",
              "",
              "Conclave's auto-fix loop hit its limit and this PR still flags blockers.",
              "Proceed only if you have read the diff yourself.",
            ].join("\n"),
            parseMode: "HTML",
            replyMarkup: {
              inline_keyboard: [
                [
                  {
                    text: "✅ Yes, merge anyway",
                    callback_data: `ep:${parsed.episodicId}:merge-confirmed`,
                  },
                  {
                    text: "❌ Cancel",
                    callback_data: `ep:${parsed.episodicId}:cancel`,
                  },
                ],
              ],
            },
          });
          await telegram.answerCallbackQuery({
            id: cq.id!,
            text: "Confirm in the new message",
          });
        } catch (err) {
          console.error("unsafe-merge prompt failed:", err);
          await telegram.answerCallbackQuery({
            id: cq.id!,
            text: "⚠ prompt send failed",
            showAlert: true,
          });
        }
        return c.json({ ok: true });
      }

      const install = await getInstallForDispatch(c.env, link.installId);
      console.log(JSON.stringify({
        event: "callback_query.install_lookup",
        install_id: link.installId,
        found: !!install,
        repo_slug: install?.repoSlug ?? null,
        has_token: !!install?.githubAccessToken,
        needs_lazy_encrypt: install?.needsLazyEncrypt ?? null,
      }));
      if (!install || !install.githubAccessToken) {
        console.warn("callback_query: install or githubAccessToken missing");
        await telegram.answerCallbackQuery({
          id: cq.id!,
          text: "Install missing GitHub token — re-run `conclave init` to refresh.",
          showAlert: true,
        });
        return c.json({ ok: true });
      }

      const { eventType } = classified;
      // v0.9.2 — resolve pr_number from review_notify_dedupe so the
      // consumer's rework/merge/reject workflow can dispatch without
      // the legacy grep-on-main fallback (which was paired with the
      // persist-episodic step removed in the same release). If the
      // episodic hasn't been notified yet (shouldn't happen — the
      // button only appears after notify), the consumer workflow's
      // grep fallback still kicks in.
      let prNumber: number | null = null;
      try {
        const row = await c.env.DB
          .prepare(
            `SELECT pr_number FROM review_notify_dedupe
             WHERE episodic_id = ? AND install_id = ?
             ORDER BY notified_at DESC LIMIT 1`,
          )
          .bind(parsed.episodicId, install.id)
          .first<{ pr_number: number | null }>();
        if (row && typeof row.pr_number === "number" && Number.isFinite(row.pr_number)) {
          prNumber = row.pr_number;
        }
      } catch (err) {
        console.error("pr_number lookup failed (non-fatal, dispatch continues):", err);
      }
      const clientPayload: Record<string, unknown> = {
        episodic: parsed.episodicId,
        outcome: parsed.outcome,
        triggeredBy: user ?? "telegram",
      };
      if (prNumber !== null) {
        clientPayload.pr_number = prNumber;
      }

      console.log(JSON.stringify({
        event: "callback_query.dispatch_attempt",
        repo_slug: install.repoSlug,
        event_type: eventType,
        episodic_id: parsed.episodicId,
        outcome: parsed.outcome,
        pr_number: prNumber,
      }));
      try {
        await dispatchRepositoryEvent(
          fetchImpl,
          install.repoSlug,
          install.githubAccessToken,
          eventType,
          clientPayload,
        );
        console.log(JSON.stringify({
          event: "callback_query.dispatch_success",
          repo_slug: install.repoSlug,
          event_type: eventType,
        }));
        if (install.needsLazyEncrypt) {
          try {
            await upgradeInstallTokenEncryption(c.env, install.id, install.githubAccessToken);
          } catch (upgradeErr) {
            console.error("token lazy-encrypt upgrade failed:", upgradeErr);
          }
        }
        // v0.7.5 Bug A fix — answerCallbackQuery shows only a brief
        // ephemeral toast, which users on mobile often miss. Pair it
        // with a visible chat message so the user has a permanent
        // record the action was received and routed to GitHub.
        await telegram.answerCallbackQuery({
          id: cq.id!,
          text: `✓ ${eventType} dispatched`,
        });
        const actionLabel = labelForOutcome(parsed.outcome);
        await telegram.sendMessage({
          chatId,
          text: [
            `${actionLabel} on <b>${escapeHtml(install.repoSlug)}</b>`,
            `<i>triggered by ${escapeHtml(user ?? "telegram")} · event: ${eventType}</i>`,
          ].join("\n"),
          parseMode: "HTML",
        }).catch((sendErr) => {
          // Don't fail the whole webhook if the follow-up message can't
          // be sent — the dispatch already landed and the toast already
          // acknowledged the click. Just log.
          console.warn("followup sendMessage failed:", sendErr);
        });
      } catch (err) {
        console.error("dispatch failed:", err);
        await telegram.answerCallbackQuery({
          id: cq.id!,
          text: "⚠ dispatch failed — see central plane logs",
          showAlert: true,
        });
        // Also send a visible failure message — matches the success path
        // so users always see a chat record of what they clicked, even
        // when the toast has disappeared.
        await telegram.sendMessage({
          chatId,
          text: `⚠ <b>${eventType}</b> dispatch failed on <b>${escapeHtml(install.repoSlug)}</b>. Check the central plane logs or retry.`,
          parseMode: "HTML",
        }).catch((sendErr) => {
          console.warn("followup failure sendMessage failed:", sendErr);
        });
      }
      return c.json({ ok: true });
    }

    // Any other update type — ignore but 200 so Telegram stops retrying.
    return c.json({ ok: true });
  });

  return app;
}
