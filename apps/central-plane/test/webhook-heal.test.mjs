import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveWebhookUrl,
  checkWebhookBound,
  rebindWebhook,
  selfHealWebhook,
} from "../dist/webhook-heal.js";

/**
 * v0.13.7 — webhook self-heal tests.
 *
 * Live regression: the @BAE_DUAL_bot webhook kept clearing itself
 * because some consumer (stale workflow / dev tool) was calling
 * getUpdates on the same bot token. Telegram drops the registered
 * webhook on every getUpdates call. The Worker's scheduled cron
 * checks getWebhookInfo and re-binds when the URL has fallen off.
 */

function mockFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const handler = routes(url, init);
    if (!handler) {
      return {
        ok: false,
        status: 404,
        json: async () => ({ ok: false, description: "no mock" }),
        text: async () => "no mock",
      };
    }
    return handler;
  };
  fn.calls = calls;
  return fn;
}

const BOT_TOKEN = "test-bot-token";
const SECRET = "test-secret-token";
const PROD_URL = "https://conclave-ai.seunghunbae.workers.dev/telegram/webhook";

// ---- 1. resolveWebhookUrl ------------------------------------------------

test("resolveWebhookUrl: defaults to production base URL", () => {
  const env = { TELEGRAM_BOT_TOKEN: BOT_TOKEN };
  assert.equal(resolveWebhookUrl(env), PROD_URL);
});

test("resolveWebhookUrl: honours PUBLIC_BASE_URL override", () => {
  const env = { PUBLIC_BASE_URL: "https://staging.example.test" };
  assert.equal(resolveWebhookUrl(env), "https://staging.example.test/telegram/webhook");
});

test("resolveWebhookUrl: strips trailing slash from override", () => {
  const env = { PUBLIC_BASE_URL: "https://x.test/" };
  assert.equal(resolveWebhookUrl(env), "https://x.test/telegram/webhook");
});

// ---- 2. checkWebhookBound -------------------------------------------------

test("checkWebhookBound: parses url + pending_update_count", async () => {
  const fetchFn = mockFetch((url) => {
    if (url.endsWith("/getWebhookInfo")) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          result: { url: PROD_URL, pending_update_count: 3 },
        }),
      };
    }
    return null;
  });
  const info = await checkWebhookBound(BOT_TOKEN, fetchFn);
  assert.equal(info.url, PROD_URL);
  assert.equal(info.pending_update_count, 3);
});

test("checkWebhookBound: returns null on Telegram failure", async () => {
  const fetchFn = mockFetch(() => ({
    ok: false,
    json: async () => ({ ok: false }),
  }));
  const info = await checkWebhookBound(BOT_TOKEN, fetchFn);
  assert.equal(info, null);
});

// ---- 3. rebindWebhook -----------------------------------------------------

test("rebindWebhook: POSTs setWebhook with secret_token + allowed_updates", async () => {
  const fetchFn = mockFetch((url, init) => {
    if (url.endsWith("/setWebhook")) {
      const body = JSON.parse(init.body);
      // Verify the call shape — Telegram ignores extra fields, but
      // we contractually require these to be present.
      assert.equal(body.url, PROD_URL);
      assert.equal(body.secret_token, SECRET);
      assert.deepEqual(body.allowed_updates, ["message", "callback_query"]);
      assert.equal(body.drop_pending_updates, false);
      return {
        ok: true,
        json: async () => ({ ok: true, result: true, description: "Webhook was set" }),
      };
    }
    return null;
  });
  const result = await rebindWebhook(BOT_TOKEN, PROD_URL, SECRET, fetchFn);
  assert.equal(result.ok, true);
});

// ---- 4. selfHealWebhook (top-level orchestration) ------------------------

test("selfHealWebhook: skipped when TELEGRAM_BOT_TOKEN unset", async () => {
  const fetchFn = mockFetch(() => null);
  const result = await selfHealWebhook({}, fetchFn);
  assert.equal(result.outcome, "skipped");
  assert.match(result.reason, /TELEGRAM_BOT_TOKEN/);
  assert.equal(fetchFn.calls.length, 0);
});

test("selfHealWebhook: skipped when TELEGRAM_WEBHOOK_SECRET unset", async () => {
  const fetchFn = mockFetch(() => null);
  const result = await selfHealWebhook({ TELEGRAM_BOT_TOKEN: BOT_TOKEN }, fetchFn);
  assert.equal(result.outcome, "skipped");
  assert.match(result.reason, /TELEGRAM_WEBHOOK_SECRET/);
});

test("selfHealWebhook: bound-already when getWebhookInfo url matches expected", async () => {
  const fetchFn = mockFetch((url) => {
    if (url.endsWith("/getWebhookInfo")) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          result: { url: PROD_URL, pending_update_count: 0 },
        }),
      };
    }
    return null;
  });
  const result = await selfHealWebhook(
    { TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET },
    fetchFn,
  );
  assert.equal(result.outcome, "bound-already");
  assert.equal(result.actual, PROD_URL);
  assert.equal(result.pendingUpdateCount, 0);
  // Only ONE call (getWebhookInfo); no setWebhook.
  assert.equal(fetchFn.calls.length, 1);
  assert.match(fetchFn.calls[0].url, /\/getWebhookInfo$/);
});

test("selfHealWebhook: rebinds when url is empty (Telegram dropped it)", async () => {
  const fetchFn = mockFetch((url) => {
    if (url.endsWith("/getWebhookInfo")) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          result: {
            url: "",
            pending_update_count: 0,
            last_error_message: "Wrong response from the webhook: 401",
          },
        }),
      };
    }
    if (url.endsWith("/setWebhook")) {
      return {
        ok: true,
        json: async () => ({ ok: true, result: true }),
      };
    }
    return null;
  });
  const result = await selfHealWebhook(
    { TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET },
    fetchFn,
  );
  assert.equal(result.outcome, "rebound");
  assert.equal(result.actual, null);
  assert.match(result.lastErrorMessage, /401/);
  assert.equal(fetchFn.calls.length, 2);
});

test("selfHealWebhook: rebinds when url points to a different worker", async () => {
  const fetchFn = mockFetch((url) => {
    if (url.endsWith("/getWebhookInfo")) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          result: { url: "https://other-worker.test/telegram/webhook", pending_update_count: 0 },
        }),
      };
    }
    if (url.endsWith("/setWebhook")) {
      return { ok: true, json: async () => ({ ok: true, result: true }) };
    }
    return null;
  });
  const result = await selfHealWebhook(
    { TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET },
    fetchFn,
  );
  assert.equal(result.outcome, "rebound");
  assert.equal(result.actual, "https://other-worker.test/telegram/webhook");
});

test("selfHealWebhook: failed when setWebhook returns ok=false", async () => {
  const fetchFn = mockFetch((url) => {
    if (url.endsWith("/getWebhookInfo")) {
      return {
        ok: true,
        json: async () => ({ ok: true, result: { url: "", pending_update_count: 0 } }),
      };
    }
    if (url.endsWith("/setWebhook")) {
      return {
        ok: true,
        json: async () => ({
          ok: false,
          description: "Bad Request: HTTPS url must be provided for webhook",
        }),
      };
    }
    return null;
  });
  const result = await selfHealWebhook(
    { TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET },
    fetchFn,
  );
  assert.equal(result.outcome, "failed");
  assert.match(result.rebindError, /HTTPS/);
});

test("selfHealWebhook: failed when getWebhookInfo itself fails", async () => {
  const fetchFn = mockFetch(() => ({ ok: false, json: async () => ({}) }));
  const result = await selfHealWebhook(
    { TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET },
    fetchFn,
  );
  assert.equal(result.outcome, "failed");
  assert.match(result.reason, /getWebhookInfo/);
});
