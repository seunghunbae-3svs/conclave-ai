import { Hono } from "hono";
import type { Env } from "../env.js";
import { requireInstallAuth, type AuthedVariables } from "../auth.js";
import { resolveWebhookUrl, checkWebhookBound, rebindWebhook } from "../webhook-heal.js";
import { TelegramClient } from "../telegram.js";
import { readMonthlySpend } from "../db/installs.js";

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
    // v0.13.16 — also call getMe so the diagnostic surfaces WHICH bot
    // the worker is actually using. Live RC: PR #32 — operator
    // expected @BAE_DUAL_bot but the worker's TELEGRAM_BOT_TOKEN
    // pointed at @Conclave_AI; without bot identity in the diagnostic
    // we can't tell from outside.
    const [info, me] = await Promise.all([
      checkWebhookBound(env.TELEGRAM_BOT_TOKEN, fetchImpl),
      fetchImpl(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`)
        .then(async (r) => {
          if (!r.ok) return null;
          const j = (await r.json().catch(() => null)) as {
            ok?: boolean;
            result?: { id?: number; username?: string; first_name?: string };
          } | null;
          if (!j?.ok || !j.result) return null;
          return j.result;
        })
        .catch(() => null),
    ]);
    if (!info) {
      return c.json({
        ok: false,
        outcome: "telegram-unreachable",
        url: null,
        expected,
        matches: false,
        bot: me ? { id: me.id, username: me.username, firstName: me.first_name } : null,
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
      lastErrorDate: info.last_error_date ?? null,
      lastSynchronizationErrorDate: info.last_synchronization_error_date ?? null,
      bot: me ? { id: me.id, username: me.username, firstName: me.first_name } : null,
    });
  });

  // v0.13.17 — POST /merge/notify: final merge-outcome notification
  // path. Called by the consumer's conclave-merge / conclave-reject
  // workflow after the underlying `gh pr merge` (or close) lands.
  // Sends a "✅ Merged" / "❌ Rejected" / "🔧 Reworked" message into
  // every linked Telegram chat for the install. No keyboard — this
  // is a terminal status update, not an actionable button.
  //
  // Live RC: PR #32 — autonomy loop closed (REWORK→autofix→APPROVE→
  // ✅ Merge & Push click→GitHub merge succeeded), but Bae never saw
  // the FINAL "Merged" confirmation in @Conclave_AI DM, only the
  // intermediate "Merge queued" toast/follow-up. The merge workflow
  // had no notify step. Now it does.
  app.post("/merge/notify", requireInstallAuth, async (c) => {
    const env = c.env;
    if (!env.TELEGRAM_BOT_TOKEN) {
      return c.json({ ok: false, error: "TELEGRAM_BOT_TOKEN unset on worker" }, 500);
    }
    const installId = c.get("installId");
    const installRepo = c.get("installRepo");
    const body = (await c.req.json().catch(() => null)) as {
      episodic_id?: string;
      pr_number?: number;
      outcome?: "merged" | "rejected" | "reworked";
      pr_url?: string;
      details?: string;
    } | null;
    if (!body || !body.outcome) {
      return c.json({ ok: false, error: "outcome (merged/rejected/reworked) required" }, 400);
    }
    const outcome = body.outcome;
    const prNumber = body.pr_number;
    const prUrl = body.pr_url;
    // Look up linked chats for this install.
    const rows = await env.DB
      .prepare("SELECT chat_id FROM telegram_links WHERE install_id = ?")
      .bind(installId)
      .all<{ chat_id: number }>();
    const chatIds = (rows.results ?? []).map((r) => r.chat_id);
    if (chatIds.length === 0) {
      return c.json({ ok: true, delivered: 0, reason: "no_linked_chat" });
    }
    const headlineByOutcome: Record<typeof outcome, string> = {
      merged: "✅ <b>Merged</b>",
      rejected: "❌ <b>Closed</b>",
      reworked: "🔧 <b>Reworked</b>",
    } as const;
    const text = [
      headlineByOutcome[outcome],
      "",
      prNumber
        ? `PR #${prNumber} on <b>${installRepo}</b>`
        : `On <b>${installRepo}</b>`,
      ...(prUrl ? ["", `<a href="${prUrl}">View on GitHub</a>`] : []),
      ...(body.details ? ["", `<i>${body.details}</i>`] : []),
    ].join("\n");
    const client = new TelegramClient({
      token: env.TELEGRAM_BOT_TOKEN,
      fetch: fetchImpl,
    });
    let delivered = 0;
    const errors: string[] = [];
    for (const chatId of chatIds) {
      try {
        await client.sendMessage({ chatId, text, parseMode: "HTML" });
        delivered += 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`chat ${chatId}: ${msg}`);
        console.warn(`merge/notify sendMessage to chat ${chatId} failed:`, msg);
      }
    }
    return c.json({ ok: true, delivered, ...(errors.length ? { errors } : {}) });
  });

  // v0.13.16 — GET /admin/install-summary (H1 #2): one-call diagnostic
  // for `conclave status`. Replaces the 4-hour PR #32 debug session
  // ("did the click register? is the bot the right bot? is the chat
  // linked? what's our spend?") with a single JSON response.
  app.get("/admin/install-summary", requireInstallAuth, async (c) => {
    const env = c.env;
    const installId = c.get("installId");
    const installRepo = c.get("installRepo");

    // Bot identity + webhook health (parity with /admin/webhook-status,
    // but here we report it as part of the per-install summary).
    let botInfo: { id: number; username?: string; firstName?: string } | null = null;
    let webhookOutcome: "bound" | "dropped" | "wrong-url" | "no-bot-token" | "telegram-unreachable" = "no-bot-token";
    let webhookExpected: string | null = null;
    let webhookActual: string | null = null;
    let pendingUpdates = 0;
    let lastErrorMessage: string | null = null;
    let lastErrorDate: number | null = null;
    if (env.TELEGRAM_BOT_TOKEN) {
      webhookExpected = resolveWebhookUrl(env);
      const [info, me] = await Promise.all([
        checkWebhookBound(env.TELEGRAM_BOT_TOKEN, fetchImpl),
        fetchImpl(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`)
          .then(async (r) => {
            if (!r.ok) return null;
            const j = (await r.json().catch(() => null)) as {
              ok?: boolean;
              result?: { id?: number; username?: string; first_name?: string };
            } | null;
            if (!j?.ok || !j.result) return null;
            return j.result;
          })
          .catch(() => null),
      ]);
      if (me) {
        botInfo = { id: me.id ?? 0, username: me.username, firstName: me.first_name };
      }
      if (info) {
        webhookActual = info.url;
        pendingUpdates = info.pending_update_count;
        lastErrorMessage = info.last_error_message ?? null;
        lastErrorDate = info.last_error_date ?? null;
        webhookOutcome = info.url === webhookExpected
          ? "bound"
          : info.url === ""
          ? "dropped"
          : "wrong-url";
      } else {
        webhookOutcome = "telegram-unreachable";
      }
    }

    // Telegram-link count for this install.
    const linkRows = await env.DB
      .prepare("SELECT COUNT(*) AS n FROM telegram_links WHERE install_id = ?")
      .bind(installId)
      .first<{ n: number }>();
    const linkedChats = linkRows?.n ?? 0;

    // Recent cycle outcomes — last 5 review_notify_dedupe rows for
    // this install (each row is a verdict notification, so it's the
    // closest proxy to "what reviews has this install seen lately").
    let recentCycles: Array<{ pr: number; episodic: string; at: string }> = [];
    try {
      const rows = await env.DB
        .prepare(
          `SELECT pr_number, episodic_id, notified_at
           FROM review_notify_dedupe
           WHERE install_id = ?
           ORDER BY notified_at DESC
           LIMIT 5`,
        )
        .bind(installId)
        .all<{ pr_number: number; episodic_id: string; notified_at: string }>();
      recentCycles = (rows.results ?? []).map((r) => ({
        pr: r.pr_number,
        episodic: r.episodic_id,
        at: r.notified_at,
      }));
    } catch {
      // review_notify_dedupe is non-fatal — pre-v0.7.5 installs may
      // not have the table populated yet.
    }

    // v0.13.20 (H1 #5) — surface monthly spend so `conclave status`
    // and any future dashboard can show "this install has spent $X
    // of $Y this month".
    const spend = await readMonthlySpend(env, installId);

    return c.json({
      ok: true,
      install: {
        id: installId,
        repo: installRepo,
      },
      bot: botInfo,
      webhook: {
        outcome: webhookOutcome,
        expected: webhookExpected,
        actual: webhookActual,
        pendingUpdates,
        lastErrorMessage,
        lastErrorDate,
      },
      linkedChats,
      recentCycles,
      monthlySpend: spend
        ? { usd: spend.usd, capUsd: spend.capUsd, periodStart: spend.periodStart }
        : null,
    });
  });

  // v0.13.22 — POST /dev-loop/notify: free-text Telegram dispatch for
  // the autonomous dev-loop GitHub Action. Same auth + chat-lookup
  // pattern as /merge/notify but accepts a generic text body so the
  // orchestrator can post run-start, ship-success, failure, freeze,
  // and roadmap-complete events without each one being a custom route.
  //
  // Live use: scripts/dev-loop/run-next.mjs calls this with the
  // CONCLAVE_TOKEN already wired into review/merge/rework.yml — no new
  // secret to register.
  app.post("/dev-loop/notify", requireInstallAuth, async (c) => {
    const env = c.env;
    if (!env.TELEGRAM_BOT_TOKEN) {
      return c.json({ ok: false, error: "TELEGRAM_BOT_TOKEN unset on worker" }, 500);
    }
    const installId = c.get("installId");
    const body = (await c.req.json().catch(() => null)) as {
      event?: string;
      text?: string;
    } | null;
    if (!body || !body.text) {
      return c.json({ ok: false, error: "text required" }, 400);
    }
    const rows = await env.DB
      .prepare("SELECT chat_id FROM telegram_links WHERE install_id = ?")
      .bind(installId)
      .all<{ chat_id: number }>();
    const chatIds = (rows.results ?? []).map((r) => r.chat_id);
    if (chatIds.length === 0) {
      return c.json({ ok: true, delivered: 0, reason: "no_linked_chat" });
    }
    const client = new TelegramClient({
      token: env.TELEGRAM_BOT_TOKEN,
      fetch: fetchImpl,
    });
    let delivered = 0;
    const errors: string[] = [];
    for (const chatId of chatIds) {
      try {
        await client.sendMessage({ chatId, text: body.text });
        delivered += 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`chat ${chatId}: ${msg}`);
        console.warn(`dev-loop/notify sendMessage to chat ${chatId} failed:`, msg);
      }
    }
    return c.json({ ok: true, delivered, ...(errors.length ? { errors } : {}) });
  });

  // v0.13.16 — POST /admin/rebind-webhook: force setWebhook with the
  // current TELEGRAM_WEBHOOK_SECRET, regardless of whether the URL
  // already matches. Use this when the cron's automatic re-bind
  // detection isn't enough (e.g., right after a secret rotation, or
  // when the operator wants an immediate sync).
  app.post("/admin/rebind-webhook", requireInstallAuth, async (c) => {
    const env = c.env;
    if (!env.TELEGRAM_BOT_TOKEN) {
      return c.json({ ok: false, outcome: "no-bot-token" });
    }
    if (!env.TELEGRAM_WEBHOOK_SECRET) {
      return c.json({ ok: false, outcome: "no-webhook-secret" });
    }
    const expected = resolveWebhookUrl(env);
    const before = await checkWebhookBound(env.TELEGRAM_BOT_TOKEN, fetchImpl);
    const result = await rebindWebhook(
      env.TELEGRAM_BOT_TOKEN,
      expected,
      env.TELEGRAM_WEBHOOK_SECRET,
      fetchImpl,
    );
    return c.json({
      ok: result.ok,
      outcome: result.ok ? "rebound" : "failed",
      expected,
      previousUrl: before?.url ?? null,
      previousLastError: before?.last_error_message ?? null,
      description: result.description ?? null,
    });
  });

  return app;
}
