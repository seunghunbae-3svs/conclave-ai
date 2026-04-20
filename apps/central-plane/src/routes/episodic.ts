import { Hono } from "hono";
import type { Env } from "../env.js";

export const episodicRoutes = new Hono<{ Bindings: Env }>();

/**
 * v0.4-alpha stub for federated memory push. Accepts a list of content
 * hashes (per D4's hashes-default policy) and acknowledges. Real
 * aggregation — increment `episodic_aggregates.count`, track first/last
 * seen timestamps — lands in the memory PR.
 */
episodicRoutes.post("/episodic/push", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { hashes?: unknown } | null;
  if (!body || !Array.isArray(body.hashes)) {
    return c.json({ error: "body must be { hashes: [...] }" }, 400);
  }
  return c.json({
    accepted: body.hashes.length,
    stored: 0,
    note: "v0.4-alpha stub — aggregation pending in the memory PR",
  });
});
