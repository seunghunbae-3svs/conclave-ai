import { extractCallback } from "./callback-parser.js";
import { TelegramClient } from "./telegram-client.js";
import { defaultEventTypeFor, defaultGh, dispatchRepositoryEvent } from "./dispatcher.js";
import type { BotCallback, DispatchedAction, RunBotOnceOptions, RunBotOnceResult } from "./types.js";

// One poll cycle. Caller runs this on a schedule (GH Actions cron every
// minute with pollTimeoutSec: 25 is the recommended pattern — each job
// finishes inside a minute, ticks overlap gracefully).
//
// Caller responsibilities:
//   - persist result.nextOffset between runs (e.g. cache artifact);
//   - provide a repo-scoped GitHub token with actions:write so
//     repository_dispatch succeeds;
//   - rate-limit — 1/min is fine; /10s across many repos will hit Telegram
//     bot limits.
export async function runBotOnce(opts: RunBotOnceOptions): Promise<RunBotOnceResult> {
  if (!opts.botToken) throw new Error("runBotOnce: botToken is required");
  if (!opts.repo || !opts.repo.includes("/")) {
    throw new Error(`runBotOnce: repo must be "owner/name" (got ${JSON.stringify(opts.repo)})`);
  }

  const telegram = new TelegramClient({
    token: opts.botToken,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  const gh = opts.gh ?? defaultGh;
  const ack = opts.ackCallbacks ?? true;
  const allow = new Set(opts.allowOutcomes ?? (["merged", "reworked", "rejected"] as const));
  const eventTypeFor = opts.eventTypeFor ?? defaultEventTypeFor;

  const updates = await telegram.getUpdates({
    ...(opts.offset !== undefined ? { offset: opts.offset } : {}),
    timeoutSec: opts.pollTimeoutSec ?? 25,
  });

  const parsed: BotCallback[] = [];
  const dispatched: DispatchedAction[] = [];
  const errors: RunBotOnceResult["errors"] = [];
  let maxUpdateId = opts.offset !== undefined ? opts.offset - 1 : -1;

  for (const u of updates) {
    const cb = extractCallback(u);
    if (!cb) {
      // Not a recognised callback — still advance the offset so we don't
      // re-fetch it forever. Telegram gives us the update_id on every
      // shape, so pull it defensively.
      const uid = pickUpdateId(u);
      if (uid !== null && uid > maxUpdateId) maxUpdateId = uid;
      continue;
    }
    parsed.push(cb);
    if (cb.updateId > maxUpdateId) maxUpdateId = cb.updateId;

    if (!allow.has(cb.outcome)) {
      if (ack) {
        await telegram
          .answerCallbackQuery({ id: cb.callbackQueryId, text: `outcome "${cb.outcome}" is disabled on this bot` })
          .catch((e) => errors.push({ updateId: cb.updateId, message: `ack: ${String(e)}` }));
      }
      continue;
    }

    try {
      const eventType = eventTypeFor(cb.outcome);
      const clientPayload: Record<string, unknown> = {
        episodic: cb.episodicId,
        outcome: cb.outcome,
      };
      if (cb.user) clientPayload.triggeredBy = cb.user;
      await dispatchRepositoryEvent(gh, opts.repo, eventType, clientPayload);
      dispatched.push({ eventType, repo: opts.repo, clientPayload, callback: cb });
      if (ack) {
        await telegram
          .answerCallbackQuery({ id: cb.callbackQueryId, text: `✓ ${eventType} dispatched` })
          .catch((e) => errors.push({ updateId: cb.updateId, message: `ack: ${String(e)}` }));
      }
    } catch (err) {
      errors.push({ updateId: cb.updateId, message: err instanceof Error ? err.message : String(err) });
      if (ack) {
        await telegram
          .answerCallbackQuery({
            id: cb.callbackQueryId,
            text: `⚠ dispatch failed — see bot logs`,
            showAlert: true,
          })
          .catch((e) => errors.push({ updateId: cb.updateId, message: `ack: ${String(e)}` }));
      }
    }
  }

  const result: RunBotOnceResult = { parsed, dispatched, errors };
  if (maxUpdateId >= 0) result.nextOffset = maxUpdateId + 1;
  return result;
}

function pickUpdateId(u: unknown): number | null {
  if (u && typeof u === "object" && typeof (u as { update_id?: unknown }).update_id === "number") {
    return (u as { update_id: number }).update_id;
  }
  return null;
}
