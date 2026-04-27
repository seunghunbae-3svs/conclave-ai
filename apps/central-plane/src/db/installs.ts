import type { Env } from "../env.js";

export interface InstallRecord {
  id: string;
  repoSlug: string;
  tokenHash: string;
  createdAt: string;
  lastSeenAt: string;
  status: "active" | "suspended";
}

interface InstallRow {
  id: string;
  repo_slug: string;
  token_hash: string;
  created_at: string;
  last_seen_at: string;
  status: string;
}

function rowToRecord(row: InstallRow): InstallRecord {
  return {
    id: row.id,
    repoSlug: row.repo_slug,
    tokenHash: row.token_hash,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    status: (row.status === "suspended" ? "suspended" : "active"),
  };
}

export async function findInstallBySlug(env: Env, slug: string): Promise<InstallRecord | null> {
  const row = await env.DB.prepare("SELECT * FROM installs WHERE repo_slug = ?")
    .bind(slug)
    .first<InstallRow>();
  return row ? rowToRecord(row) : null;
}

export async function findInstallByTokenHash(env: Env, tokenHash: string): Promise<InstallRecord | null> {
  const row = await env.DB.prepare("SELECT * FROM installs WHERE token_hash = ? AND status = 'active'")
    .bind(tokenHash)
    .first<InstallRow>();
  return row ? rowToRecord(row) : null;
}

export interface CreateInstallInput {
  id: string;
  repoSlug: string;
  tokenHash: string;
  now: string;
}

export async function createInstall(env: Env, input: CreateInstallInput): Promise<InstallRecord> {
  await env.DB.prepare(
    "INSERT INTO installs (id, repo_slug, token_hash, created_at, last_seen_at, status) VALUES (?, ?, ?, ?, ?, 'active')",
  )
    .bind(input.id, input.repoSlug, input.tokenHash, input.now, input.now)
    .run();
  return {
    id: input.id,
    repoSlug: input.repoSlug,
    tokenHash: input.tokenHash,
    createdAt: input.now,
    lastSeenAt: input.now,
    status: "active",
  };
}

export async function touchInstall(env: Env, id: string, now: string): Promise<void> {
  await env.DB.prepare("UPDATE installs SET last_seen_at = ? WHERE id = ?")
    .bind(now, id)
    .run();
}

/**
 * v0.13.20 (H1 #5) — per-install monthly spend tracking.
 *
 * monthly_spend_usd accumulates from /review/notify (and any future
 * cost-bearing route). When the period rolls over (new calendar
 * month), reset to 0. Soft cap (default $50) drives a Telegram alert
 * when crossed; hard suspension is a follow-up.
 *
 * Defensive: if the columns don't exist yet (migration 0008 not
 * applied), every function in this section returns null/no-op so
 * the route stays operational. Once the migration is applied, the
 * cap logic activates automatically on the next /review/notify.
 */
export interface MonthlySpend {
  /** Cumulative USD this calendar month. */
  usd: number;
  /** Soft cap; alerts fire when crossed. */
  capUsd: number;
  /** "YYYY-MM-01" — first day of the current accounting period. */
  periodStart: string | null;
}

export async function readMonthlySpend(
  env: Env,
  installId: string,
): Promise<MonthlySpend | null> {
  try {
    const row = await env.DB.prepare(
      "SELECT monthly_spend_usd, monthly_spend_cap_usd, monthly_spend_period_start FROM installs WHERE id = ?",
    )
      .bind(installId)
      .first<{
        monthly_spend_usd: number | null;
        monthly_spend_cap_usd: number | null;
        monthly_spend_period_start: string | null;
      }>();
    if (!row) return null;
    return {
      usd: typeof row.monthly_spend_usd === "number" ? row.monthly_spend_usd : 0,
      capUsd: typeof row.monthly_spend_cap_usd === "number" ? row.monthly_spend_cap_usd : 50,
      periodStart: row.monthly_spend_period_start ?? null,
    };
  } catch (err) {
    // Column missing (migration 0008 not applied yet) — graceful skip.
    console.warn("readMonthlySpend: columns unavailable (migration 0008 pending?):", err);
    return null;
  }
}

/**
 * Add `delta` USD to the install's monthly spend. Auto-rotates the
 * accounting period when a new month starts. Returns the new spend
 * total (for cap-crossing detection by the caller). Returns null on
 * any DB error so the calling /review/notify stays operational even
 * when the migration is pending.
 */
export async function addMonthlySpend(
  env: Env,
  installId: string,
  deltaUsd: number,
  now: Date = new Date(),
): Promise<{ newSpendUsd: number; capUsd: number; rolledOver: boolean } | null> {
  if (!Number.isFinite(deltaUsd) || deltaUsd <= 0) return null;
  const current = await readMonthlySpend(env, installId);
  if (!current) return null;

  // Normalise period to "YYYY-MM-01" so cross-day same-month entries
  // share a single bucket. If the install's stored period is from a
  // prior month (or null), reset.
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const thisPeriod = `${yyyy}-${mm}-01`;
  const rolledOver = current.periodStart !== thisPeriod;
  const baseUsd = rolledOver ? 0 : current.usd;
  const newSpendUsd = +(baseUsd + deltaUsd).toFixed(4);

  try {
    await env.DB.prepare(
      "UPDATE installs SET monthly_spend_usd = ?, monthly_spend_period_start = ? WHERE id = ?",
    )
      .bind(newSpendUsd, thisPeriod, installId)
      .run();
    return { newSpendUsd, capUsd: current.capUsd, rolledOver };
  } catch (err) {
    console.warn("addMonthlySpend: write failed:", err);
    return null;
  }
}
