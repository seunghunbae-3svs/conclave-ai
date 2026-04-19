import type { Notifier, NotifyReviewInput } from "@ai-conclave/core";
import { TelegramClient, type HttpFetch, type TelegramInlineKeyboard } from "./client.js";
import { formatReviewForTelegram } from "./format.js";

export interface TelegramNotifierOptions {
  /** Bot token from BotFather. If omitted, read from TELEGRAM_BOT_TOKEN env. */
  token?: string;
  /** Chat id (user or group). If omitted, read from TELEGRAM_CHAT_ID env. */
  chatId?: number | string;
  /** Pre-built client (tests). */
  client?: TelegramClient;
  /** Inject fetch for tests. */
  fetch?: HttpFetch;
  /** Base URL override (tests or self-hosted bot API). */
  baseUrl?: string;
  /** If true, attaches inline buttons (approve/reject/rework) to the message. Default true. */
  includeActionButtons?: boolean;
}

/**
 * TelegramNotifier — posts review outcomes to a Telegram chat.
 *
 * Decision #24: Telegram is an equal-weight integration alongside
 * Discord / Slack / Email / CLI. No "hero" surface. This notifier is
 * intentionally minimal — sendMessage + optional action buttons.
 * Inbound bot command handling (approve via button, /status, etc.) lives
 * in a separate command-surface package if/when added.
 */
export class TelegramNotifier implements Notifier {
  readonly id = "telegram";
  readonly displayName = "Telegram";

  private readonly chatId: number | string;
  private readonly client: TelegramClient;
  private readonly includeActionButtons: boolean;

  constructor(opts: TelegramNotifierOptions = {}) {
    const token = opts.token ?? process.env["TELEGRAM_BOT_TOKEN"] ?? "";
    const chatRaw = opts.chatId ?? process.env["TELEGRAM_CHAT_ID"] ?? "";
    if (!token && !opts.client) {
      throw new Error("TelegramNotifier: TELEGRAM_BOT_TOKEN not set (pass opts.token, opts.client, or env)");
    }
    if (!chatRaw) {
      throw new Error("TelegramNotifier: TELEGRAM_CHAT_ID not set (pass opts.chatId or env)");
    }
    this.chatId = typeof chatRaw === "string" && /^-?\d+$/.test(chatRaw) ? Number(chatRaw) : chatRaw;
    if (opts.client) {
      this.client = opts.client;
    } else {
      const clientOpts: ConstructorParameters<typeof TelegramClient>[0] = { token };
      if (opts.fetch) clientOpts.fetch = opts.fetch;
      if (opts.baseUrl) clientOpts.baseUrl = opts.baseUrl;
      this.client = new TelegramClient(clientOpts);
    }
    this.includeActionButtons = opts.includeActionButtons ?? true;
  }

  async notifyReview(input: NotifyReviewInput): Promise<void> {
    const text = formatReviewForTelegram(input);
    const sendParams: Parameters<TelegramClient["sendMessage"]>[0] = {
      chat_id: this.chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    };
    if (this.includeActionButtons) {
      sendParams.reply_markup = buildActionKeyboard(input);
    }
    await this.client.sendMessage(sendParams);
  }
}

function buildActionKeyboard(input: NotifyReviewInput): TelegramInlineKeyboard {
  // callback_data is constrained to 64 bytes by Telegram — keep it compact.
  const id = input.episodicId;
  const row = [
    { text: "✅ Approve", callback_data: `ep:${id}:merged` },
    { text: "🔧 Rework", callback_data: `ep:${id}:reworked` },
    { text: "❌ Reject", callback_data: `ep:${id}:rejected` },
  ];
  // If the button callback_data is too long, drop it. Episodic ids are
  // ~40 chars so `ep:${id}:merged` ≈ 50 chars — within 64-byte limit.
  return { inline_keyboard: [row] };
}
