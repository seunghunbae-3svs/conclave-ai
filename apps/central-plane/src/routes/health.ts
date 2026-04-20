import { Hono } from "hono";
import type { Env } from "../env.js";

export const healthRoutes = new Hono<{ Bindings: Env }>();

healthRoutes.get("/health", (c) => {
  return c.json({
    ok: true,
    service: "conclave-central-plane",
    version: "0.4.0-alpha.1",
    environment: c.env.ENVIRONMENT ?? "unknown",
    time: new Date().toISOString(),
  });
});
