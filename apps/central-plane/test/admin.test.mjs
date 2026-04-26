import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../dist/router.js";
import { sha256Hex } from "../dist/util.js";

/**
 * v0.13.11 — `/admin/webhook-status` tests.
 *
 * The endpoint is for `conclave doctor` to verify the Telegram bot's
 * webhook URL matches what the Worker expects. Returns the bot's
 * registered url + the computed-expected url + a `matches` boolean.
 * Bot token never leaves the Worker; only the public webhook URL is
 * exposed.
 */

const KNOWN_TOKEN = "c_known_test_token";
const KNOWN_HASH = await sha256Hex(KNOWN_TOKEN);
const PROD_URL = "https://conclave-ai.seunghunbae.workers.dev/telegram/webhook";

const CTX = {
  waitUntil: () => {},
  passThroughOnException: () => {},
};

function makeMockDb(installs = []) {
  return {
    prepare(sql) {
      let bound = [];
      return {
        bind: (...args) => {
          bound = args;
          return {
            async first() {
              if (/SELECT \* FROM installs WHERE token_hash = \?/.test(sql)) {
                const hash = bound[0];
                const row = installs.find((i) => i.tokenHash === hash);
                return row
                  ? {
                      id: row.id,
                      repo_slug: row.repoSlug,
                      token_hash: row.tokenHash,
                      created_at: "2026-04-20T00:00:00Z",
                      last_seen_at: "2026-04-20T00:00:00Z",
                      status: "active",
                    }
                  : null;
              }
              return null;
            },
            async run() { return { success: true }; },
            async all() { return { results: [] }; },
          };
        },
      };
    },
  };
}

function makeFetch(routes) {
  return async (url) => {
    const handler = routes(url);
    if (!handler) return { ok: false, status: 404, json: async () => ({ ok: false }) };
    return handler;
  };
}

function makeEnv(overrides = {}) {
  return {
    DB: makeMockDb([{ id: "c_inst", repoSlug: "acme/x", tokenHash: KNOWN_HASH }]),
    ENVIRONMENT: "test",
    TELEGRAM_BOT_TOKEN: "test-bot",
    ...overrides,
  };
}

async function call(app, env, headers = {}) {
  return app.fetch(
    new Request("http://x/admin/webhook-status", { headers }),
    env,
    CTX,
  );
}

test("GET /admin/webhook-status: 401 without Bearer", async () => {
  const res = await call(createApp(), makeEnv());
  assert.equal(res.status, 401);
});

test("GET /admin/webhook-status: 401 with unknown token", async () => {
  const res = await call(createApp(), makeEnv(), { authorization: "Bearer c_wrong_token" });
  assert.equal(res.status, 401);
});

test("GET /admin/webhook-status: 200 + matches=true when webhook bound to expected URL", async () => {
  const fetchImpl = makeFetch((url) => {
    if (url.endsWith("/getWebhookInfo")) {
      return {
        ok: true,
        json: async () => ({ ok: true, result: { url: PROD_URL, pending_update_count: 0 } }),
      };
    }
    return null;
  });
  const app = createApp({ fetch: fetchImpl });
  const res = await call(app, makeEnv(), { authorization: `Bearer ${KNOWN_TOKEN}` });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.outcome, "bound");
  assert.equal(body.url, PROD_URL);
  assert.equal(body.expected, PROD_URL);
  assert.equal(body.matches, true);
});

test("GET /admin/webhook-status: matches=false (outcome=dropped) when url is empty", async () => {
  const fetchImpl = makeFetch((url) => {
    if (url.endsWith("/getWebhookInfo")) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          result: { url: "", pending_update_count: 5, last_error_message: "Wrong response from the webhook: 401" },
        }),
      };
    }
    return null;
  });
  const app = createApp({ fetch: fetchImpl });
  const res = await call(app, makeEnv(), { authorization: `Bearer ${KNOWN_TOKEN}` });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.outcome, "dropped");
  assert.equal(body.matches, false);
  assert.equal(body.url, "");
  assert.equal(body.pendingUpdateCount, 5);
  assert.match(body.lastErrorMessage, /401/);
});

test("GET /admin/webhook-status: matches=false (outcome=wrong-url) when bot points elsewhere", async () => {
  const fetchImpl = makeFetch((url) => {
    if (url.endsWith("/getWebhookInfo")) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          result: { url: "https://other.test/telegram/webhook", pending_update_count: 0 },
        }),
      };
    }
    return null;
  });
  const app = createApp({ fetch: fetchImpl });
  const res = await call(app, makeEnv(), { authorization: `Bearer ${KNOWN_TOKEN}` });
  const body = await res.json();
  assert.equal(body.outcome, "wrong-url");
  assert.equal(body.matches, false);
  assert.equal(body.url, "https://other.test/telegram/webhook");
});

test("GET /admin/webhook-status: outcome=no-bot-token when TELEGRAM_BOT_TOKEN unset", async () => {
  const env = makeEnv({});
  delete env.TELEGRAM_BOT_TOKEN;
  const res = await call(createApp(), env, { authorization: `Bearer ${KNOWN_TOKEN}` });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.outcome, "no-bot-token");
  assert.equal(body.matches, false);
});

test("GET /admin/webhook-status: outcome=telegram-unreachable when getWebhookInfo fails", async () => {
  const fetchImpl = makeFetch(() => ({ ok: false, status: 500, json: async () => ({}) }));
  const app = createApp({ fetch: fetchImpl });
  const res = await call(app, makeEnv(), { authorization: `Bearer ${KNOWN_TOKEN}` });
  const body = await res.json();
  assert.equal(body.outcome, "telegram-unreachable");
  assert.equal(body.matches, false);
});
