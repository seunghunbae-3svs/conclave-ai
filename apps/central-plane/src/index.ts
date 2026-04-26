import { createApp } from "./router.js";
import type { Env } from "./env.js";
import { assertPreflight } from "./preflight.js";
import { selfHealWebhook } from "./webhook-heal.js";

const app = createApp();

// Module-scoped cache: run the preflight once per isolate. The key is
// the KEK value so that a secret rotation restarts the check on the
// next request — cheap and safe. Sentinel distinguishes "never checked"
// from "checked with undefined".
const UNCHECKED = Symbol("unchecked");
let preflightCheckedFor: string | null | typeof UNCHECKED = UNCHECKED;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const kek = env.CONCLAVE_TOKEN_KEK ?? null;
    if (preflightCheckedFor === UNCHECKED || preflightCheckedFor !== kek) {
      assertPreflight(env);
      preflightCheckedFor = kek;
    }
    return app.fetch(request, env, ctx);
  },
  /**
   * v0.13.7 — scheduled handler for the webhook self-heal cron.
   * Triggered by the [triggers].crons schedule in wrangler.toml.
   * Idempotent: only re-binds when Telegram has dropped the webhook.
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const result = await selfHealWebhook(env);
    // Log structured outcome so wrangler tail / observability shows
    // exactly what happened. The scheduled trigger doesn't return data
    // to anyone, but the log is the audit trail.
    console.log(JSON.stringify({
      cron: "webhook-self-heal",
      cronExpression: event.cron,
      ...result,
    }));
  },
};

export { createApp } from "./router.js";
export type { Env } from "./env.js";
