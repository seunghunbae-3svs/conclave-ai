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
    params.set("timeout", String(opts.timeoutSec ?? 25));
    // Narrow what we listen for so we don't rack up updates we don't act on.
    params.set("allowed_updates", JSON.stringify(["callback_query"]));
    const url = `https://api.telegram.org/bot${this.token}/getUpdates?${params.toString()}`;
    const resp = await this.fetch(url, { method: "GET" });
    if (!resp.ok) throw new Error(`telegram getUpdates: HTTP ${resp.status} — ${await safeText(resp)}`);
    const body = (await resp.json()) as { ok?: boolean; result?: unknown[]; description?: string };
    if (!body.ok) throw new Error(`telegram getUpdates: ${body.description ?? "not ok"}`);
    return body.result ?? [];
  }

  async answerCallbackQuery(opts: { id: string; text?: string; showAlert?: boolean }): Promise<void> {
    const url = `https://api.telegram.org/bot${this.token}/answerCallbackQuery`;
    const body: Record<string, unknown> = { callback_query_id: opts.id };
    if (opts.text !== undefined) body.text = opts.text;
    if (opts.showAlert !== undefined) body.show_alert = opts.showAlert;
    const resp = await this.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`telegram answerCallbackQuery: HTTP ${resp.status} — ${await safeText(resp)}`);
  }
}

async function safeText(resp: { text: () => Promise<string> }): Promise<string> {
  try {
    return (await resp.text()).slice(0, 500);
  } catch {
    return "<no body>";
  }
}
