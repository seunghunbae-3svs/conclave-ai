import type { Env } from "../env.js";

export interface TelegramLink {
  chatId: number;
  installId: string;
  linkedAt: string;
  userLabel: string | null;
}

interface Row {
  chat_id: number;
  install_id: string;
  linked_at: string;
  user_label: string | null;
}

function rowToRecord(r: Row): TelegramLink {
  return {
    chatId: r.chat_id,
    installId: r.install_id,
    linkedAt: r.linked_at,
    userLabel: r.user_label,
  };
}

export async function findLinkByChatId(env: Env, chatId: number): Promise<TelegramLink | null> {
  const row = await env.DB.prepare("SELECT * FROM telegram_links WHERE chat_id = ?")
    .bind(chatId)
    .first<Row>();
  return row ? rowToRecord(row) : null;
}

export async function upsertLink(
  env: Env,
  input: { chatId: number; installId: string; linkedAt: string; userLabel?: string | null },
): Promise<void> {
  // UPSERT by chat_id — a user can re-link if their CONCLAVE_TOKEN rotates
  await env.DB.prepare(
    `INSERT INTO telegram_links (chat_id, install_id, linked_at, user_label)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET
       install_id = excluded.install_id,
       linked_at = excluded.linked_at,
       user_label = excluded.user_label`,
  )
    .bind(input.chatId, input.installId, input.linkedAt, input.userLabel ?? null)
    .run();
}

/**
 * Fetch the install row WITH the github_access_token column (needed for
 * dispatch on behalf of the user). Separate from findInstallBySlug because
 * leaking the token through the generic lookup is a bad-default pattern.
 */
export interface InstallWithToken {
  id: string;
  repoSlug: string;
  githubAccessToken: string | null;
  githubTokenScope: string | null;
}

export async function getInstallForDispatch(env: Env, installId: string): Promise<InstallWithToken | null> {
  const row = await env.DB.prepare(
    "SELECT id, repo_slug, github_access_token, github_token_scope FROM installs WHERE id = ? AND status = 'active'",
  )
    .bind(installId)
    .first<{
      id: string;
      repo_slug: string;
      github_access_token: string | null;
      github_token_scope: string | null;
    }>();
  if (!row) return null;
  return {
    id: row.id,
    repoSlug: row.repo_slug,
    githubAccessToken: row.github_access_token,
    githubTokenScope: row.github_token_scope,
  };
}

export async function setGithubAccessToken(
  env: Env,
  installId: string,
  accessToken: string,
  scope: string,
  now: string,
): Promise<void> {
  await env.DB.prepare(
    "UPDATE installs SET github_access_token = ?, github_token_scope = ?, github_token_set_at = ? WHERE id = ?",
  )
    .bind(accessToken, scope, now, installId)
    .run();
}
