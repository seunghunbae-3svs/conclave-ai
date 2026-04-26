import { Hono } from "hono";
import type { Env } from "../env.js";
import { findInstallByTokenHash, touchInstall } from "../db/installs.js";
import { findEpisodicAnchor, upsertEpisodicAnchor } from "../db/episodic-anchor.js";
import { sha256Hex } from "../util.js";

/**
 * v0.12.x — episodic anchor routes.
 *
 * Closes Bug A: the v0.8 autonomy rework loop expects the original
 * review to have run on CI (the episodic file is committed alongside
 * the workflow run). When `conclave review` runs LOCALLY, the
 * episodic only exists on that machine; the CI rework workflow can't
 * find it and exits 1.
 *
 * Fix: local `conclave review` POSTs the episodic JSON to this route;
 * CI `conclave rework` GETs it back when the local store misses.
 *
 * Auth: same Bearer install-token scheme as `/review/notify`. Cross-
 * install isolation is enforced at the storage layer — only the
 * install that pushed an anchor can pull it back.
 *
 * Size cap: 256KB per push. A typical episodic with 3 agents × 6
 * blockers each is ~6KB; the cap is generous enough for a heavy
 * mixed-domain run while keeping a single anchor under D1 row limits.
 */
export const episodicAnchorRoutes = new Hono<{ Bindings: Env }>();

const MAX_PAYLOAD_BYTES = 256 * 1024;

async function authBearer(
  env: Env,
  authHeader: string | undefined,
): Promise<{ ok: true; installId: string; repoSlug: string } | { ok: false; status: number; error: string }> {
  if (!authHeader || !/^Bearer\s+(.+)$/i.test(authHeader)) {
    return { ok: false, status: 401, error: "missing or malformed Authorization: Bearer <token>" };
  }
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return { ok: false, status: 401, error: "empty bearer token" };
  const tokenHash = await sha256Hex(token);
  const install = await findInstallByTokenHash(env, tokenHash);
  if (!install) return { ok: false, status: 401, error: "unknown or revoked token" };
  return { ok: true, installId: install.id, repoSlug: install.repoSlug };
}

episodicAnchorRoutes.post("/episodic/anchor", async (c) => {
  const auth = await authBearer(c.env, c.req.header("authorization") ?? c.req.header("Authorization"));
  if (!auth.ok) return c.json({ error: auth.error }, auth.status as 401);

  const body = (await c.req.json().catch(() => null)) as
    | {
        episodic_id?: unknown;
        repo_slug?: unknown;
        pr_number?: unknown;
        payload?: unknown;
      }
    | null;
  if (!body || typeof body !== "object") {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (typeof body.episodic_id !== "string" || body.episodic_id.length === 0) {
    return c.json({ error: "episodic_id: expected non-empty string" }, 400);
  }
  if (typeof body.repo_slug !== "string" || body.repo_slug.length === 0) {
    return c.json({ error: "repo_slug: expected non-empty string" }, 400);
  }
  if (
    body.pr_number !== undefined &&
    body.pr_number !== null &&
    (typeof body.pr_number !== "number" || !Number.isFinite(body.pr_number))
  ) {
    return c.json({ error: "pr_number: expected finite number or null" }, 400);
  }
  // Payload may be the parsed object OR a pre-serialized string. We
  // canonicalize to a string for storage so the wire format stays a
  // single TEXT column. Reject anything else.
  let payloadStr: string;
  if (typeof body.payload === "string") {
    payloadStr = body.payload;
  } else if (body.payload && typeof body.payload === "object") {
    payloadStr = JSON.stringify(body.payload);
  } else {
    return c.json({ error: "payload: expected object or pre-serialized JSON string" }, 400);
  }
  if (payloadStr.length > MAX_PAYLOAD_BYTES) {
    return c.json(
      { error: `payload too large: ${payloadStr.length} > ${MAX_PAYLOAD_BYTES} bytes` },
      413,
    );
  }

  const now = new Date().toISOString();
  await touchInstall(c.env, auth.installId, now).catch((err) => {
    console.warn("touchInstall failed:", err);
  });

  const prNumber = typeof body.pr_number === "number" ? body.pr_number : null;
  await upsertEpisodicAnchor(c.env, {
    installId: auth.installId,
    episodicId: body.episodic_id,
    repoSlug: body.repo_slug,
    prNumber,
    payload: payloadStr,
    now,
  });

  return c.json({
    ok: true,
    episodic_id: body.episodic_id,
    bytes: payloadStr.length,
  });
});

episodicAnchorRoutes.get("/episodic/anchor/:id", async (c) => {
  const auth = await authBearer(c.env, c.req.header("authorization") ?? c.req.header("Authorization"));
  if (!auth.ok) return c.json({ error: auth.error }, auth.status as 401);

  const id = c.req.param("id");
  if (!id) return c.json({ error: "id: required path param" }, 400);

  const row = await findEpisodicAnchor(c.env, auth.installId, id);
  if (!row) {
    return c.json(
      { error: `no episodic anchor for id ${id} on this install` },
      404,
    );
  }

  // Return the payload as a parsed JSON object (not a string) so callers
  // can use it directly. Best-effort parse — if it fails (somehow), we
  // surface the raw string under `payload_raw`.
  let payload: unknown;
  let payloadRaw: string | undefined;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    payloadRaw = row.payload;
  }
  return c.json({
    ok: true,
    episodic_id: row.episodicId,
    repo_slug: row.repoSlug,
    pr_number: row.prNumber,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    ...(payload !== undefined ? { payload } : {}),
    ...(payloadRaw !== undefined ? { payload_raw: payloadRaw } : {}),
  });
});
