import type { Notifier } from "@conclave-ai/core";
import { TelegramNotifier } from "@conclave-ai/integration-telegram";
import { DiscordNotifier } from "@conclave-ai/integration-discord";
import { SlackNotifier } from "@conclave-ai/integration-slack";
import { EmailNotifier } from "@conclave-ai/integration-email";
import type { ConclaveConfig } from "./config.js";

/**
 * v0.11 — extracted from `commands/review.ts` so the same factory can
 * build the notifier set for `review` and (eventually) `audit` /
 * `autofix` without duplicating the env-detection + opt-out logic.
 *
 * Behaviour preserved verbatim from the inline v0.10.0 code:
 *   - Telegram: prefers central path when CONCLAVE_TOKEN is set, falls
 *     back to direct path when TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
 *     are present.
 *   - Discord / Slack / Email: enabled when their respective config or
 *     env credential is present.
 *   - All construction failures are logged to stderr and SWALLOWED —
 *     a broken integration must never kill a review.
 *
 * The earlier the factory runs, the earlier `notifyProgress` (v0.11)
 * can fire — review.ts now constructs notifiers BEFORE deliberation
 * (was: after) so visual-capture-started fires inline with the actual
 * capture phase.
 */
export function buildNotifiers(config: ConclaveConfig): Notifier[] {
  const notifiers: Notifier[] = [];
  const tg = config.integrations?.telegram;
  if (tg?.enabled !== false) {
    const hasConclaveToken = (process.env["CONCLAVE_TOKEN"] ?? "").trim().length > 0;
    const hasToken = !!process.env["TELEGRAM_BOT_TOKEN"];
    const hasChat = tg?.chatId !== undefined || !!process.env["TELEGRAM_CHAT_ID"];
    if (hasConclaveToken) {
      const opts: ConstructorParameters<typeof TelegramNotifier>[0] = {};
      if (tg?.includeActionButtons !== undefined) opts.includeActionButtons = tg.includeActionButtons;
      try {
        notifiers.push(new TelegramNotifier(opts));
      } catch (err) {
        process.stderr.write(
          `conclave review: Telegram notifier (central) init failed — ${(err as Error).message}\n`,
        );
      }
    } else if (tg?.enabled === true && !hasToken) {
      process.stderr.write(
        "conclave review: neither CONCLAVE_TOKEN nor TELEGRAM_BOT_TOKEN set — skipping Telegram notifier\n",
      );
    } else if (hasToken && hasChat) {
      const opts: ConstructorParameters<typeof TelegramNotifier>[0] = {};
      if (tg?.chatId !== undefined) opts.chatId = tg.chatId;
      if (tg?.includeActionButtons !== undefined) opts.includeActionButtons = tg.includeActionButtons;
      try {
        notifiers.push(new TelegramNotifier(opts));
      } catch (err) {
        process.stderr.write(`conclave review: Telegram notifier init failed — ${(err as Error).message}\n`);
      }
    }
  }
  const dc = config.integrations?.discord;
  if (dc?.enabled !== false) {
    const hasUrl = !!(dc?.webhookUrl || process.env["DISCORD_WEBHOOK_URL"]);
    if (dc?.enabled === true && !hasUrl) {
      process.stderr.write(
        "conclave review: DISCORD_WEBHOOK_URL not set — skipping Discord notifier\n",
      );
    } else if (hasUrl) {
      const opts: ConstructorParameters<typeof DiscordNotifier>[0] = {};
      if (dc?.webhookUrl) opts.webhookUrl = dc.webhookUrl;
      if (dc?.username) opts.username = dc.username;
      if (dc?.avatarUrl) opts.avatarUrl = dc.avatarUrl;
      try {
        notifiers.push(new DiscordNotifier(opts));
      } catch (err) {
        process.stderr.write(`conclave review: Discord notifier init failed — ${(err as Error).message}\n`);
      }
    }
  }
  const sl = config.integrations?.slack;
  if (sl?.enabled !== false) {
    const hasUrl = !!(sl?.webhookUrl || process.env["SLACK_WEBHOOK_URL"]);
    if (sl?.enabled === true && !hasUrl) {
      process.stderr.write("conclave review: SLACK_WEBHOOK_URL not set — skipping Slack notifier\n");
    } else if (hasUrl) {
      const opts: ConstructorParameters<typeof SlackNotifier>[0] = {};
      if (sl?.webhookUrl) opts.webhookUrl = sl.webhookUrl;
      if (sl?.username) opts.username = sl.username;
      if (sl?.iconUrl) opts.iconUrl = sl.iconUrl;
      if (sl?.iconEmoji) opts.iconEmoji = sl.iconEmoji;
      try {
        notifiers.push(new SlackNotifier(opts));
      } catch (err) {
        process.stderr.write(`conclave review: Slack notifier init failed — ${(err as Error).message}\n`);
      }
    }
  }
  const em = config.integrations?.email;
  if (em?.enabled !== false) {
    const fromConfigured = !!(em?.from || process.env["CONCLAVE_EMAIL_FROM"]);
    const toConfigured = !!(em?.to || process.env["CONCLAVE_EMAIL_TO"]);
    const transportReady = !!process.env["RESEND_API_KEY"];
    if (em?.enabled === true && (!fromConfigured || !toConfigured || !transportReady)) {
      process.stderr.write(
        "conclave review: email integration enabled but missing from / to / RESEND_API_KEY — skipping\n",
      );
    } else if (fromConfigured && toConfigured && transportReady) {
      const opts: ConstructorParameters<typeof EmailNotifier>[0] = {};
      if (em?.from) opts.from = em.from;
      if (em?.to) opts.to = em.to;
      if (em?.subjectOverride) opts.subjectOverride = em.subjectOverride;
      try {
        notifiers.push(new EmailNotifier(opts));
      } catch (err) {
        process.stderr.write(`conclave review: Email notifier init failed — ${(err as Error).message}\n`);
      }
    }
  }
  return notifiers;
}
