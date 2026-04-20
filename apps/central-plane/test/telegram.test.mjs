import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createApp } from "../dist/router.js";
import { parseCallbackData, eventTypeFor } from "../dist/telegram.js";

// v0.5 H — a valid KEK for the tests that exercise the dispatch path.
// Lazy-upgrade writes on stale plaintext rows require this to be set.
const TEST_KEK = randomBytes(32).toString("base64");

// ---- mock D1 covering installs + telegram_links -------------------------

function makeMockDb({ installs = new Map(), links = new Map() } = {}) {
  const state = {
    installs: new Map(installs),
    links: new Map(links),
  };
  return {
    state,
    prepare(sql) {
      let bound = [];
      const wrap = {
        bind: (...args) => {
          bound = args;
          return wrap;
        },
        async first() {
          if (/SELECT \* FROM installs WHERE token_hash = \?/.test(sql)) {
            for (const v of state.installs.values()) {
              if (v.tokenHash === bound[0] && v.status === "active") {
                return {
                  id: v.id,
                  repo_slug: v.repoSlug,
                  token_hash: v.tokenHash,
                  created_at: v.createdAt,
                  last_seen_at: v.lastSeenAt,
                  status: v.status,
                };
              }
            }
            return null;
          }
          if (/SELECT \* FROM telegram_links WHERE chat_id = \?/.test(sql)) {
            const row = state.links.get(bound[0]);
            return row
              ? {
                  chat_id: row.chatId,
                  install_id: row.installId,
                  linked_at: row.linkedAt,
                  user_label: row.userLabel,
                }
              : null;
          }
          if (/SELECT id, repo_slug, github_access_token, github_access_token_enc, github_token_scope FROM installs WHERE id = \?/.test(sql)) {
            for (const v of state.installs.values()) {
              if (v.id === bound[0] && v.status === "active") {
                return {
                  id: v.id,
                  repo_slug: v.repoSlug,
                  github_access_token: v.githubAccessToken ?? null,
                  github_access_token_enc: v.githubAccessTokenEnc ?? null,
                  github_token_scope: v.githubTokenScope ?? null,
                };
              }
            }
            return null;
          }
          return null;
        },
        async run() {
          if (/INSERT INTO telegram_links/.test(sql)) {
            const [chatId, installId, linkedAt, userLabel] = bound;
            state.links.set(chatId, { chatId, installId, linkedAt, userLabel });
          } else if (/UPDATE installs SET last_seen_at/.test(sql)) {
            const [lastSeenAt, id] = bound;
            for (const v of state.installs.values()) {
              if (v.id === id) v.lastSeenAt = lastSeenAt;
            }
          } else if (
            /UPDATE installs SET github_access_token_enc = \?, github_access_token = NULL WHERE id = \? AND github_access_token_enc IS NULL/.test(
              sql,
            )
          ) {
            // v0.5 H — lazy upgrade path. The telegram webhook tests
            // exercise it implicitly when `needsLazyEncrypt` is true.
            const [enc, id] = bound;
            for (const v of state.installs.values()) {
              if (v.id === id && (v.githubAccessTokenEnc ?? null) === null) {
                v.githubAccessTokenEnc = enc;
                v.githubAccessToken = null;
              }
            }
          }
          return { success: true };
        },
      };
      return wrap;
    },
  };
}

function sha256(s) {
  return createHash("sha256").update(s).digest("hex");
}

// ---- mock fetch --------------------------------------------------------

function makeFetch(handlers) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const urlStr = typeof url === "string" ? url : url.url;
    calls.push({ url: urlStr, method: init.method, body: init.body, headers: init.headers });
    for (const h of handlers) {
      if (h.match(urlStr, init)) return h.respond(urlStr, init);
    }
    // Default: 200 empty
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  fn.calls = calls;
  return fn;
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function fetchApp(app, path, init = {}, env = {}) {
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
  const req = new Request(`http://localhost${path}`, init);
  const res = await app.fetch(req, env, ctx);
  return { res, body: await res.json().catch(() => null) };
}

function makeEnvWithInstall({ token = "c_linktest_token_xyz", repo = "acme/service", github = "gho_stored" } = {}) {
  const tokenHash = sha256(token);
  const installs = new Map([[
    repo,
    {
      id: "c_install_tg1",
      repoSlug: repo,
      tokenHash,
      createdAt: "2026-04-20T00:00:00Z",
      lastSeenAt: "2026-04-20T00:00:00Z",
      status: "active",
      githubAccessToken: github,
      githubTokenScope: "repo",
    },
  ]]);
  return {
    env: {
      DB: makeMockDb({ installs }),
      ENVIRONMENT: "test",
      TELEGRAM_BOT_TOKEN: "bot-test-token",
      CONCLAVE_TOKEN_KEK: TEST_KEK,
    },
    token,
    installId: "c_install_tg1",
  };
}

// ---- parseCallbackData + eventTypeFor unit ------------------------------

test("parseCallbackData: ep:<id>:<outcome> variants", () => {
  assert.deepEqual(parseCallbackData("ep:abc123:merged"), { episodicId: "abc123", outcome: "merged" });
  assert.deepEqual(parseCallbackData("ep:id-with-dashes:reworked"), { episodicId: "id-with-dashes", outcome: "reworked" });
  assert.deepEqual(parseCallbackData("ep:a:b:c:rejected"), { episodicId: "a:b:c", outcome: "rejected" });
  assert.equal(parseCallbackData("not-ep:xxx:merged"), null);
  assert.equal(parseCallbackData("ep:xxx:bogus"), null);
  assert.equal(parseCallbackData(""), null);
  assert.equal(parseCallbackData(null), null);
});

test("eventTypeFor: outcome → conclave-* event", () => {
  assert.equal(eventTypeFor("merged"), "conclave-merge");
  assert.equal(eventTypeFor("reworked"), "conclave-rework");
  assert.equal(eventTypeFor("rejected"), "conclave-reject");
});

// ---- webhook: /start + /help ---------------------------------------------

test("POST /telegram/webhook: /start replies with onboarding text", async () => {
  const fetchMock = makeFetch([
    { match: (u) => u.includes("/sendMessage"), respond: () => json(200, { ok: true, result: {} }) },
  ]);
  const app = createApp({ fetch: fetchMock });
  const { env } = makeEnvWithInstall();
  const { res, body } = await fetchApp(app, "/telegram/webhook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      update_id: 1,
      message: { chat: { id: 42 }, text: "/start", from: { username: "bae" } },
    }),
  }, env);
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  const sent = fetchMock.calls.find((c) => c.url.includes("/sendMessage"));
  assert.ok(sent);
  const payload = JSON.parse(sent.body);
  assert.equal(payload.chat_id, 42);
  assert.ok(payload.text.includes("Conclave AI bot"));
  assert.ok(payload.text.includes("/link"));
});

// ---- webhook: /link ------------------------------------------------------

test("POST /telegram/webhook: /link <valid-token> creates telegram_link + confirms", async () => {
  const fetchMock = makeFetch([
    { match: (u) => u.includes("/sendMessage"), respond: () => json(200, { ok: true, result: {} }) },
  ]);
  const app = createApp({ fetch: fetchMock });
  const { env, token, installId } = makeEnvWithInstall();
  const { body } = await fetchApp(app, "/telegram/webhook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      update_id: 2,
      message: { chat: { id: 999 }, text: `/link ${token}`, from: { username: "bae" } },
    }),
  }, env);
  assert.equal(body.ok, true);
  // link upserted
  const link = env.DB.state.links.get(999);
  assert.ok(link, "telegram_link not created");
  assert.equal(link.installId, installId);
  assert.equal(link.userLabel, "bae");
  // confirmation message
  const sent = fetchMock.calls.find((c) => c.url.includes("/sendMessage"));
  const payload = JSON.parse(sent.body);
  assert.ok(payload.text.includes("Linked"));
  assert.ok(payload.text.includes("acme/service"));
});

test("POST /telegram/webhook: /link <bogus-token> rejects politely", async () => {
  const fetchMock = makeFetch([
    { match: (u) => u.includes("/sendMessage"), respond: () => json(200, { ok: true, result: {} }) },
  ]);
  const app = createApp({ fetch: fetchMock });
  const { env } = makeEnvWithInstall();
  await fetchApp(app, "/telegram/webhook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      update_id: 3,
      message: { chat: { id: 1000 }, text: "/link c_does_not_exist", from: { username: "bae" } },
    }),
  }, env);
  // No link created
  assert.equal(env.DB.state.links.has(1000), false);
  const sent = fetchMock.calls.find((c) => c.url.includes("/sendMessage"));
  const payload = JSON.parse(sent.body);
  assert.ok(payload.text.includes("not recognised"));
});

// ---- webhook: callback_query (button click) ------------------------------

test("POST /telegram/webhook: 🔧 click with linked chat fires repository_dispatch + acks", async () => {
  const fetchMock = makeFetch([
    {
      match: (u) => u.endsWith("/dispatches"),
      respond: () => json(200, {}),
    },
    { match: (u) => u.includes("/answerCallbackQuery"), respond: () => json(200, { ok: true }) },
  ]);
  const app = createApp({ fetch: fetchMock });
  const { env, installId } = makeEnvWithInstall();
  // Pre-seed a telegram_link for chat 500 → the test install
  env.DB.state.links.set(500, {
    chatId: 500,
    installId,
    linkedAt: "2026-04-20T00:00:00Z",
    userLabel: "bae",
  });

  const { res } = await fetchApp(app, "/telegram/webhook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      update_id: 10,
      callback_query: {
        id: "cq-123",
        data: "ep:ep-abc-def:reworked",
        from: { username: "bae" },
        message: { chat: { id: 500 } },
      },
    }),
  }, env);
  assert.equal(res.status, 200);

  const dispatchCall = fetchMock.calls.find((c) => c.url.endsWith("/dispatches"));
  assert.ok(dispatchCall, "dispatch not called");
  assert.ok(dispatchCall.url.includes("acme/service"));
  const dispatchBody = JSON.parse(dispatchCall.body);
  assert.equal(dispatchBody.event_type, "conclave-rework");
  assert.equal(dispatchBody.client_payload.episodic, "ep-abc-def");
  assert.equal(dispatchBody.client_payload.outcome, "reworked");
  assert.equal(dispatchBody.client_payload.triggeredBy, "bae");

  const ackCall = fetchMock.calls.find((c) => c.url.includes("/answerCallbackQuery"));
  assert.ok(ackCall, "callback not acked");
  const ackBody = JSON.parse(ackCall.body);
  assert.equal(ackBody.callback_query_id, "cq-123");
  assert.ok(ackBody.text.includes("conclave-rework dispatched"));
});

test("POST /telegram/webhook: ✅ click maps to conclave-merge event", async () => {
  const fetchMock = makeFetch([
    { match: (u) => u.endsWith("/dispatches"), respond: () => json(200, {}) },
    { match: (u) => u.includes("/answerCallbackQuery"), respond: () => json(200, { ok: true }) },
  ]);
  const app = createApp({ fetch: fetchMock });
  const { env, installId } = makeEnvWithInstall();
  env.DB.state.links.set(501, { chatId: 501, installId, linkedAt: "t", userLabel: null });
  await fetchApp(app, "/telegram/webhook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      update_id: 11,
      callback_query: {
        id: "cq-merge",
        data: "ep:ep-xyz:merged",
        from: { username: "bae" },
        message: { chat: { id: 501 } },
      },
    }),
  }, env);
  const dispatchCall = fetchMock.calls.find((c) => c.url.endsWith("/dispatches"));
  const body = JSON.parse(dispatchCall.body);
  assert.equal(body.event_type, "conclave-merge");
});

test("POST /telegram/webhook: click from unlinked chat → alert, no dispatch", async () => {
  const fetchMock = makeFetch([
    { match: (u) => u.includes("/answerCallbackQuery"), respond: () => json(200, { ok: true }) },
  ]);
  const app = createApp({ fetch: fetchMock });
  const { env } = makeEnvWithInstall();
  await fetchApp(app, "/telegram/webhook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      update_id: 12,
      callback_query: {
        id: "cq-noauth",
        data: "ep:ep-xxx:reworked",
        from: { username: "stranger" },
        message: { chat: { id: 99999 } },
      },
    }),
  }, env);
  const dispatchCall = fetchMock.calls.find((c) => c.url.endsWith("/dispatches"));
  assert.equal(dispatchCall, undefined, "dispatch must not fire for unlinked chat");
  const ackCall = fetchMock.calls.find((c) => c.url.includes("/answerCallbackQuery"));
  const ackBody = JSON.parse(ackCall.body);
  assert.ok(ackBody.text.includes("not linked"));
  assert.equal(ackBody.show_alert, true);
});

test("POST /telegram/webhook: click with missing GitHub token → friendly alert", async () => {
  const fetchMock = makeFetch([
    { match: (u) => u.includes("/answerCallbackQuery"), respond: () => json(200, { ok: true }) },
  ]);
  const app = createApp({ fetch: fetchMock });
  // Install exists but has NO github_access_token stored
  const tokenHash = sha256("c_no_gh_token");
  const installs = new Map([[
    "acme/y",
    {
      id: "c_no_gh",
      repoSlug: "acme/y",
      tokenHash,
      createdAt: "t",
      lastSeenAt: "t",
      status: "active",
      githubAccessToken: null,
      githubTokenScope: null,
    },
  ]]);
  const env = {
    DB: makeMockDb({
      installs,
      links: new Map([[502, { chatId: 502, installId: "c_no_gh", linkedAt: "t", userLabel: null }]]),
    }),
    ENVIRONMENT: "test",
    TELEGRAM_BOT_TOKEN: "bot-t",
  };
  await fetchApp(app, "/telegram/webhook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      update_id: 13,
      callback_query: {
        id: "cq-nogh",
        data: "ep:ep-xxx:reworked",
        from: { username: "bae" },
        message: { chat: { id: 502 } },
      },
    }),
  }, env);
  const ackCall = fetchMock.calls.find((c) => c.url.includes("/answerCallbackQuery"));
  const ackBody = JSON.parse(ackCall.body);
  assert.ok(ackBody.text.includes("missing GitHub token"));
});

test("POST /telegram/webhook: TELEGRAM_WEBHOOK_SECRET mismatch → 401", async () => {
  const fetchMock = makeFetch([]);
  const app = createApp({ fetch: fetchMock });
  const { env } = makeEnvWithInstall();
  env.TELEGRAM_WEBHOOK_SECRET = "sekret";
  const { res } = await fetchApp(app, "/telegram/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "wrong" },
    body: JSON.stringify({ update_id: 99 }),
  }, env);
  assert.equal(res.status, 401);
});

test("POST /telegram/webhook: TELEGRAM_WEBHOOK_SECRET matches → processes update", async () => {
  const fetchMock = makeFetch([
    { match: (u) => u.includes("/sendMessage"), respond: () => json(200, { ok: true, result: {} }) },
  ]);
  const app = createApp({ fetch: fetchMock });
  const { env } = makeEnvWithInstall();
  env.TELEGRAM_WEBHOOK_SECRET = "sekret";
  const { res } = await fetchApp(app, "/telegram/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "sekret" },
    body: JSON.stringify({
      update_id: 100,
      message: { chat: { id: 42 }, text: "/start", from: { username: "bae" } },
    }),
  }, env);
  assert.equal(res.status, 200);
  assert.ok(fetchMock.calls.find((c) => c.url.includes("/sendMessage")));
});
