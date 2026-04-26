-- v0.12.x — episodic anchors for the autonomy loop.
--
-- The v0.8 autonomy loop dispatches `conclave-rework` on the consumer
-- repo when verdict=rework. The dispatched workflow then runs
-- `conclave rework --pr N --episodic <id>`, which expects to find the
-- episodic JSON at `.conclave/episodic/...` in the CI checkout.
-- That works when the original review ran on CI (the episodic was
-- committed by an earlier review run). It does NOT work when the
-- review ran LOCALLY on a developer's machine — the episodic only
-- exists on that developer's filesystem, and CI's `conclave rework`
-- exits 1 with `episodic ... not found in store`.
--
-- Fix: the local `conclave review` POSTs the full episodic JSON to
-- `/episodic/anchor` after writing it locally. The CI `conclave
-- rework` falls back to GET `/episodic/anchor/:id` when the local
-- store misses. Bearer auth on both endpoints; only the install that
-- pushed an anchor can pull it back (cross-install isolation via the
-- install_id column + the auth check).
--
-- TTL: rows are pruned after 14 days. The autonomy loop typically
-- closes within hours; 14 days is generous enough to cover a manual
-- "fix tomorrow" rework while keeping the table from growing
-- unbounded. We don't bother with a hot-path purge — a daily cron is
-- enough.
--
-- Schema notes:
--   - `payload` is the full episodic JSON, stored verbatim. Worker
--     parses on read; we don't expand fields into columns because the
--     downstream `conclave rework` only ever needs the whole blob.
--   - `installs(id)` is the FK target, but D1's foreign key handling
--     is best-effort; we don't add the constraint formally to keep
--     migrations idempotent across re-runs.

CREATE TABLE IF NOT EXISTS episodic_anchors (
  install_id    TEXT NOT NULL,
  episodic_id   TEXT NOT NULL,
  repo_slug     TEXT NOT NULL,
  pr_number     INTEGER,
  payload       TEXT NOT NULL,        -- full EpisodicEntry JSON
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (install_id, episodic_id)
);

CREATE INDEX IF NOT EXISTS idx_episodic_anchors_updated_at
  ON episodic_anchors(updated_at);
