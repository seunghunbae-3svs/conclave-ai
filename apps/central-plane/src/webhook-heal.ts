import type { Env } from "./env.js";

/**
 * v0.13.7 — Telegram webhook self-heal.
 *
 * Live-caught problem: every few hours the Telegram webhook for
 * `@BAE_DUAL_bot` clears itself (`getWebhookInfo` returns `url=""`).
 * The official cause: Telegram automatically deletes the registered
 * webhook the moment ANY consumer calls `getUpdates` on the same bot
 * token (long-polling and webhooks are mutually exclusive). Once a
 * stray dev tool, debugger, or stale workflow on another repo polls
 * for updates, the webhook falls off and every action button click
 * stops dispatching repository_dispatch.
 *
 * The robust fix is to find and kill the offending poller, but in a
 * multi-repo dogfood environment we don't always control every
 * consumer. The pragmatic fix: have the Worker re-bind the webhook on
 * a 10-minute cron so the window of broken-buttons is bounded.
 *
 * Idempotency: `getWebhookInfo` first → if `url` already matches our
 * Worker URL we no-op (one HTTP call). Only on mismatch do we call
 * `setWebhook`.
 *
 * Auth: uses TELEGRAM_BOT_TOKEN (already a Worker secret for sending
 * verdict messages) + TELEGRAM_WEBHOOK_SECRET (set by the operator
 * once during webhook bootstrap; the same secret is included as
 * `secret_token` so Telegram echoes it back as the
 * `x-telegram-bot-api-secret-token` header on every callback —
 * gives the webhook handler tamper-detection).
 */

const TARGET_PATH = "/telegram/webhook";

interface WebhookInfo {
  url: string;
  pending_update_count: number;
  last_error_date?: number;
  last_error_message?: string;
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

/**
 * Compute the canonical Worker URL the webhook should point to. Falls
 * back to the production URL when the operator hasn't overridden it.
 */
export function resolveWebhookUrl(env: Env): string {
  const base = (env.PUBLIC_BASE_URL ?? "https://conclave-ai.seunghunbae.workers.dev").replace(/\/$/, "");
  return base + TARGET_PATH;
}

export async function checkWebhookBound(
  botToken: string,
  fetchImpl: typeof fetch = fetch.bind(globalThis),
): Promise<WebhookInfo | null> {
  const resp = await fetchImpl(`https://api.telegram.org/bot${botToken}/getWebhookInfo`);
  if (!resp.ok) return null;
  const json = (await resp.json().catch(() => null)) as TelegramResponse<WebhookInfo> | null;
  if (!json || !json.ok || !json.result) return null;
  return json.result;
}

export async function rebindWebhook(
  botToken: string,
  url: string,
  secretToken: string,
  fetchImpl: typeof fetch = fetch.bind(globalThis),
): Promise<{ ok: boolean; description?: string }> {
  const resp = await fetchImpl(`https://api.telegram.org/bot${botToken}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url,
      secret_token: secretToken,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false,
    }),
  });
  const json = (await resp.json().catch(() => null)) as TelegramResponse<boolean> | null;
  return {
    ok: !!(json && json.ok),
    ...(json?.description ? { description: json.description } : {}),
  };
}

/**
 * v0.13.7 — top-level self-heal entry point. Returns a JSON-loggable
 * audit so cron logs show what happened: bound-already / rebound /
 * skipped (no creds) / failed (which step).
 */
export interface HealResult {
  outcome: "bound-already" | "rebound" | "skipped" | "failed";
  expected: string;
  actual?: string | null;
  reason?: string;
  rebindError?: string;
  pendingUpdateCount?: number;
  lastErrorMessage?: string;
}

export async function selfHealWebhook(
  env: Env,
  fetchImpl: typeof fetch = fetch.bind(globalThis),
): Promise<HealResult> {
  const expected = resolveWebhookUrl(env);
  const botToken = env.TELEGRAM_BOT_TOKEN;
  const secretToken = env.TELEGRAM_WEBHOOK_SECRET;
  if (!botToken || botToken.startsWith("REPLACE_WITH_")) {
    return { outcome: "skipped", expected, reason: "TELEGRAM_BOT_TOKEN not configured" };
  }
  if (!secretToken) {
    return {
      outcome: "skipped",
      expected,
      reason: "TELEGRAM_WEBHOOK_SECRET not set — refusing to bind without secret_token (operator must run wrangler secret put once)",
    };
  }
  const info = await checkWebhookBound(botToken, fetchImpl);
  if (!info) {
    return { outcome: "failed", expected, reason: "getWebhookInfo failed" };
  }
  if (info.url === expected) {
    return {
      outcome: "bound-already",
      expected,
      actual: info.url,
      pendingUpdateCount: info.pending_update_count,
      ...(info.last_error_message ? { lastErrorMessage: info.last_error_message } : {}),
    };
  }
  // Either url is empty (Telegram dropped it because something called
  // getUpdates) or it points elsewhere (someone re-bound to a different
  // Worker). Rebind to ours.
  const rebind = await rebindWebhook(botToken, expected, secretToken, fetchImpl);
  if (!rebind.ok) {
    return {
      outcome: "failed",
      expected,
      actual: info.url || null,
      reason: "setWebhook returned ok=false",
      ...(rebind.description ? { rebindError: rebind.description } : {}),
    };
  }
  return {
    outcome: "rebound",
    expected,
    actual: info.url || null,
    ...(info.last_error_message ? { lastErrorMessage: info.last_error_message } : {}),
  };
}
