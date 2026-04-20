-- v0.4-alpha OAuth device flow. Transient records — one row per in-flight
-- CLI authorisation. `device_code` is a secret that never leaves the
-- Worker; we return the short user_code (public) + our own device_code_id
-- (opaque pointer) to the CLI so it can poll without handling the raw
-- GitHub device_code itself.

CREATE TABLE IF NOT EXISTS oauth_devices (
  device_code_id TEXT PRIMARY KEY,                -- c_<time36>_<rand16>
  device_code    TEXT NOT NULL,                    -- GitHub-issued; secret
  user_code      TEXT NOT NULL,                    -- short public code user types
  repo_slug      TEXT NOT NULL,                    -- what they're registering
  interval_sec   INTEGER NOT NULL DEFAULT 5,       -- GitHub-recommended poll interval
  expires_at     TEXT NOT NULL,                    -- ISO-8601; GitHub's 15-min default
  created_at     TEXT NOT NULL,
  consumed       INTEGER NOT NULL DEFAULT 0        -- 0=pending  1=succeeded  2=denied/expired
);

CREATE INDEX IF NOT EXISTS idx_oauth_devices_expires ON oauth_devices(expires_at);
CREATE INDEX IF NOT EXISTS idx_oauth_devices_consumed ON oauth_devices(consumed);
