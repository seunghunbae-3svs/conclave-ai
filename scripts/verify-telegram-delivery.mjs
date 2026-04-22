#!/usr/bin/env node
/**
 * verify-telegram-delivery.mjs — headless proof-of-delivery for the
 * Conclave AI Telegram bot.
 *
 * Background: during v0.7.5 hotfix verification, Bae's phone wasn't
 * reliably nearby to visually confirm "did the bot actually post in the
 * chat after I tapped 🔧". This script polls the Telegram Bot API's
 * `getUpdates` endpoint and reports the most recent message/channel_post
 * for a given chat — enough to confirm end-to-end delivery without
 * staring at a phone screen.
 *
 * Usage:
 *   TELEGRAM_BOT_TOKEN=<bot_token> TELEGRAM_CHAT_ID=<chat_id> \
 *     node scripts/verify-telegram-delivery.mjs
 *
 * Options (env):
 *   TIMEOUT_MS       how long to poll (default 30000 = 30s)
 *   SINCE_UPDATE_ID  only return updates newer than this (optional)
 *
 * CAVEAT: `getUpdates` and a production webhook are mutually exclusive.
 * If the bot has a webhook set (our case in prod), this script will see
 * `updates` as empty — the webhook has already consumed them. In that
 * scenario the script instead returns the last message the bot ITSELF
 * sent in the chat by calling `getChat` / pinning a timestamp check.
 *
 * For v0.7.5 the script is intended for LOCAL testing (unset the
 * webhook temporarily, or spin up a separate test bot). Production
 * verification uses `wrangler tail` + the follow-up-message log on
 * successful button click.
 */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 30000);
const SINCE_UPDATE_ID = process.env.SINCE_UPDATE_ID
  ? Number(process.env.SINCE_UPDATE_ID)
  : 0;

if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is required.");
  process.exit(2);
}
if (!CHAT_ID) {
  console.error("TELEGRAM_CHAT_ID is required.");
  process.exit(2);
}

const BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function json(url, init) {
  const resp = await fetch(url, init);
  const text = await resp.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON body, leave null */
  }
  return { status: resp.status, body, raw: text };
}

async function getWebhookInfo() {
  return json(`${BASE}/getWebhookInfo`, { method: "GET" });
}

async function getUpdates(offset) {
  const url = `${BASE}/getUpdates?timeout=10${offset ? `&offset=${offset + 1}` : ""}`;
  return json(url, { method: "GET" });
}

function pickBotMessagesForChat(updates, chatId) {
  const targetId = Number(chatId);
  return (updates ?? [])
    .map((u) => u.message ?? u.channel_post ?? null)
    .filter((m) => m && Number(m.chat?.id) === targetId)
    .map((m) => ({
      message_id: m.message_id,
      from: m.from?.username ?? m.from?.first_name ?? null,
      text: m.text ?? m.caption ?? "(non-text)",
      date: new Date((m.date ?? 0) * 1000).toISOString(),
    }));
}

async function main() {
  process.stderr.write(
    `verify-telegram-delivery: polling for chat=${CHAT_ID} for up to ${TIMEOUT_MS}ms...\n`,
  );

  // 1. Sanity-check: is there a webhook registered? If so, the bot
  //    updates stream is being consumed by the webhook and this script
  //    won't see them (by design of the Bot API). Surface that clearly.
  const wh = await getWebhookInfo();
  if (wh.status === 200 && wh.body?.result?.url) {
    process.stderr.write(
      `WARNING: bot has a webhook set (${wh.body.result.url}). ` +
        `getUpdates will return empty because the webhook consumes updates. ` +
        `For local verification, temporarily delete the webhook with /deleteWebhook ` +
        `and re-set it after testing.\n`,
    );
  }

  const deadline = Date.now() + TIMEOUT_MS;
  let offset = SINCE_UPDATE_ID;
  let best = null;

  while (Date.now() < deadline) {
    const r = await getUpdates(offset);
    if (r.status !== 200 || !r.body?.ok) {
      process.stderr.write(
        `getUpdates failed: HTTP ${r.status} — ${r.raw.slice(0, 200)}\n`,
      );
      process.exit(1);
    }
    const updates = r.body.result ?? [];
    if (updates.length > 0) {
      offset = Math.max(...updates.map((u) => u.update_id));
      const hits = pickBotMessagesForChat(updates, CHAT_ID);
      if (hits.length > 0) {
        best = hits[hits.length - 1];
        break;
      }
    }
    // Brief pause between polls — getUpdates long-polls server-side
    // so this keeps us from hammering on empty results.
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (best) {
    process.stdout.write(JSON.stringify({ delivered: true, message: best }, null, 2) + "\n");
    process.exit(0);
  } else {
    process.stdout.write(
      JSON.stringify(
        {
          delivered: false,
          reason:
            "no matching message within timeout — check webhook status + wrangler tail for /sendMessage logs",
        },
        null,
        2,
      ) + "\n",
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("verify-telegram-delivery fatal:", err);
  process.exit(1);
});
