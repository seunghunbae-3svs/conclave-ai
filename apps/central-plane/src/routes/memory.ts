import { Hono } from "hono";
import type { Env } from "../env.js";
import { isValidRepoSlug } from "../util.js";

export const memoryRoutes = new Hono<{ Bindings: Env }>();

/**
 * v0.4-alpha stub for federated memory pull. Returns an empty baseline
 * until the memory PR wires up real aggregation.
 */
memoryRoutes.get("/memory/pull", (c) => {
  const repo = c.req.query("repo");
  if (!isValidRepoSlug(repo)) {
    return c.json({ error: "?repo=owner/name required (valid GitHub slug)" }, 400);
  }
  return c.json({
    repo,
    frequencies: [],
    note: "v0.4-alpha stub — aggregation pending in the memory PR",
  });
});
