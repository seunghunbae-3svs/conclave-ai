import { Hono } from "hono";
import type { Env } from "../env.js";
import { requireInstallAuth, type AuthedVariables } from "../auth.js";
import { upsertAggregate } from "../db/aggregates.js";

export const episodicRoutes = new Hono<{ Bindings: Env; Variables: AuthedVariables }>();

interface PushItem {
  contentHash: string;
  kind: "answer-key" | "failure-catalog";
  domain: "code" | "design";
  category?: string | null;
  severity?: string | null;
  tags?: string[];
}

function isValidItem(x: unknown): x is PushItem {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  if (typeof o.contentHash !== "string" || o.contentHash.length < 8 || o.contentHash.length > 128) return false;
  if (o.kind !== "answer-key" && o.kind !== "failure-catalog") return false;
  if (o.domain !== "code" && o.domain !== "design") return false;
  if (o.category !== undefined && o.category !== null && typeof o.category !== "string") return false;
  if (o.severity !== undefined && o.severity !== null && typeof o.severity !== "string") return false;
  if (o.tags !== undefined && (!Array.isArray(o.tags) || !o.tags.every((t) => typeof t === "string"))) return false;
  return true;
}

const MAX_ITEMS_PER_REQUEST = 500;

/**
 * Authenticated federated-memory push. Requires a valid CONCLAVE_TOKEN.
 * Body: { items: [{ contentHash, kind, domain, category?, severity?, tags? }, ...] }.
 * Only hashes + metadata cross this boundary per decision #21 / D4 —
 * diff content / blocker text never do.
 *
 * Upsert is atomic per item via ON CONFLICT. We tolerate partial failure:
 * if one item is malformed, the valid ones still commit and the response
 * reports the skip count.
 */
episodicRoutes.post("/episodic/push", requireInstallAuth, async (c) => {
  const body = (await c.req.json().catch(() => null)) as { items?: unknown } | null;
  if (!body || !Array.isArray(body.items)) {
    return c.json({ error: "body must be { items: [...] }" }, 400);
  }
  if (body.items.length > MAX_ITEMS_PER_REQUEST) {
    return c.json(
      { error: `max ${MAX_ITEMS_PER_REQUEST} items per request; split larger batches` },
      413,
    );
  }

  const now = new Date().toISOString();
  let stored = 0;
  let skipped = 0;
  for (const raw of body.items) {
    if (!isValidItem(raw)) {
      skipped += 1;
      continue;
    }
    await upsertAggregate(c.env, {
      contentHash: raw.contentHash,
      kind: raw.kind,
      domain: raw.domain,
      category: raw.category ?? null,
      severity: raw.severity ?? null,
      tags: raw.tags ?? [],
      now,
    });
    stored += 1;
  }

  return c.json({
    accepted: body.items.length,
    stored,
    skipped,
    repo: c.get("installRepo"),
  });
});
