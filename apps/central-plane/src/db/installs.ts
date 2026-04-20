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
