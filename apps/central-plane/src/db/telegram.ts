import type { Env } from "../env.js";
import { encryptToken, decryptToken } from "../crypto.js";

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
 *
 * v0.5 H: reads the encrypted column (`github_access_token_enc`) first,
 * and falls back to the plaintext column for rows that existed before
 * the encryption upgrade. On a plaintext-fallback read, the caller
 * triggers a one-time lazy upgrade via `upgradeInstallTokenEncryption`.
 */
export interface InstallWithToken {
  id: string;
  repoSlug: string;
  githubAccessToken: string | null;
  githubTokenScope: string | null;
  /**
   * Internal flag — true when the token was decoded from the plaintext
   * column and the row should be lazily upgraded to `_enc`. The caller
   * that actually USES the token (not just inspects it) is responsible
   * for calling `upgradeInstallTokenEncryption` after a successful
   * dispatch. We upgrade after-dispatch (not before) so a KEK mis-set
   * doesn't brick reads on rollback.
   */
  needsLazyEncrypt: boolean;
}

interface DispatchRow {
  id: string;
  repo_slug: string;
  github_access_token: string | null;
  github_access_token_enc: string | null;
  github_token_scope: string | null;
}

export async function getInstallForDispatch(env: Env, installId: string): Promise<InstallWithToken | null> {
  const row = await env.DB.prepare(
    "SELECT id, repo_slug, github_access_token, github_access_token_enc, github_token_scope FROM installs WHERE id = ? AND status = 'active'",
  )
    .bind(installId)
    .first<DispatchRow>();
  if (!row) return null;

  // Prefer the encrypted column when present. A non-NULL `_enc` MUST
  // decrypt successfully with the configured KEK — we do not silently
  // fall back to plaintext in that case, because it would mask tamper /
  // KEK-mismatch bugs. Bubble the error.
  if (row.github_access_token_enc) {
    const kek = env.CONCLAVE_TOKEN_KEK;
    if (!kek) {
      throw new Error(
        "getInstallForDispatch: row has encrypted github_access_token_enc but CONCLAVE_TOKEN_KEK is not set",
      );
    }
    const plaintext = await decryptToken(row.github_access_token_enc, kek);
    return {
      id: row.id,
      repoSlug: row.repo_slug,
      githubAccessToken: plaintext,
      githubTokenScope: row.github_token_scope,
      needsLazyEncrypt: false,
    };
  }

  // Fallback — plaintext column (legacy row from before v0.5 H). Flag
  // it so the caller can schedule a lazy encrypt.
  return {
    id: row.id,
    repoSlug: row.repo_slug,
    githubAccessToken: row.github_access_token,
    githubTokenScope: row.github_token_scope,
    needsLazyEncrypt: row.github_access_token !== null,
  };
}

/**
 * Persist the GitHub access token, always in encrypted form. Called from
 * the OAuth callback on initial install and on token rotation. Sets the
 * plaintext column to NULL in the same UPDATE so no row ever has BOTH
 * columns populated after v0.5 H rolls out.
 */
export async function setGithubAccessToken(
  env: Env,
  installId: string,
  accessToken: string,
  scope: string,
  now: string,
): Promise<void> {
  const kek = env.CONCLAVE_TOKEN_KEK;
  if (!kek) {
    throw new Error(
      "setGithubAccessToken: CONCLAVE_TOKEN_KEK is not set — refusing to persist a GitHub access token without encryption. Run `wrangler secret put CONCLAVE_TOKEN_KEK`.",
    );
  }
  const ciphertext = await encryptToken(accessToken, kek);
  await env.DB.prepare(
    "UPDATE installs SET github_access_token_enc = ?, github_access_token = NULL, github_token_scope = ?, github_token_set_at = ? WHERE id = ?",
  )
    .bind(ciphertext, scope, now, installId)
    .run();
}

/**
 * One-time lazy upgrade: take a plaintext token that was just read from
 * the legacy `github_access_token` column, encrypt it, write the
 * ciphertext into `_enc`, and NULL out the plaintext. Called by the
 * Telegram webhook after a successful dispatch so rollback on KEK
 * misconfiguration is still possible up to that moment.
 *
 * Idempotent: the WHERE clause guards against clobbering a parallel
 * writer by requiring `github_access_token_enc IS NULL`.
 */
export async function upgradeInstallTokenEncryption(
  env: Env,
  installId: string,
  plaintextToken: string,
): Promise<void> {
  const kek = env.CONCLAVE_TOKEN_KEK;
  if (!kek) {
    throw new Error(
      "upgradeInstallTokenEncryption: CONCLAVE_TOKEN_KEK is not set — cannot lazy-encrypt legacy plaintext token",
    );
  }
  const ciphertext = await encryptToken(plaintextToken, kek);
  await env.DB.prepare(
    "UPDATE installs SET github_access_token_enc = ?, github_access_token = NULL WHERE id = ? AND github_access_token_enc IS NULL",
  )
    .bind(ciphertext, installId)
    .run();
}
