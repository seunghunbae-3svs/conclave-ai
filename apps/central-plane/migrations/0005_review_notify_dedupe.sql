-- v0.7.5 — idempotency for /review/notify.
--
-- CI workflows retry review steps on transient GitHub / Anthropic
-- failures (rate limits, 5xx on the vendor). Each retry re-enters the
-- notifier and fires /review/notify again, which produced duplicate
-- Telegram messages for the SAME PR + SHA + verdict. The CLI has no
-- memory across retries and the central plane has no dedupe window, so
-- consumers saw 2–3 identical messages per PR.
--
-- Dedupe key: (install_id, episodic_id, repo_slug, pr_number). We key
-- on install_id rather than the bearer token hash so cross-install
-- collisions are impossible (two different repos legitimately sharing
-- an episodic_id from a fork are distinct events). `notified_at` lets
-- us window the dedupe — default behaviour is "dedupe if seen within
-- 5 minutes", configurable in code. We prune old rows periodically
-- rather than on every request to keep hot-path cost flat.

CREATE TABLE IF NOT EXISTS review_notify_dedupe (
  install_id   TEXT NOT NULL,
  episodic_id  TEXT NOT NULL,
  repo_slug    TEXT NOT NULL,
  pr_number    INTEGER,            -- nullable: pre-v0.7.1 callers omit it
  notified_at  TEXT NOT NULL,      -- ISO-8601 UTC, last relay timestamp
  delivered    INTEGER NOT NULL,   -- last known delivered count (diagnostic)
  PRIMARY KEY (install_id, episodic_id, repo_slug)
);

CREATE INDEX IF NOT EXISTS idx_review_notify_dedupe_notified_at
  ON review_notify_dedupe(notified_at);
