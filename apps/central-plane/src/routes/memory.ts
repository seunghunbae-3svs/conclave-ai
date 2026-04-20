import { Hono } from "hono";
import type { Env } from "../env.js";
import { requireInstallAuth, type AuthedVariables } from "../auth.js";
import { listAggregates } from "../db/aggregates.js";

export const memoryRoutes = new Hono<{ Bindings: Env; Variables: AuthedVariables }>();

/**
 * Authenticated federated-memory pull. Returns the aggregate frequency
 * table for the requested (kind, domain). No repo-level filtering is
 * intentional — the whole point is cross-repo learning. Privacy lives
 * at the ingest layer (hashes only).
 *
 * Query params:
 *   kind=answer-key|failure-catalog   optional — filter
 *   domain=code|design                optional — filter
 *   min_count=<n>                     optional — only patterns with count >= n
 *                                     (baseline-quality filter; default 1)
 *   limit=<n>                         optional — 1..1000; default 200
 */
memoryRoutes.get("/memory/pull", requireInstallAuth, async (c) => {
  const kind = c.req.query("kind");
  if (kind !== undefined && kind !== "answer-key" && kind !== "failure-catalog") {
    return c.json({ error: "kind must be 'answer-key' or 'failure-catalog' if provided" }, 400);
  }
  const domain = c.req.query("domain");
  if (domain !== undefined && domain !== "code" && domain !== "design") {
    return c.json({ error: "domain must be 'code' or 'design' if provided" }, 400);
  }
  const minCountRaw = c.req.query("min_count");
  let minCount: number | undefined;
  if (minCountRaw !== undefined) {
    const n = Number.parseInt(minCountRaw, 10);
    if (!Number.isFinite(n) || n < 1) {
      return c.json({ error: "min_count must be a positive integer" }, 400);
    }
    minCount = n;
  }
  const limitRaw = c.req.query("limit");
  let limit: number | undefined;
  if (limitRaw !== undefined) {
    const n = Number.parseInt(limitRaw, 10);
    if (!Number.isFinite(n) || n < 1 || n > 1000) {
      return c.json({ error: "limit must be between 1 and 1000" }, 400);
    }
    limit = n;
  }

  const query: Parameters<typeof listAggregates>[1] = {};
  if (kind) query.kind = kind;
  if (domain) query.domain = domain;
  if (minCount !== undefined) query.minCount = minCount;
  if (limit !== undefined) query.limit = limit;

  const rows = await listAggregates(c.env, query);
  return c.json({
    repo: c.get("installRepo"),
    entries: rows.map((r) => ({
      contentHash: r.contentHash,
      kind: r.kind,
      domain: r.domain,
      category: r.category,
      severity: r.severity,
      tags: r.tags,
      count: r.count,
    })),
    total: rows.length,
  });
});
