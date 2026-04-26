import { Hono } from "hono";
import type { Env } from "../env.js";
import { requireInstallAuth, type AuthedVariables } from "../auth.js";
import { resolveWebhookUrl, checkWebhookBound } from "../webhook-heal.js";

/**
 * v0.13.11 — admin/diagnostic routes.
 *
 * These endpoints surface internal state for `conclave doctor` and any
 * future tooling that wants to assert health from outside the worker.
 * Auth is the same `requireInstallAuth` middleware used by the rest of
 * the central plane: the caller supplies a `CONCLAVE_TOKEN` (the same
 * one their CLI / workflow uses) as Bearer, and we look up the install
 * row to confirm it's a known caller.
 *
 * No bot-token leakage: GET /admin/webhook-status returns the
 * registered URL (already public on Telegram's side) and a
 * computed-expected URL — never the bot token itself.
 */

export function createAdminRoutes(
  fetchImpl: typeof fetch = fetch.bind(globalThis),
): Hono<{ Bindings: Env; Variables: AuthedVariables }> {
  const app = new Hono<{ Bindings: Env; Variables: AuthedVariables }>();

  app.get("/admin/webhook-status", requireInstallAuth, async (c) => {
    const env = c.env;
    if (!env.TELEGRAM_BOT_TOKEN) {
      // Worker has no bot token configured — the webhook can't be
      // checked from here. Surface this as a 200 with a clear
      // outcome so the doctor renders a useful WARN line instead of
      // a confusing 5xx.
      return c.json({
        ok: false,
        outcome: "no-bot-token",
        url: null,
        expected: resolveWebhookUrl(env),
        matches: false,
      });
    }
    const expected = resolveWebhookUrl(env);
    const info = await checkWebhookBound(env.TELEGRAM_BOT_TOKEN, fetchImpl);
    if (!info) {
      return c.json({
        ok: false,
        outcome: "telegram-unreachable",
        url: null,
        expected,
        matches: false,
      });
    }
    const matches = info.url === expected;
    return c.json({
      ok: true,
      outcome: matches ? "bound" : info.url === "" ? "dropped" : "wrong-url",
      url: info.url,
      expected,
      matches,
      pendingUpdateCount: info.pending_update_count,
      lastErrorMessage: info.last_error_message ?? null,
    });
  });

  return app;
}
