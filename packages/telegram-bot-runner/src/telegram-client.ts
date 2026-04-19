import type { FetchLike } from "./types.js";

/**
 * Minimal Telegram Bot API client. Intentionally narrower than a general
 * wrapper — only the two endpoints this package actually needs. Keeping
 * it small means no runtime deps and no SDK churn.
 */
export class TelegramClient {
  private readonly token: string;
  private readonly fetch: FetchLike;

  constructor(opts: { token: string; fetch?: FetchLike }) {
    if (!opts.token) throw new Error("TelegramClient: token is required");
    this.token = opts.token;
    const fallback = (globalThis as unknown as { fetch?: FetchLike }).fetch;
    const f = opts.fetch ?? fallback;
    if (!f) throw new Error("TelegramClient: no fetch implementation available (Node 18+ required, or pass opts.fetch)");
    this.fetch = f;
  }

  async getUpdates(opts: { offset?: number; timeoutSec?: number }): Promise<unknown[]> {
    const params = new URLSearchParams();
    if (opts.offset !== undefined) params.set("offset", String(opts.offset));
    const timeoutSec = opts.timeoutSec ?? 25;
    params.set("timeout", String(timeoutSec));
    // Narrow what we listen for so we don't rack up updates we don't act on.
    params.set("allowed_updates", JSON.stringify(["callback_query"]));
    const url = `https://api.telegram.org/bot${this.token}/getUpdates?${params.toString()}`;

    // Client-side abort timeout set to server long-poll + 10s buffer. Without
    // this, a hung TCP connection or dropped Telegram response leaves the
    // caller spinning until the workflow itself is cancelled — and the
    // cancellation race is what silently loses Bae's clicks (the server
    // records the updates as delivered on its side, but we never write the
    // offset locally, so the next poll returns an empty queue). Forcing a
    // deterministic timeout means we always get EITHER a response (and
    // advance offset atomically) OR a thrown error (and leave offset alone
    // so the next cron tick re-requests from the same position).
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), (timeoutSec + 10) * 1000);
    try {
      const resp = await this.fetch(url, { method: "GET", signal: controller.signal });
      if (!resp.ok) throw new Error(`telegram getUpdates: HTTP ${resp.status} — ${await safeText(resp)}`);
      const body = (await resp.json()) as { ok?: boolean; result?: unknown[]; description?: string };
      if (!body.ok) throw new Error(`telegram getUpdates: ${body.description ?? "not ok"}`);
      return body.result ?? [];
    } catch (err) {
      // Wrap abort errors with a message the operator can actually act on.
      if (err instanceof Error && (err.name === "AbortError" || err.message.toLowerCase().includes("abort"))) {
        throw new Error(
          `telegram getUpdates: aborted after ${timeoutSec + 10}s without response (Telegram long-poll hang — retry on next tick)`,
        );
      }
      throw err;
    } finally {
      clearTimeout(abortTimer);
    }
  }

  async answerCallbackQuery(opts: { id: string; text?: string; showAlert?: boolean }): Promise<void> {
    const url = `https://api.telegram.org/bot${this.token}/answerCallbackQuery`;
    const body: Record<string, unknown> = { callback_query_id: opts.id };
    if (opts.text !== undefined) body.text = opts.text;
    if (opts.showAlert !== undefined) body.show_alert = opts.showAlert;

    // 10s is already generous for a tiny POST to Telegram. Anything longer
    // is a network pathology we'd rather surface than swallow.
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 10_000);
    try {
      const resp = await this.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!resp.ok) throw new Error(`telegram answerCallbackQuery: HTTP ${resp.status} — ${await safeText(resp)}`);
    } finally {
      clearTimeout(abortTimer);
    }
  }
}

async function safeText(resp: { text: () => Promise<string> }): Promise<string> {
  try {
    return (await resp.text()).slice(0, 500);
  } catch {
    return "<no body>";
  }
}
