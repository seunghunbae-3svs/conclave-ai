import { Hono } from "hono";
import type { Env } from "../env.js";

export const healthRoutes = new Hono<{ Bindings: Env }>();

/**
 * v0.4 legacy — `/health` returns the same envelope. Kept for any
 * monitoring already wired to that path. New monitoring should use
 * `/healthz` (v0.11) which is the convention adopted across the rest of
 * the platform footprint.
 */
healthRoutes.get("/health", (c) => {
  return c.json({
    ok: true,
    service: "conclave-central-plane",
    version: "0.11.0",
    environment: c.env.ENVIRONMENT ?? "unknown",
    time: new Date().toISOString(),
  });
});

/**
 * v0.11 — `/healthz` is the K8s/uptime-monitor convention. Returns the
 * same envelope as `/health` plus a cheap D1 ping so an incident on the
 * D1 binding actually surfaces as an unhealthy probe instead of a green
 * worker that 500s on its first real query.
 *
 * The D1 ping is `SELECT 1` — sub-millisecond on a healthy binding,
 * fails fast on connection issues. We treat a ping failure as
 * `db: "down"` rather than HTTP 5xx, so the monitor sees the worker
 * itself responding (the issue is with a downstream binding, not the
 * Worker boot path) — separates "edge runtime broken" from "DB broken".
 */
healthRoutes.get("/healthz", async (c) => {
  let dbStatus: "up" | "down" | "unknown" = "unknown";
  try {
    const ping = await c.env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    dbStatus = ping && ping.ok === 1 ? "up" : "down";
  } catch (err) {
    console.warn("/healthz db ping failed:", err);
    dbStatus = "down";
  }
  return c.json({
    ok: dbStatus !== "down",
    service: "conclave-central-plane",
    version: "0.11.0",
    environment: c.env.ENVIRONMENT ?? "unknown",
    db: dbStatus,
    time: new Date().toISOString(),
  });
});
