import { Hono } from "hono";
import type { Env } from "./env.js";
import { healthRoutes } from "./routes/health.js";
import { registerRoutes } from "./routes/register.js";
import { episodicRoutes } from "./routes/episodic.js";
import { memoryRoutes } from "./routes/memory.js";

export function createApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/", healthRoutes);
  app.route("/", registerRoutes);
  app.route("/", episodicRoutes);
  app.route("/", memoryRoutes);
  app.onError((err, c) => {
    console.error("central-plane error:", err);
    return c.json({ error: err.message || "internal error" }, 500);
  });
  app.notFound((c) => c.json({ error: "not found", path: c.req.path }, 404));
  return app;
}
