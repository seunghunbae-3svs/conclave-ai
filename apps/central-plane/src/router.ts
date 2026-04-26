import { Hono } from "hono";
import type { Env } from "./env.js";
import { healthRoutes } from "./routes/health.js";
import { registerRoutes } from "./routes/register.js";
import { episodicRoutes } from "./routes/episodic.js";
import { episodicAnchorRoutes } from "./routes/episodic-anchor.js";
import { memoryRoutes } from "./routes/memory.js";
import { createOAuthRoutes } from "./routes/oauth.js";
import { createTelegramRoutes } from "./routes/telegram.js";
import { createReviewRoutes } from "./routes/review.js";
import { createAdminRoutes } from "./routes/admin.js";
import type { FetchLike } from "./github.js";

/**
 * v0.7.3 — explicitly bind globalThis.fetch at app-construction time.
 * When tests inject `opts.fetch`, we use theirs as-is (they're plain
 * functions, not platform natives). When production calls
 * `createApp()` with no fetch, we hand every route factory a PROPERLY
 * BOUND native fetch so downstream clients (TelegramClient,
 * dispatchRepositoryEvent, OAuth flows) never see the unbound
 * platform reference.
 *
 * Why: native `fetch` on Cloudflare Workers throws
 * "Illegal invocation" when invoked with `this !== globalThis`. The
 * v0.7.2 hotfix addressed this inside TelegramClient by re-binding
 * defensively when `opts.fetch` was absent — but in production the
 * fetch IS passed through the factory chain (opts.fetch →
 * createReviewRoutes(opts.fetch) → new TelegramClient({ fetch:
 * fetchImpl })), so `opts.fetch` was never absent, the defensive
 * re-bind never fired, and outgoing Telegram messages silently
 * failed. Fixing it at the top of the chain is the right
 * architectural layer — downstream code can trust what it's given.
 */
export function createApp(opts: { fetch?: FetchLike } = {}): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  const fetchImpl: FetchLike = opts.fetch ?? (fetch.bind(globalThis) as FetchLike);
  app.route("/", healthRoutes);
  app.route("/", registerRoutes);
  app.route("/", episodicRoutes);
  app.route("/", episodicAnchorRoutes);
  app.route("/", memoryRoutes);
  app.route("/", createOAuthRoutes(fetchImpl));
  app.route("/", createTelegramRoutes(fetchImpl));
  app.route("/", createReviewRoutes(fetchImpl));
  app.route("/", createAdminRoutes(fetchImpl as typeof fetch));
  app.onError((err, c) => {
    console.error("central-plane error:", err);
    return c.json({ error: err.message || "internal error" }, 500);
  });
  app.notFound((c) => c.json({ error: "not found", path: c.req.path }, 404));
  return app;
}
