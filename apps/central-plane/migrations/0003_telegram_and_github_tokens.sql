-- v0.4-alpha milestone 4.
--
-- Adds (1) the chat-to-install mapping that powers the central
-- @conclave_ai bot and (2) room to store the GitHub OAuth access token
-- the bot uses to fire repository_dispatch on the user's behalf.
--
-- Token storage note — v0.4-alpha holds the GitHub token in PLAINTEXT.
-- This is an explicit trade-off: no user tenants exist yet, the worker
-- source is 100% ours with no user-supplied code paths, and D1 itself
-- is a managed credential store. v0.5 upgrades to field-level
-- encryption with a KMS-backed key (KV or env secret). Documented in
-- docs/architecture-v0.4.md §D12.

ALTER TABLE installs ADD COLUMN github_access_token TEXT;
ALTER TABLE installs ADD COLUMN github_token_scope  TEXT;
ALTER TABLE installs ADD COLUMN github_token_set_at TEXT;

CREATE TABLE IF NOT EXISTS telegram_links (
  chat_id     INTEGER PRIMARY KEY,           -- Telegram chat_id (positive = DM, negative = group)
  install_id  TEXT NOT NULL,                 -- FK to installs.id
  linked_at   TEXT NOT NULL,                 -- ISO-8601 UTC
  user_label  TEXT,                          -- Telegram username or first_name for debug
  FOREIGN KEY (install_id) REFERENCES installs(id)
);

CREATE INDEX IF NOT EXISTS idx_telegram_links_install ON telegram_links(install_id);
