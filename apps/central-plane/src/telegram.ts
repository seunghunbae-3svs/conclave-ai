import type { FetchLike } from "./github.js";

/**
 * Minimal Telegram Bot API client for the central @conclave_ai bot.
 * Tests inject fetch; production uses globalThis.fetch.
 */
export class TelegramClient {
  private readonly token: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: { token: string; fetch?: FetchLike }) {
    if (!opts.token) throw new Error("TelegramClient: token required");
    this.token = opts.token;
    // v0.7.2 fix: native `fetch` on Cloudflare Workers throws
    // "Illegal invocation: function called with incorrect `this` reference"
    // when called as `this.fetchImpl(...)` — the Workers runtime requires
    // `this` === globalThis for platform-native methods. Storing the
    // global directly (without binding) on an instance field and then
    // invoking `this.fetchImpl(url, init)` sets `this` to the instance.
    // Bind the default fall-through to globalThis; leave injected
    // fetchImpls (tests) as-is since those are plain functions.
    this.fetchImpl = opts.fetch ?? fetch.bind(globalThis);
  }

  private url(method: string): string {
    return `https://api.telegram.org/bot${this.token}/${method}`;
  }

  async sendMessage(opts: {
    chatId: number;
    text: string;
    parseMode?: "HTML" | "MarkdownV2";
    replyToMessageId?: number;
    replyMarkup?: {
      inline_keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>>;
    };
  }): Promise<void> {
    const body: Record<string, unknown> = {
      chat_id: opts.chatId,
      text: opts.text,
      disable_web_page_preview: true,
    };
    if (opts.parseMode) body.parse_mode = opts.parseMode;
    if (opts.replyToMessageId) body.reply_to_message_id = opts.replyToMessageId;
    if (opts.replyMarkup) body.reply_markup = opts.replyMarkup;
    // Use a local binding (not `this.fetchImpl(...)`) so `this` is
    // undefined at call time — avoids the Workers "Illegal invocation"
    // error even if the caller passes an unbound native fetch.
    const fetchImpl = this.fetchImpl;
    const resp = await fetchImpl(this.url("sendMessage"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new Error(`telegram sendMessage: HTTP ${resp.status}`);
    }
  }

  async answerCallbackQuery(opts: { id: string; text?: string; showAlert?: boolean }): Promise<void> {
    const body: Record<string, unknown> = { callback_query_id: opts.id };
    if (opts.text !== undefined) body.text = opts.text;
    if (opts.showAlert !== undefined) body.show_alert = opts.showAlert;
    const fetchImpl = this.fetchImpl;
    const resp = await fetchImpl(this.url("answerCallbackQuery"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new Error(`telegram answerCallbackQuery: HTTP ${resp.status}`);
    }
  }
}

/**
 * Fire repository_dispatch on behalf of an install, using its stored GitHub
 * access token. Event types mirror what the bot-runner package sent in v0.3:
 *   conclave-rework / conclave-merge / conclave-reject
 */
export async function dispatchRepositoryEvent(
  fetchImpl: FetchLike,
  repoSlug: string,
  githubAccessToken: string,
  eventType: string,
  clientPayload: Record<string, unknown>,
): Promise<void> {
  const resp = await fetchImpl(`https://api.github.com/repos/${repoSlug}/dispatches`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${githubAccessToken}`,
      "content-type": "application/json",
      "user-agent": "conclave-ai-central-plane",
    },
    body: JSON.stringify({ event_type: eventType, client_payload: clientPayload }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`github repository_dispatch: HTTP ${resp.status} ${text.slice(0, 200)}`);
  }
}

/**
 * Parse the `ep:<id>:<outcome>` callback_data format emitted by the
 * integration-telegram notifier. Mirrors bot-runner's parser — but lives
 * here because the central bot IS the equivalent of that runner, not a
 * consumer of it.
 */
export function parseCallbackData(
  data: string | undefined | null,
): { episodicId: string; outcome: "merged" | "reworked" | "rejected" } | null {
  if (!data || !data.startsWith("ep:")) return null;
  const lastColon = data.lastIndexOf(":");
  if (lastColon <= 3) return null;
  const episodicId = data.slice(3, lastColon);
  const outcome = data.slice(lastColon + 1);
  if (outcome !== "merged" && outcome !== "reworked" && outcome !== "rejected") return null;
  if (!episodicId) return null;
  return { episodicId, outcome };
}

export function eventTypeFor(outcome: "merged" | "reworked" | "rejected"): string {
  switch (outcome) {
    case "merged":
      return "conclave-merge";
    case "reworked":
      return "conclave-rework";
    case "rejected":
      return "conclave-reject";
  }
}
