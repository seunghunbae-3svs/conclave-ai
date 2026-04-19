export interface TelegramSendMessageParams {
  chat_id: number | string;
  text: string;
  parse_mode?: "HTML" | "MarkdownV2";
  disable_web_page_preview?: boolean;
  reply_markup?: TelegramInlineKeyboard;
}

export interface TelegramInlineKeyboard {
  inline_keyboard: TelegramInlineKeyboardButton[][];
}

export interface TelegramInlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

export interface HttpFetch {
  (url: string, init: { method: string; headers: Record<string, string>; body: string }): Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
    text: () => Promise<string>;
  }>;
}

/**
 * Thin Telegram Bot API wrapper. Uses native fetch (Node 20+) by default;
 * accepts an injected `HttpFetch` for tests.
 *
 * Intentionally limited to the methods the notifier needs — any expansion
 * stays under ~200 lines to keep dep surface thin. Full bot command-loop
 * + webhook listener lives in a separate package if/when Bae wants it.
 */
export class TelegramClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchFn: HttpFetch;

  constructor(opts: { token: string; baseUrl?: string; fetch?: HttpFetch }) {
    if (!opts.token) throw new Error("TelegramClient: token is required");
    this.token = opts.token;
    this.baseUrl = opts.baseUrl ?? "https://api.telegram.org";
    this.fetchFn = opts.fetch ?? ((...args) => fetch(...(args as Parameters<typeof fetch>)) as ReturnType<HttpFetch>);
  }

  async sendMessage(params: TelegramSendMessageParams): Promise<TelegramResponse<unknown>> {
    return this.call("sendMessage", params);
  }

  private async call<T>(method: string, body: unknown): Promise<TelegramResponse<T>> {
    const url = `${this.baseUrl}/bot${this.token}/${method}`;
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    let data: TelegramResponse<T>;
    try {
      data = (await res.json()) as TelegramResponse<T>;
    } catch {
      const text = await res.text();
      throw new Error(`TelegramClient: ${method} returned non-JSON (status ${res.status}): ${text.slice(0, 200)}`);
    }
    if (!data.ok) {
      throw new Error(
        `TelegramClient: ${method} failed — ${data.description ?? "no description"} (code ${data.error_code ?? "?"})`,
      );
    }
    return data;
  }
}
