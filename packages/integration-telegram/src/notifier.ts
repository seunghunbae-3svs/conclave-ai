import type {
  Notifier,
  NotifyReviewInput,
  NotifyProgressInput,
} from "@conclave-ai/core";
import {
  TelegramClient,
  type HttpFetch,
  type TelegramInlineKeyboard,
  type TelegramMessage,
} from "./client.js";
import { formatReviewForTelegram, formatPlainSummaryForTelegram } from "./format.js";
import { renderProgressLine, renderProgressMessage, type ProgressLine } from "./progress-format.js";

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

  // path B (direct bot) — populated when useCentralPlane is off OR when
  // central-mode also has TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID present
  // (v0.11 — kept around so progress streaming can fall back to the Bot
  // API directly when the central plane returns 404 / 5xx for
  // /review/notify-progress, e.g. the Worker hasn't been re-deployed
  // since the route was added).
  private readonly chatId: number | string | null;
  private readonly client: TelegramClient | null;

  private readonly includeActionButtons: boolean;
  private readonly log: (msg: string) => void;

  /**
   * v0.11 — in-process progress chains. Keyed by (episodicId, pullNumber)
   * so the same review's stage emissions accumulate onto one message.
   * Direct path only — central path persists in D1 because the notifier
   * instance per CLI invocation is short-lived.
   */
  private readonly progressChains = new Map<
    string,
    { messageId: number; lines: ProgressLine[]; lastText: string; chatId: number | string }
  >();

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
      // v0.7.5 fix for Bug B: GitHub Actions emits
      // `CONCLAVE_CENTRAL_URL: ${{ vars.CONCLAVE_CENTRAL_URL || '' }}`,
      // which renders as an EMPTY STRING env when the repo variable is
      // unset. `??` only coalesces null/undefined, so the old code fell
      // through to `centralUrl = ""` — then `notifyReview`'s truthiness
      // check on `this.centralUrl` flipped to direct path and the
      // constructor's direct-branch fields were never populated. Result:
      // "direct path selected but client/chatId not configured" despite
      // the constructor logging a healthy central-path init. Normalise
      // any falsy override (empty string, whitespace-only) to the
      // default URL here so the path decision can never silently flip.
      const rawCentralUrl =
        opts.centralUrl ?? process.env["CONCLAVE_CENTRAL_URL"] ?? "";
      const trimmedCentralUrl = rawCentralUrl.trim();
      this.centralUrl = (
        trimmedCentralUrl.length > 0 ? trimmedCentralUrl : DEFAULT_CENTRAL_URL
      ).replace(/\/$/, "");
      this.centralFetch = opts.fetch ?? null;
      this.repoSlug = opts.repoSlug ?? process.env["GITHUB_REPOSITORY"] ?? "unknown/unknown";
      // v0.11 — opportunistic dual-init: when running in central mode
      // AND the legacy direct-path env creds are also present, build
      // the direct client too so notifyProgress can fall back to it
      // when the central plane's /review/notify-progress route is
      // missing (e.g. consumer Worker hasn't been re-deployed since
      // v0.11). Pre-v0.11 behaviour (direct fields = null in central
      // mode) is preserved when only central creds are set.
      const fbToken = opts.token ?? process.env["TELEGRAM_BOT_TOKEN"] ?? "";
      const fbChatRaw = opts.chatId ?? process.env["TELEGRAM_CHAT_ID"] ?? "";
      if (fbToken && fbChatRaw) {
        this.chatId =
          typeof fbChatRaw === "string" && /^-?\d+$/.test(fbChatRaw)
            ? Number(fbChatRaw)
            : fbChatRaw;
        if (opts.client) {
          this.client = opts.client;
        } else {
          const clientOpts: ConstructorParameters<typeof TelegramClient>[0] = { token: fbToken };
          if (opts.fetch) clientOpts.fetch = opts.fetch;
          if (opts.baseUrl) clientOpts.baseUrl = opts.baseUrl;
          this.client = new TelegramClient(clientOpts);
        }
      } else {
        this.chatId = null;
        this.client = null;
      }
      // Diagnostic log — never logs the actual token value. Length only.
      // Helps consumer-repo operators see at a glance whether their
      // `CONCLAVE_TOKEN` secret actually reached the review step.
      this.log(
        `conclave review: CONCLAVE_TOKEN is set (length: ${conclaveToken.length}) — attempting central plane path (url: ${this.centralUrl}${this.client ? "; direct fallback armed for progress" : ""})`,
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
    // v0.7.5 — explicit, structured logging for the dual-path decision.
    // The pre-fix version silently flipped to direct path when
    // `centralUrl` was falsy (e.g. empty-string env override), producing
    // the confusing "direct path selected but client/chatId not
    // configured" error. Now every fall-through states the reason.
    if (this.centralToken && this.centralUrl) {
      this.log("conclave review: telegram via central plane");
      await this.notifyViaCentral(input);
      return;
    }
    if (this.centralToken && !this.centralUrl) {
      // Defence-in-depth — constructor's fallback should prevent this,
      // but if it ever regresses we want a clear signal instead of the
      // downstream "direct path selected" mystery.
      this.log(
        "conclave review: centralToken set but centralUrl empty — constructor fallback failed; falling through to direct path",
      );
    } else if (this.client && this.chatId !== null) {
      this.log("conclave review: telegram via direct bot token");
    } else {
      this.log(
        "conclave review: telegram — no central path (CONCLAVE_TOKEN absent) and no direct path (TELEGRAM_BOT_TOKEN/CHAT_ID absent); will error",
      );
    }
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
    // Drain body and surface the `delivered` count on stderr — helps
    // operators distinguish "central accepted but nothing was sent"
    // (delivered=0, e.g. no linked chat) from "delivered to N chats".
    // The central plane's contract is `{ ok: boolean, delivered: number,
    // reason?: string }`; we read it best-effort.
    const parsed = (await resp.json().catch(() => null)) as
      | { ok?: unknown; delivered?: unknown; reason?: unknown }
      | null;
    const delivered =
      parsed && typeof parsed.delivered === "number" ? parsed.delivered : null;
    const reason =
      parsed && typeof parsed.reason === "string" ? parsed.reason : null;
    if (delivered !== null) {
      if (delivered === 0) {
        this.log(
          `conclave review: central plane accepted but delivered=0${reason ? ` (reason: ${reason})` : ""} — chat likely not linked. DM the bot with /link ${this.centralToken ? "<YOUR_CONCLAVE_TOKEN>" : "<token>"} to route notifications here.`,
        );
      } else {
        this.log(
          `conclave review: central plane delivered to ${delivered} chat(s)`,
        );
      }
    }
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

  /**
   * v0.11 — emit a progress stage. First call per (episodicId, pullNumber)
   * sends a fresh message; subsequent calls append a line and edit the
   * same message in place. Failures here are logged and swallowed —
   * progress is telemetry, not the verdict, and a 429 / network blip
   * must not break the review flow.
   *
   * Central path: route through `/review/notify-progress` (one-shot
   * stage emission; the central plane owns the message_id persistence).
   *
   * Direct path: keep the chain in-process. Single CLI invocation =
   * single notifier instance = single chain — autofix runs in a separate
   * process and starts its own chain by design.
   */
  async notifyProgress(input: NotifyProgressInput): Promise<void> {
    if (this.centralToken && this.centralUrl) {
      try {
        await this.notifyProgressViaCentral(input);
        return;
      } catch (err) {
        const msg = (err as Error).message;
        // v0.11 — central plane returns HTTP 404 when the Worker
        // hasn't been re-deployed since the /review/notify-progress
        // route landed. Fall back to direct path if it's available;
        // otherwise log + drop. This keeps progress streaming working
        // for users who upgrade their CLI before bouncing the Worker
        // (matches the dual-path flexibility of notifyReview minus the
        // verdict semantics, which DO require central for now).
        const looksLikeMissingRoute =
          /HTTP 404/.test(msg) || /\bnot found\b/i.test(msg);
        if (looksLikeMissingRoute && this.client && this.chatId !== null) {
          this.log(
            `conclave progress: central /review/notify-progress missing — falling back to direct Bot API for this stage (deploy central-plane to remove this fallback)`,
          );
          try {
            await this.notifyProgressViaDirect(input);
          } catch (fbErr) {
            this.log(
              `conclave progress: direct fallback also failed — ${(fbErr as Error).message}`,
            );
          }
          return;
        }
        this.log(`conclave progress: central emit failed — ${msg}`);
      }
      return;
    }
    if (!this.client || this.chatId === null) {
      // No surface to render to. Skip silently — progress is opt-in.
      return;
    }
    try {
      await this.notifyProgressViaDirect(input);
    } catch (err) {
      this.log(`conclave progress: direct emit failed — ${(err as Error).message}`);
    }
  }

  private async notifyProgressViaCentral(input: NotifyProgressInput): Promise<void> {
    const fetchFn: HttpFetch | typeof fetch =
      this.centralFetch ??
      ((...args: Parameters<typeof fetch>) =>
        fetch(...args) as unknown as ReturnType<HttpFetch>);
    const body = {
      repo_slug: input.payload?.repo ?? this.repoSlug,
      episodic_id: input.episodicId,
      stage: input.stage,
      ...(input.payload ? { payload: input.payload } : {}),
    };
    const resp = await (fetchFn as HttpFetch)(`${this.centralUrl}/review/notify-progress`, {
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
        `/review/notify-progress returned HTTP ${resp.status} — ${msg.slice(0, 300)}`,
      );
    }
  }

  private async notifyProgressViaDirect(input: NotifyProgressInput): Promise<void> {
    if (!this.client || this.chatId === null) return;
    const pr = input.payload?.pullNumber;
    const key = `${input.episodicId}::${pr ?? ""}`;
    const line = renderProgressLine(input);
    const existing = this.progressChains.get(key);
    if (!existing) {
      const lines = [line];
      const text = renderProgressMessage(lines, {
        episodicId: input.episodicId,
        ...(input.payload?.repo !== undefined ? { repo: input.payload.repo } : {}),
        ...(typeof pr === "number" ? { pullNumber: pr } : {}),
      });
      const resp = await this.client.sendMessage({
        chat_id: this.chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
      const msg = resp.result;
      const messageId =
        msg && typeof (msg as TelegramMessage).message_id === "number"
          ? (msg as TelegramMessage).message_id
          : null;
      if (messageId === null) {
        // No message_id back — without it we can't edit. Treat as
        // single-shot fire and skip future edits for this chain.
        return;
      }
      this.progressChains.set(key, {
        messageId,
        lines,
        lastText: text,
        chatId: this.chatId,
      });
      return;
    }
    existing.lines.push(line);
    const text = renderProgressMessage(existing.lines, {
      episodicId: input.episodicId,
      ...(input.payload?.repo !== undefined ? { repo: input.payload.repo } : {}),
      ...(typeof pr === "number" ? { pullNumber: pr } : {}),
    });
    if (text === existing.lastText) {
      // Telegram returns 400 "message is not modified" if we edit with
      // identical text. Guard locally so the error doesn't bubble.
      return;
    }
    await this.client.editMessageText({
      chat_id: existing.chatId,
      message_id: existing.messageId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
    existing.lastText = text;
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
