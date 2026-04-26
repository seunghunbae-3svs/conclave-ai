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
  }): Promise<{ messageId: number } | null> {
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
    // v0.11 — read message_id from the body so progress streaming can
    // editMessageText the same message later. Best-effort: any parse
    // failure or shape mismatch returns null and the caller treats the
    // send as fire-and-forget.
    const parsed = (await (resp as unknown as { json: () => Promise<unknown> })
      .json()
      .catch(() => null)) as { ok?: boolean; result?: { message_id?: unknown } } | null;
    const mid = parsed?.result?.message_id;
    return typeof mid === "number" ? { messageId: mid } : null;
  }

  /**
   * v0.11 — edit an existing message's text. Used by the progress
   * streaming path so a single Telegram message accumulates phase
   * lines instead of producing a reply chain.
   *
   * Returns true on 200, throws on transport error. The "message is not
   * modified" 400 (when the new text is identical to the current text)
   * is short-circuited by the caller's lastText cache, so we don't
   * special-case it here.
   */
  async editMessageText(opts: {
    chatId: number;
    messageId: number;
    text: string;
    parseMode?: "HTML" | "MarkdownV2";
  }): Promise<void> {
    const body: Record<string, unknown> = {
      chat_id: opts.chatId,
      message_id: opts.messageId,
      text: opts.text,
      disable_web_page_preview: true,
    };
    if (opts.parseMode) body.parse_mode = opts.parseMode;
    const fetchImpl = this.fetchImpl;
    const resp = await fetchImpl(this.url("editMessageText"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new Error(`telegram editMessageText: HTTP ${resp.status}`);
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
 * v0.8 — callback_data vocabulary.
 *
 *   Legacy (v0.7):   merged / reworked / rejected
 *   v0.8 autonomy:   merge / reject / merge-unsafe / merge-confirmed / cancel
 *
 * Both generations are accepted — v0.7 CLI notifiers still route through
 * the central plane during the transition, so the parser is permissive.
 * `eventTypeFor` maps each action to its GitHub repository_dispatch
 * event_type (some actions have no dispatch; see `isSafeMerge`).
 */
export type CallbackOutcome =
  | "merged"
  | "reworked"
  | "rejected"
  | "merge"
  | "reject"
  | "merge-unsafe"
  | "merge-confirmed"
  | "cancel";

const VALID_OUTCOMES: readonly CallbackOutcome[] = [
  "merged",
  "reworked",
  "rejected",
  "merge",
  "reject",
  "merge-unsafe",
  "merge-confirmed",
  "cancel",
];

/**
 * Parse the `ep:<id>:<outcome>` callback_data format emitted by the
 * integration-telegram notifier AND the v0.8 autonomy renderer. Returns
 * null for unknown outcomes so the webhook replies with "Unknown button"
 * instead of dispatching something unintended.
 */
export function parseCallbackData(
  data: string | undefined | null,
): { episodicId: string; outcome: CallbackOutcome } | null {
  if (!data || !data.startsWith("ep:")) return null;
  const lastColon = data.lastIndexOf(":");
  if (lastColon <= 3) return null;
  const episodicId = data.slice(3, lastColon);
  const outcome = data.slice(lastColon + 1) as CallbackOutcome;
  if (!VALID_OUTCOMES.includes(outcome)) return null;
  if (!episodicId) return null;
  return { episodicId, outcome };
}

/**
 * v0.8 — categorise a parsed outcome into the action the webhook should
 * take:
 *
 *   - "dispatch"      → fire repository_dispatch with eventTypeFor(outcome)
 *                        (legacy verbs + new reject/merge map cleanly)
 *   - "confirm-unsafe"→ reply with a warning keyboard (no dispatch)
 *   - "cancel"        → no-op ack
 */
export function classifyOutcome(outcome: CallbackOutcome):
  | { kind: "dispatch"; eventType: string }
  | { kind: "confirm-unsafe" }
  | { kind: "cancel" } {
  switch (outcome) {
    case "merged":
    case "merge":
    case "merge-confirmed":
      return { kind: "dispatch", eventType: "conclave-merge" };
    case "reworked":
      return { kind: "dispatch", eventType: "conclave-rework" };
    case "rejected":
    case "reject":
      return { kind: "dispatch", eventType: "conclave-reject" };
    case "merge-unsafe":
      return { kind: "confirm-unsafe" };
    case "cancel":
      return { kind: "cancel" };
  }
}

export function eventTypeFor(outcome: CallbackOutcome): string {
  const c = classifyOutcome(outcome);
  if (c.kind !== "dispatch") {
    throw new Error(`eventTypeFor: outcome "${outcome}" does not dispatch`);
  }
  return c.eventType;
}

/**
 * Human-readable label for the follow-up chat message after a button
 * click. Separated from `eventTypeFor` because the workflow event name
 * (`conclave-merge`) and the conversational label ("✅ Merge queued") are
 * different audiences.
 */
export function labelForOutcome(outcome: CallbackOutcome): string {
  switch (outcome) {
    case "merged":
    case "merge":
    case "merge-confirmed":
      return "✅ Merge queued";
    case "reworked":
      return "🔧 Rework requested";
    case "rejected":
    case "reject":
      return "❌ Rejected";
    case "merge-unsafe":
      return "⚠️ Unsafe merge requested";
    case "cancel":
      return "↩️ Cancelled";
  }
}

/**
 * Minimal HTML escaper for Telegram `parse_mode: HTML`. Covers the four
 * special chars Telegram's HTML parser reacts to (`<`, `>`, `&`, `"`).
 * Deliberately local — we don't pull a full HTML-escape dep for a handful
 * of interpolations.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
