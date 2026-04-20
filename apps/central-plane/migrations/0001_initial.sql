-- v0.4 initial schema. Keep narrow; add columns as features land
-- (OAuth tokens in PR 2, aggregated memory in PR 3).

CREATE TABLE IF NOT EXISTS installs (
  id            TEXT PRIMARY KEY,               -- c_<time36>_<rand16>
  repo_slug     TEXT NOT NULL UNIQUE,            -- "owner/name"
  token_hash    TEXT NOT NULL,                   -- SHA-256 of the CONCLAVE_TOKEN
  created_at    TEXT NOT NULL,                   -- ISO-8601 UTC
  last_seen_at  TEXT NOT NULL,                   -- bumped on every authed request
  status        TEXT NOT NULL DEFAULT 'active'   -- 'active' | 'suspended'
);

CREATE INDEX IF NOT EXISTS idx_installs_token_hash ON installs(token_hash);

-- Federated k-anonymous aggregate — per decision #21 / D4.
-- Consumer workflows push hashes of (kind|domain|category|severity|tags);
-- we count occurrences across every install and serve the frequency map
-- back to /memory/pull. No user code or blocker text crosses this table.
CREATE TABLE IF NOT EXISTS episodic_aggregates (
  content_hash  TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,                   -- 'answer-key' | 'failure-catalog'
  domain        TEXT NOT NULL,                   -- 'code' | 'design'
  category      TEXT,
  severity      TEXT,
  tags          TEXT NOT NULL DEFAULT '[]',      -- JSON array
  count         INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ea_kind_domain ON episodic_aggregates(kind, domain);
