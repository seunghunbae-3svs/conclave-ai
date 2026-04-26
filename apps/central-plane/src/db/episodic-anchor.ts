import type { Env } from "../env.js";

/**
 * v0.12.x — D1 helpers for episodic_anchors. Pure storage; the route
 * handler owns auth + payload validation.
 */

export interface EpisodicAnchorRow {
  installId: string;
  episodicId: string;
  repoSlug: string;
  prNumber: number | null;
  payload: string; // JSON-encoded EpisodicEntry
  createdAt: string;
  updatedAt: string;
}

interface DbRow {
  install_id: string;
  episodic_id: string;
  repo_slug: string;
  pr_number: number | null;
  payload: string;
  created_at: string;
  updated_at: string;
}

function rowToRecord(r: DbRow): EpisodicAnchorRow {
  return {
    installId: r.install_id,
    episodicId: r.episodic_id,
    repoSlug: r.repo_slug,
    prNumber: r.pr_number,
    payload: r.payload,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function findEpisodicAnchor(
  env: Env,
  installId: string,
  episodicId: string,
): Promise<EpisodicAnchorRow | null> {
  const row = await env.DB.prepare(
    "SELECT * FROM episodic_anchors WHERE install_id = ? AND episodic_id = ?",
  )
    .bind(installId, episodicId)
    .first<DbRow>();
  return row ? rowToRecord(row) : null;
}

/**
 * Upsert by (install_id, episodic_id). Re-pushing the same id refreshes
 * the payload + updated_at — useful when a re-run review writes a new
 * verdict to the same episodic.
 */
export async function upsertEpisodicAnchor(
  env: Env,
  input: {
    installId: string;
    episodicId: string;
    repoSlug: string;
    prNumber: number | null;
    payload: string;
    now: string;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO episodic_anchors
       (install_id, episodic_id, repo_slug, pr_number, payload, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(install_id, episodic_id) DO UPDATE SET
       repo_slug = excluded.repo_slug,
       pr_number = excluded.pr_number,
       payload = excluded.payload,
       updated_at = excluded.updated_at`,
  )
    .bind(
      input.installId,
      input.episodicId,
      input.repoSlug,
      input.prNumber,
      input.payload,
      input.now,
      input.now,
    )
    .run();
}
