import type { Notifier, NotifyReviewInput } from "@conclave-ai/core";
import { TelegramClient, type HttpFetch, type TelegramInlineKeyboard } from "./client.js";
import { formatReviewForTelegram, formatPlainSummaryForTelegram } from "./format.js";

/**
 * Default Conclave central plane URL. Duplicated from
 * `packages/cli/src/commands/init/central-client.ts` — importing it
 * directly would create a circular workspace dep (cli → integration-
 * telegram → cli). Kept in sync by policy; the two constants MUST
 * match. When the central plane URL changes, update both files in the
 * same PR.
 */
export const DEFAULT_CENTRAL_URL = "https://conclave-ai.seunghunbae.workers.dev";

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
  /**
   * If true, route notifications through the Conclave central plane
   * rather than hitting the Telegram Bot API directly. Ignored if
   * CONCLAVE_TOKEN env is not set. Defaults to automatic: central path
   * on, if and only if CONCLAVE_TOKEN is present in env.
   */
  useCentralPlane?: boolean;
  /**
   * Override central plane base URL (tests). Falls back to
   * CONCLAVE_CENTRAL_URL env then DEFAULT_CENTRAL_URL.
   */
  centralUrl?: string;
  /**
   * Repo slug override. Falls back to GITHUB_REPOSITORY env (set by
   * GitHub Actions automatically). If neither source yields a slug, the
   * notifier still works — the central plane only uses it for logging.
   */
  repoSlug?: string;
  /** Logger for `which path taken` diagnostics. Defaults to stderr. */
  log?: (msg: string) => void;
}

/**
 * TelegramNotifier — posts review outcomes to a Telegram chat.
 *
 * Decision #24: Telegram is an equal-weight integration alongside
 * Discord / Slack / Email / CLI. No "hero" surface. This notifier is
 * intentionally minimal — sendMessage + optional action buttons.
 * Inbound bot command handling (approve via button, /status, etc.) lives
 * in a separate command-surface package if/when added.
 *
 * v0.4.4 — dual-path delivery:
 *
 *   path A (CONCLAVE_TOKEN set, default in v0.4.4+):
 *     POST {CONCLAVE_CENTRAL_URL}/review/notify with bearer auth
 *     → central plane fans out to every linked Telegram chat
 *     → no per-repo TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID needed
 *
 *   path B (self-hosted / v0.3 compat):
 *     direct POST to https://api.telegram.org/bot{token}/sendMessage
 *     → requires TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
 *     → preserved so users on private Conclave deployments keep working
 */
export class TelegramNotifier implements Notifier {
  readonly id = "telegram";
  readonly displayName = "Telegram";

  // path A (central plane) — populated when useCentralPlane is on
  private readonly centralUrl: string | null;
  private readonly centralToken: string | null;
  private readonly centralFetch: HttpFetch | null;
  private readonly repoSlug: string;

  // path B (direct bot) — populated when useCentralPlane is off
  private readonly chatId: number | string | null;
  private readonly client: TelegramClient | null;

  private readonly includeActionButtons: boolean;
  private readonly log: (msg: string) => void;

  constructor(opts: TelegramNotifierOptions = {}) {
    this.includeActionButtons = opts.includeActionButtons ?? true;
    this.log = opts.log ?? ((m) => process.stderr.write(m + "\n"));

    // Decide path. Explicit opts.useCentralPlane overrides env detection.
    //
    // v0.6.3 hardening: trim whitespace before deciding. GitHub Actions
    // sometimes renders secret expansions with a trailing newline when
    // sourced from shell heredocs, and a blank-string CONCLAVE_TOKEN
    // would otherwise trip `length > 0` and then fail auth downstream.
    // Normalising here keeps the decision aligned with what we actually
    // send on the wire.
    const rawConclaveToken = process.env["CONCLAVE_TOKEN"] ?? "";
    const conclaveToken = rawConclaveToken.trim();
    const useCentral =
      opts.useCentralPlane !== undefined ? opts.useCentralPlane : conclaveToken.length > 0;

    if (useCentral) {
      if (!conclaveToken && opts.useCentralPlane === true) {
        throw new Error(
          "TelegramNotifier: useCentralPlane=true but CONCLAVE_TOKEN is not set in env",
        );
      }
      this.centralToken = conclaveToken;
      this.centralUrl = (
        opts.centralUrl ?? process.env["CONCLAVE_CENTRAL_URL"] ?? DEFAULT_CENTRAL_URL
      ).replace(/\/$/, "");
      this.centralFetch = opts.fetch ?? null;
      this.repoSlug = opts.repoSlug ?? process.env["GITHUB_REPOSITORY"] ?? "unknown/unknown";
      this.chatId = null;
      this.client = null;
      // Diagnostic log — never logs the actual token value. Length only.
      // Helps consumer-repo operators see at a glance whether their
      // `CONCLAVE_TOKEN` secret actually reached the review step.
      this.log(
        `conclave review: CONCLAVE_TOKEN is set (length: ${conclaveToken.length}) — attempting central plane path`,
      );
      return;
    }

    // Path B — direct-to-Telegram, original v0.3 behaviour.
    const token = opts.token ?? process.env["TELEGRAM_BOT_TOKEN"] ?? "";
    const chatRaw = opts.chatId ?? process.env["TELEGRAM_CHAT_ID"] ?? "";
    if (!token && !opts.client) {
      throw new Error(
        "TelegramNotifier: TELEGRAM_BOT_TOKEN not set (pass opts.token, opts.client, or env), and CONCLAVE_TOKEN also absent",
      );
    }
    if (!chatRaw) {
      throw new Error(
        "TelegramNotifier: TELEGRAM_CHAT_ID not set (pass opts.chatId or env), and CONCLAVE_TOKEN also absent",
      );
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
    this.centralToken = null;
    this.centralUrl = null;
    this.centralFetch = null;
    this.repoSlug = "";
  }

  async notifyReview(input: NotifyReviewInput): Promise<void> {
    if (this.centralToken && this.centralUrl) {
      this.log("conclave review: telegram via central plane");
      await this.notifyViaCentral(input);
      return;
    }
    this.log("conclave review: telegram via direct bot token");
    await this.notifyViaDirect(input);
  }

  private async notifyViaCentral(input: NotifyReviewInput): Promise<void> {
    // v0.6.1 — when a plain-language summary is attached, it becomes the
    // primary Telegram body (non-dev friendly). The full technical
    // verdict stays on GitHub and is linked via prUrl. Falls back to the
    // original dev-facing formatter when plainSummary is absent.
    const text = input.plainSummary
      ? formatPlainSummaryForTelegram(input)
      : formatReviewForTelegram(input);
    const repoSlug = input.ctx?.repo || this.repoSlug;
    const body: {
      repo_slug: string;
      message: string;
      pr_number?: number;
      verdict?: "approve" | "rework" | "reject";
      episodic_id?: string;
      plain_summary?: {
        whatChanged: string;
        verdictInPlain: string;
        nextAction: string;
        locale: "en" | "ko";
      };
      rework_cycle?: number;
      max_rework_cycles?: number;
      allow_unsafe_merge?: boolean;
      blocker_count?: number;
      pr_url?: string;
    } = {
      repo_slug: repoSlug,
      message: text,
    };
    if (typeof input.ctx?.pullNumber === "number") body.pr_number = input.ctx.pullNumber;
    if (input.outcome?.verdict) body.verdict = input.outcome.verdict;
    if (this.includeActionButtons && input.episodicId) body.episodic_id = input.episodicId;
    if (input.plainSummary) {
      body.plain_summary = {
        whatChanged: input.plainSummary.whatChanged,
        verdictInPlain: input.plainSummary.verdictInPlain,
        nextAction: input.plainSummary.nextAction,
        locale: input.plainSummary.locale,
      };
    }
    // v0.8 — autonomy fields. Only sent when the caller provided them.
    if (typeof input.reworkCycle === "number") body.rework_cycle = input.reworkCycle;
    if (typeof input.maxReworkCycles === "number") body.max_rework_cycles = input.maxReworkCycles;
    if (typeof input.allowUnsafeMerge === "boolean") body.allow_unsafe_merge = input.allowUnsafeMerge;
    if (typeof input.blockerCount === "number") body.blocker_count = input.blockerCount;
    if (input.prUrl) body.pr_url = input.prUrl;

    const fetchFn: HttpFetch | typeof fetch =
      this.centralFetch ??
      ((...args: Parameters<typeof fetch>) =>
        fetch(...args) as unknown as ReturnType<HttpFetch>);

    const resp = await (fetchFn as HttpFetch)(`${this.centralUrl}/review/notify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.centralToken ?? ""}`,
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const msg = await resp.text().catch(() => "");
      throw new Error(
        `TelegramNotifier (central): /review/notify returned HTTP ${resp.status} — ${msg.slice(0, 300)}`,
      );
    }
    // Drain body so sockets close promptly. Do not parse strictly — the
    // central plane contract is `{ ok: true, delivered: number }` but we
    // don't gate on it from the CLI side.
    await resp.json().catch(() => null);
  }

  private async notifyViaDirect(input: NotifyReviewInput): Promise<void> {
    if (!this.client || this.chatId === null) {
      throw new Error("TelegramNotifier: direct path selected but client/chatId not configured");
    }
    const text = input.plainSummary
      ? formatPlainSummaryForTelegram(input)
      : formatReviewForTelegram(input);
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
