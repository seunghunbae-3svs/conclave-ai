import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../dist/router.js";
import { sha256Hex } from "../dist/util.js";

/**
 * v0.13.16 H1 #2 — `/admin/install-summary` route tests.
 *
 * One-call diagnostic that backs `conclave status`. Bearer-CONCLAVE_TOKEN
 * gate (parity with /admin/webhook-status). Returns bot identity +
 * webhook health + linked-chat count + recent cycles.
 */

const KNOWN_TOKEN = "c_known_test_token_for_summary";
const KNOWN_HASH = await sha256Hex(KNOWN_TOKEN);
const PROD_URL = "https://conclave-ai.seunghunbae.workers.dev/telegram/webhook";

const CTX = { waitUntil: () => {}, passThroughOnException: () => {} };

function makeMockDb({ installs, links, recents } = {}) {
  return {
    prepare(sql) {
      let bound = [];
      return {
        bind: (...args) => { bound = args; return makeStatement(sql, bound); },
      };
    },
  };
  function makeStatement(sql, bound) {
    return {
      async first() {
        if (/SELECT \* FROM installs WHERE token_hash/.test(sql)) {
          const hash = bound[0];
          const row = (installs ?? []).find((i) => i.tokenHash === hash);
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
        if (/COUNT\(\*\) AS n FROM telegram_links/.test(sql)) {
          const installId = bound[0];
          const n = (links ?? []).filter((l) => l.install_id === installId).length;
          return { n };
        }
        return null;
      },
      async run() { return { success: true }; },
      async all() {
        if (/FROM review_notify_dedupe/.test(sql)) {
          const installId = bound[0];
          const filtered = (recents ?? []).filter((r) => r.install_id === installId);
          return { results: filtered };
        }
        return { results: [] };
      },
    };
  }
}

function makeFetch(routes) {
  return async (url) => {
    const handler = routes(url);
    if (!handler) return { ok: false, status: 404, json: async () => ({}) };
    return handler;
  };
}

function makeEnv(overrides = {}) {
  return {
    DB: makeMockDb({
      installs: [{ id: "c_inst_1", repoSlug: "acme/x", tokenHash: KNOWN_HASH }],
      links: [{ install_id: "c_inst_1", chat_id: 394136249 }],
      recents: [
        { pr_number: 35, episodic_id: "ep-aaa", notified_at: "2026-04-27T03:39:35Z", install_id: "c_inst_1" },
        { pr_number: 32, episodic_id: "ep-bbb", notified_at: "2026-04-27T00:19:41Z", install_id: "c_inst_1" },
      ],
    }),
    ENVIRONMENT: "test",
    TELEGRAM_BOT_TOKEN: "test-bot",
    ...overrides,
  };
}

async function call(app, env, headers = {}) {
  return app.fetch(
    new Request("http://x/admin/install-summary", { headers }),
    env,
    CTX,
  );
}

test("GET /admin/install-summary: 401 without Bearer", async () => {
  const res = await call(createApp(), makeEnv());
  assert.equal(res.status, 401);
});

test("GET /admin/install-summary: 401 with unknown token", async () => {
  const res = await call(createApp(), makeEnv(), { authorization: "Bearer wrong" });
  assert.equal(res.status, 401);
});

test("GET /admin/install-summary: happy path returns the full envelope", async () => {
  const fetchImpl = makeFetch((url) => {
    if (url.endsWith("/getMe")) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          result: { id: 8718593602, username: "Conclave_AI", first_name: "Conclave" },
        }),
      };
    }
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
  const app = createApp({ fetch: fetchImpl });
  const res = await call(app, makeEnv(), { authorization: `Bearer ${KNOWN_TOKEN}` });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.install.id, "c_inst_1");
  assert.equal(body.install.repo, "acme/x");
  assert.equal(body.bot.username, "Conclave_AI");
  assert.equal(body.bot.id, 8718593602);
  assert.equal(body.webhook.outcome, "bound");
  assert.equal(body.webhook.expected, PROD_URL);
  assert.equal(body.linkedChats, 1);
  assert.equal(body.recentCycles.length, 2);
  assert.equal(body.recentCycles[0].pr, 35);
});

test("GET /admin/install-summary: outcome=dropped reflects empty webhook url", async () => {
  const fetchImpl = makeFetch((url) => {
    if (url.endsWith("/getMe")) {
      return { ok: true, json: async () => ({ ok: true, result: { id: 1, username: "X", first_name: "X" } }) };
    }
    if (url.endsWith("/getWebhookInfo")) {
      return { ok: true, json: async () => ({ ok: true, result: { url: "", pending_update_count: 5 } }) };
    }
    return null;
  });
  const app = createApp({ fetch: fetchImpl });
  const res = await call(app, makeEnv(), { authorization: `Bearer ${KNOWN_TOKEN}` });
  const body = await res.json();
  assert.equal(body.webhook.outcome, "dropped");
  assert.equal(body.webhook.pendingUpdates, 5);
});

test("GET /admin/install-summary: no-bot-token when TELEGRAM_BOT_TOKEN unset", async () => {
  const env = makeEnv({});
  delete env.TELEGRAM_BOT_TOKEN;
  const res = await call(createApp(), env, { authorization: `Bearer ${KNOWN_TOKEN}` });
  const body = await res.json();
  assert.equal(body.webhook.outcome, "no-bot-token");
  assert.equal(body.bot, null);
});

test("GET /admin/install-summary: zero linked chats / zero recents render cleanly", async () => {
  const fetchImpl = makeFetch((url) => {
    if (url.endsWith("/getMe")) {
      return { ok: true, json: async () => ({ ok: true, result: { id: 1, username: "X", first_name: "X" } }) };
    }
    if (url.endsWith("/getWebhookInfo")) {
      return { ok: true, json: async () => ({ ok: true, result: { url: PROD_URL, pending_update_count: 0 } }) };
    }
    return null;
  });
  const app = createApp({ fetch: fetchImpl });
  const env = makeEnv({});
  env.DB = makeMockDb({
    installs: [{ id: "c_inst_1", repoSlug: "acme/x", tokenHash: KNOWN_HASH }],
    links: [],
    recents: [],
  });
  const res = await call(app, env, { authorization: `Bearer ${KNOWN_TOKEN}` });
  const body = await res.json();
  assert.equal(body.linkedChats, 0);
  assert.equal(body.recentCycles.length, 0);
});
