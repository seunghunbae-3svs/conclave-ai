-- v0.13.20 (H1 #5) — per-install monthly cost cap + alert.
--
-- monthly_spend_usd accumulates per-install LLM cost reported by
-- /review/notify (and any future cost-bearing route). monthly_spend_cap_usd
-- is the soft cap; when an install exceeds it, /review/notify is rejected
-- with a Telegram warning so a runaway loop can't burn through credits.
--
-- monthly_spend_period_start is the first day of the current accounting
-- month (e.g. "2026-04-01"). The cron resets monthly_spend_usd to 0 and
-- bumps the period when it rolls over.
--
-- Defaults are deliberate: $50/month soft cap, NULL period_start until
-- the first /review/notify (no rolling-window math on a fresh install).

ALTER TABLE installs ADD COLUMN monthly_spend_usd REAL NOT NULL DEFAULT 0.0;
ALTER TABLE installs ADD COLUMN monthly_spend_cap_usd REAL NOT NULL DEFAULT 50.0;
ALTER TABLE installs ADD COLUMN monthly_spend_period_start TEXT;
