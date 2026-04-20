import type { Context, Next } from "hono";
import type { Env } from "./env.js";
import { findInstallByTokenHash, touchInstall } from "./db/installs.js";
import { sha256Hex } from "./util.js";

export type AuthedVariables = {
  installId: string;
  installRepo: string;
};

export type AuthedContext = Context<{ Bindings: Env; Variables: AuthedVariables }>;

/**
 * Bearer-token auth middleware. Pulls `Authorization: Bearer c_...` off
 * the request, hashes it, and looks up the install row. On match, we
 * stash the install id/repo on the Hono context so handlers can read it
 * without re-querying, and we bump `last_seen_at` for observability.
 *
 * Timing-safe comparison is not needed here: we hash the incoming token
 * before the DB lookup (constant-work transformation) and the primary
 * key on token_hash means the DB comparison is a single index probe, not
 * a linear scan. The token itself is high-entropy opaque (c_<cuid>_<uuid>)
 * so guessing-attack surface is nil.
 */
export async function requireInstallAuth(
  c: Context<{ Bindings: Env; Variables: AuthedVariables }>,
  next: Next,
): Promise<Response | void> {
  const header = c.req.header("authorization") ?? c.req.header("Authorization");
  if (!header || !/^Bearer\s+/i.test(header)) {
    return c.json({ error: "missing Authorization: Bearer <CONCLAVE_TOKEN> header" }, 401);
  }
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token.startsWith("c_")) {
    return c.json({ error: "token must begin with c_" }, 401);
  }
  const tokenHash = await sha256Hex(token);
  const install = await findInstallByTokenHash(c.env, tokenHash);
  if (!install) {
    return c.json({ error: "token not recognised" }, 401);
  }
  c.set("installId", install.id);
  c.set("installRepo", install.repoSlug);
  // Fire-and-forget — we don't block the response on the touch write.
  c.executionCtx.waitUntil(touchInstall(c.env, install.id, new Date().toISOString()));
  await next();
}
