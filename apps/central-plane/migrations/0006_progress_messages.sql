-- v0.11 — progress message persistence for Telegram edit-in-place
-- streaming.
--
-- Design: ONE row per (install_id, episodic_id, chat_id). When the CLI
-- emits a progress stage, the central plane checks for an existing row
-- — if found, it `editMessageText`s the same Telegram message_id and
-- updates the last_lines/last_text/updated_at fields; if absent, it
-- `sendMessage`s and inserts the new row.
--
-- Rationale for keying on chat_id (not just install): one install can
-- be linked to multiple Telegram chats (e.g. dev DM + team group). Each
-- chat needs its own message_id chain — editing chat A's message_id in
-- chat B is invalid. Fanout pre-stage rather than per-stage is what
-- makes (install_id, episodic_id, chat_id) the right grain.
--
-- last_lines stores the accumulated stage timeline as a JSON array so
-- the renderer can replay the full timeline on the next edit (Telegram
-- editMessageText REPLACES the text — there's no append primitive). We
-- truncate the array client-side to TELEGRAM_TEXT_LIMIT_LINES = 24
-- before persisting (Telegram caps a single message at 4096 chars; 24
-- one-line stages fits comfortably under that).
--
-- TTL: rows are pruned after 7 days. The timestamp index supports the
-- prune query without table-scanning. We don't use an "expires_at"
-- column because the purge worker runs on cron, not per-request.

CREATE TABLE IF NOT EXISTS progress_messages (
  install_id   TEXT NOT NULL,
  episodic_id  TEXT NOT NULL,
  chat_id      INTEGER NOT NULL,
  message_id   INTEGER NOT NULL,        -- Telegram message_id for editMessageText
  pr_number    INTEGER,                 -- nullable; rendered into header when set
  repo_slug    TEXT NOT NULL,
  last_lines   TEXT NOT NULL,           -- JSON array of {stage, text}
  last_text    TEXT NOT NULL,           -- last rendered HTML body (dedupe identical edits)
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (install_id, episodic_id, chat_id)
);

CREATE INDEX IF NOT EXISTS idx_progress_messages_updated_at
  ON progress_messages(updated_at);
