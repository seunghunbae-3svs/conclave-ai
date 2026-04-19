export type Outcome = "merged" | "reworked" | "rejected";

export interface BotCallback {
  episodicId: string;
  outcome: Outcome;
  callbackQueryId: string;
  updateId: number;
  chatId?: number;
  messageId?: number;
  user?: string;
}

export interface DispatchedAction {
  eventType: string;
  repo: string;
  clientPayload: Record<string, unknown>;
  callback: BotCallback;
}

export interface FetchResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}

export type FetchLike = (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => Promise<FetchResponse>;

export interface GhResult {
  stdout: string;
  stderr?: string;
}

export type GhLike = (bin: string, args: readonly string[], opts?: { timeout?: number; input?: string }) => Promise<GhResult>;

export interface RunBotOnceOptions {
  /** Telegram bot token (required). */
  botToken: string;
  /** Target repo in "owner/name" form — the repo that will receive the repository_dispatch events. */
  repo: string;
  /** Last-seen update_id + 1. If omitted, Telegram returns all pending updates since the bot was last polled. */
  offset?: number;
  /** Long-poll timeout in seconds. Default 25. Telegram max 50. Set 0 for a pure non-blocking poll in tests. */
  pollTimeoutSec?: number;
  /** Injected fetch — defaults to globalThis.fetch. */
  fetch?: FetchLike;
  /** Injected gh CLI runner — defaults to spawning `gh` via execFile. */
  gh?: GhLike;
  /**
   * If true (default) the bot calls Telegram's answerCallbackQuery to clear
   * the button's loading spinner after dispatching. Set false in dry-run
   * / tests where you don't want to touch Telegram.
   */
  ackCallbacks?: boolean;
  /** Allow-list — only these outcomes are dispatched. Defaults to all three. */
  allowOutcomes?: readonly Outcome[];
  /** Map outcome → GH Actions event_type. Defaults: merged→conclave-merge, reworked→conclave-rework, rejected→conclave-reject. */
  eventTypeFor?: (outcome: Outcome) => string;
}

export interface RunBotOnceResult {
  /** Every callback we parsed (including ones we skipped due to allow-list). */
  parsed: BotCallback[];
  /** Actions that were successfully dispatched. */
  dispatched: DispatchedAction[];
  errors: Array<{ updateId: number; message: string }>;
  /** New offset to persist. Undefined = caller should keep the current offset (we saw nothing actionable). */
  nextOffset?: number;
}
