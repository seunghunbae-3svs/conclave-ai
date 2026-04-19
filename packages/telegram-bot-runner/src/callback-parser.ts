import type { BotCallback, Outcome } from "./types.js";

/**
 * Parse the `callback_data` string that integration-telegram stamps on
 * its inline buttons. Format: `ep:<episodicId>:<outcome>`. Anything else
 * returns null — we log+skip rather than throw, because malformed updates
 * are not our problem to crash over (could be an old button from a
 * previous schema version).
 */
export function parseCallbackData(data: string | undefined | null): { episodicId: string; outcome: Outcome } | null {
  if (!data) return null;
  // "ep:<id>:<outcome>" — the id itself can't contain ":" because
  // integration-telegram generates ids from UUIDv4 (no colons), but we
  // still handle it defensively by splitting on the LAST colon.
  if (!data.startsWith("ep:")) return null;
  const lastColon = data.lastIndexOf(":");
  if (lastColon <= 3) return null; // no room for both id and outcome
  const episodicId = data.slice(3, lastColon);
  const outcome = data.slice(lastColon + 1);
  if (outcome !== "merged" && outcome !== "reworked" && outcome !== "rejected") return null;
  if (episodicId.length === 0) return null;
  return { episodicId, outcome };
}

/**
 * Pull a BotCallback out of a Telegram `Update` object. Returns null for
 * non-callback updates or for callbacks we don't recognise.
 */
export function extractCallback(update: unknown): BotCallback | null {
  if (!update || typeof update !== "object") return null;
  const u = update as { update_id?: unknown; callback_query?: unknown };
  if (typeof u.update_id !== "number") return null;
  const cq = u.callback_query;
  if (!cq || typeof cq !== "object") return null;
  const q = cq as {
    id?: unknown;
    data?: unknown;
    from?: { username?: unknown; first_name?: unknown };
    message?: { chat?: { id?: unknown }; message_id?: unknown };
  };
  if (typeof q.id !== "string") return null;
  const parsed = parseCallbackData(typeof q.data === "string" ? q.data : undefined);
  if (!parsed) return null;

  const result: BotCallback = {
    episodicId: parsed.episodicId,
    outcome: parsed.outcome,
    callbackQueryId: q.id,
    updateId: u.update_id,
  };
  const chatId = q.message?.chat?.id;
  if (typeof chatId === "number") result.chatId = chatId;
  const messageId = q.message?.message_id;
  if (typeof messageId === "number") result.messageId = messageId;
  const user = typeof q.from?.username === "string" ? q.from.username : typeof q.from?.first_name === "string" ? q.from.first_name : undefined;
  if (user) result.user = user;
  return result;
}
