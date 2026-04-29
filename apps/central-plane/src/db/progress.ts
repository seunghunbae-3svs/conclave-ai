import type { Env } from "../env.js";

/**
 * v0.11 — D1 helpers for the progress_messages table. Keyed on
 * (install_id, episodic_id, chat_id). The route handler owns the
 * sendMessage / editMessageText decision — this layer is pure storage.
 */

export interface ProgressRow {
  installId: string;
  episodicId: string;
  chatId: number;
  messageId: number;
  prNumber: number | null;
  repoSlug: string;
  lastLines: string; // JSON-encoded ProgressLine[]
  lastText: string;
  createdAt: string;
  updatedAt: string;
}

interface DbRow {
  install_id: string;
  episodic_id: string;
  chat_id: number;
  message_id: number;
  pr_number: number | null;
  repo_slug: string;
  last_lines: string;
  last_text: string;
  created_at: string;
  updated_at: string;
}

function rowToRecord(r: DbRow): ProgressRow {
  return {
    installId: r.install_id,
    episodicId: r.episodic_id,
    chatId: r.chat_id,
    messageId: r.message_id,
    prNumber: r.pr_number,
    repoSlug: r.repo_slug,
    lastLines: r.last_lines,
    lastText: r.last_text,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function findProgressMessage(
  env: Env,
  installId: string,
  episodicId: string,
  chatId: number,
): Promise<ProgressRow | null> {
  // UX-5 — return the MOST RECENT row for (install, episodic, chat).
  // Pre-UX-5 the SQL had no ORDER BY, so D1 returned the first row
  // matching the key — fine when there was always one. With per-cycle
  // separate messages there are now N rows, one per cycle; we want
  // updates within a cycle to land on THAT cycle's row, which is the
  // most recently created.
  const row = await env.DB.prepare(
    "SELECT * FROM progress_messages WHERE install_id = ? AND episodic_id = ? AND chat_id = ? ORDER BY created_at DESC LIMIT 1",
  )
    .bind(installId, episodicId, chatId)
    .first<DbRow>();
  return row ? rowToRecord(row) : null;
}

export async function insertProgressMessage(
  env: Env,
  input: {
    installId: string;
    episodicId: string;
    chatId: number;
    messageId: number;
    prNumber: number | null;
    repoSlug: string;
    lastLines: string;
    lastText: string;
    now: string;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO progress_messages
       (install_id, episodic_id, chat_id, message_id, pr_number, repo_slug,
        last_lines, last_text, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      input.installId,
      input.episodicId,
      input.chatId,
      input.messageId,
      input.prNumber,
      input.repoSlug,
      input.lastLines,
      input.lastText,
      input.now,
      input.now,
    )
    .run();
}

export async function updateProgressMessage(
  env: Env,
  input: {
    installId: string;
    episodicId: string;
    chatId: number;
    /**
     * UX-5 — Telegram message_id of the row to update. Pre-UX-5 the
     * UPDATE matched on the (install, episodic, chat) tuple alone,
     * which is no longer unique once per-cycle separate messages
     * exist (multiple rows per tuple, one per cycle). Pinning by
     * message_id targets exactly the cycle whose row this is.
     */
    messageId: number;
    lastLines: string;
    lastText: string;
    now: string;
  },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE progress_messages
       SET last_lines = ?, last_text = ?, updated_at = ?
     WHERE install_id = ? AND episodic_id = ? AND chat_id = ? AND message_id = ?`,
  )
    .bind(
      input.lastLines,
      input.lastText,
      input.now,
      input.installId,
      input.episodicId,
      input.chatId,
      input.messageId,
    )
    .run();
}
