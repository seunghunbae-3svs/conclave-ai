// v0.8 — telegram callback_query paths for the autonomy vocabulary.
//
// Separate from telegram.test.mjs so the v0.7 tests there keep locking
// the legacy 3-button vocabulary (merged / reworked / rejected) while
// this suite covers the new v0.8 actions:
//
//   - merge            → dispatch conclave-merge (safe: only shown after approve)
//   - reject           → dispatch conclave-reject
//   - merge-unsafe     → show confirmation prompt, NO dispatch yet
//   - merge-confirmed  → dispatch conclave-merge (user clicked through the warning)
//   - cancel           → no-op ack (user backed out of the unsafe confirm)
//
// Runs against the compiled dist/ (same pattern as telegram.test.mjs).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createApp } from "../dist/router.js";
import { classifyOutcome, parseCallbackData } from "../dist/telegram.js";

const TEST_KEK = randomBytes(32).toString("base64");

function sha256(s) {
  return createHash("sha256").update(s).digest("hex");
}

function makeMockDb({ installs = new Map(), links = new Map() } = {}) {
  const state = { installs: new Map(installs), links: new Map(links) };
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
          if (/UPDATE installs SET last_seen_at/.test(sql)) {
            const [lastSeenAt, id] = bound;
            for (const v of state.installs.values()) {
              if (v.id === id) v.lastSeenAt = lastSeenAt;
            }
          }
          return { success: true };
        },
      };
      return wrap;
    },
  };
}

function makeFetch(handlers) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const urlStr = typeof url === "string" ? url : url.url;
    calls.push({ url: urlStr, method: init.method, body: init.body });
    for (const h of handlers) {
      if (h.match(urlStr, init)) return h.respond(urlStr, init);
    }
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  fn.calls = calls;
  return fn;
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function fetchApp(app, path, init = {}, env = {}) {
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
  const req = new Request(`http://localhost${path}`, init);
  const res = await app.fetch(req, env, ctx);
  return { res, body: await res.json().catch(() => null) };
}

function makeEnvWithLinkedInstall({
  token = "c_cbq_token",
  repo = "acme/cbq",
  github = "gho_cbq_stored",
  chatId = 777,
} = {}) {
  const tokenHash = sha256(token);
  const installs = new Map([[
    repo,
    {
      id: "c_install_cbq",
      repoSlug: repo,
      tokenHash,
      createdAt: "2026-04-20T00:00:00Z",
      lastSeenAt: "2026-04-20T00:00:00Z",
      status: "active",
      githubAccessToken: github,
      githubTokenScope: "repo",
    },
  ]]);
  const links = new Map([[
    chatId,
    { chatId, installId: "c_install_cbq", linkedAt: "2026-04-20T00:00:00Z", userLabel: "bae" },
  ]]);
  return {
    env: {
      DB: makeMockDb({ installs, links }),
      ENVIRONMENT: "test",
      TELEGRAM_BOT_TOKEN: "bot-cbq-token",
      CONCLAVE_TOKEN_KEK: TEST_KEK,
    },
    token,
    installId: "c_install_cbq",
    chatId,
  };
}

// ---- classifyOutcome unit table -----------------------------------------

test("classifyOutcome: v0.8 vocabulary maps to the right kinds", () => {
  assert.deepEqual(classifyOutcome("merge"), { kind: "dispatch", eventType: "conclave-merge" });
  assert.deepEqual(classifyOutcome("merge-confirmed"), { kind: "dispatch", eventType: "conclave-merge" });
  assert.deepEqual(classifyOutcome("reject"), { kind: "dispatch", eventType: "conclave-reject" });
  assert.deepEqual(classifyOutcome("merge-unsafe"), { kind: "confirm-unsafe" });
  assert.deepEqual(classifyOutcome("cancel"), { kind: "cancel" });
  // Legacy v0.7 vocab still dispatches — backward compat.
  assert.deepEqual(classifyOutcome("merged"), { kind: "dispatch", eventType: "conclave-merge" });
  assert.deepEqual(classifyOutcome("reworked"), { kind: "dispatch", eventType: "conclave-rework" });
  assert.deepEqual(classifyOutcome("rejected"), { kind: "dispatch", eventType: "conclave-reject" });
});

// ---- merge (safe) --------------------------------------------------------

test("callback merge (safe) → dispatches conclave-merge + acks", async () => {
  const fetchMock = makeFetch([
    { match: (u) => u.endsWith("/dispatches"), respond: () => json(200, {}) },
    { match: (u) => u.includes("/answerCallbackQuery"), respond: () => json(200, { ok: true }) },
  ]);
  const app = createApp({ fetch: fetchMock });
  const { env } = makeEnvWithLinkedInstall();

  const { res } = await fetchApp(app, "/telegram/webhook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      update_id: 7001,
      callback_query: {
        id: "cq-merge-safe",
        data: "ep:ep-happy:merge",
        from: { username: "bae" },
        message: { chat: { id: 777 } },
      },
    }),
  }, env);

  assert.equal(res.status, 200);
  const dispatch = fetchMock.calls.find((c) => c.url.endsWith("/dispatches"));
  assert.ok(dispatch, "dispatch not fired");
  const body = JSON.parse(dispatch.body);
  assert.equal(body.event_type, "conclave-merge");
  assert.equal(body.client_payload.outcome, "merge");
  assert.equal(body.client_payload.episodic, "ep-happy");
  const ack = fetchMock.calls.find((c) => c.url.includes("/answerCallbackQuery"));
  assert.ok(ack);
  const ackBody = JSON.parse(ack.body);
  assert.ok(ackBody.text.includes("conclave-merge"));
});

// ---- reject -------------------------------------------------------------

test("callback reject → dispatches conclave-reject", async () => {
  const fetchMock = makeFetch([
    { match: (u) => u.endsWith("/dispatches"), respond: () => json(200, {}) },
    { match: (u) => u.includes("/answerCallbackQuery"), respond: () => json(200, { ok: true }) },
  ]);
  const app = createApp({ fetch: fetchMock });
  const { env } = makeEnvWithLinkedInstall();

  await fetchApp(app, "/telegram/webhook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      update_id: 7002,
      callback_query: {
        id: "cq-rej",
        data: "ep:ep-reject:reject",
        from: { username: "bae" },
        message: { chat: { id: 777 } },
      },
    }),
  }, env);

  const dispatch = fetchMock.calls.find((c) => c.url.endsWith("/dispatches"));
  assert.ok(dispatch);
  const body = JSON.parse(dispatch.body);
  assert.equal(body.event_type, "conclave-reject");
});

// ---- merge-unsafe (two-step) --------------------------------------------

test("callback merge-unsafe → prompts confirmation + does NOT dispatch", async () => {
  const fetchMock = makeFetch([
    {
      match: (u) => u.includes("/sendMessage"),
      respond: () => json(200, { ok: true, result: {} }),
    },
    {
      match: (u) => u.includes("/answerCallbackQuery"),
      respond: () => json(200, { ok: true }),
    },
    // Any unexpected dispatch call should fail the test — the unsafe path
    // must NOT dispatch until the user clicks merge-confirmed.
    {
      match: (u) => u.endsWith("/dispatches"),
      respond: () => {
        throw new Error("merge-unsafe must not dispatch until confirmed");
      },
    },
  ]);
  const app = createApp({ fetch: fetchMock });
  const { env } = makeEnvWithLinkedInstall();

  const { res } = await fetchApp(app, "/telegram/webhook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      update_id: 7003,
      callback_query: {
        id: "cq-unsafe",
        data: "ep:ep-unsafe:merge-unsafe",
        from: { username: "bae" },
        message: { chat: { id: 777 } },
      },
    }),
  }, env);

  assert.equal(res.status, 200);
  const dispatchCall = fetchMock.calls.find((c) => c.url.endsWith("/dispatches"));
  assert.equal(dispatchCall, undefined, "dispatch must not fire on merge-unsafe");

  const prompt = fetchMock.calls.find((c) => c.url.includes("/sendMessage"));
  assert.ok(prompt, "confirmation prompt not sent");
  const promptBody = JSON.parse(prompt.body);
  assert.ok(promptBody.text.includes("Unresolved"), `prompt body: ${promptBody.text}`);
  // Must include both Yes/Cancel buttons with the right callback vocab
  assert.ok(promptBody.reply_markup?.inline_keyboard, "keyboard missing");
  const flatCbs = promptBody.reply_markup.inline_keyboard
    .flat()
    .map((b) => b.callback_data);
  assert.ok(flatCbs.some((cb) => cb.endsWith(":merge-confirmed")), "no merge-confirmed button");
  assert.ok(flatCbs.some((cb) => cb.endsWith(":cancel")), "no cancel button");
});

// ---- merge-confirmed ----------------------------------------------------

test("callback merge-confirmed → dispatches conclave-merge (bypass review gate)", async () => {
  const fetchMock = makeFetch([
    { match: (u) => u.endsWith("/dispatches"), respond: () => json(200, {}) },
    { match: (u) => u.includes("/answerCallbackQuery"), respond: () => json(200, { ok: true }) },
  ]);
  const app = createApp({ fetch: fetchMock });
  const { env } = makeEnvWithLinkedInstall();

  await fetchApp(app, "/telegram/webhook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      update_id: 7004,
      callback_query: {
        id: "cq-confirm",
        data: "ep:ep-confirm:merge-confirmed",
        from: { username: "bae" },
        message: { chat: { id: 777 } },
      },
    }),
  }, env);

  const dispatch = fetchMock.calls.find((c) => c.url.endsWith("/dispatches"));
  assert.ok(dispatch);
  const body = JSON.parse(dispatch.body);
  assert.equal(body.event_type, "conclave-merge");
  assert.equal(body.client_payload.outcome, "merge-confirmed");
});

// ---- cancel -------------------------------------------------------------

test("callback cancel → no dispatch, ack 'Cancelled'", async () => {
  const fetchMock = makeFetch([
    { match: (u) => u.includes("/answerCallbackQuery"), respond: () => json(200, { ok: true }) },
    {
      match: (u) => u.endsWith("/dispatches"),
      respond: () => {
        throw new Error("cancel must not dispatch");
      },
    },
  ]);
  const app = createApp({ fetch: fetchMock });
  const { env } = makeEnvWithLinkedInstall();

  await fetchApp(app, "/telegram/webhook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      update_id: 7005,
      callback_query: {
        id: "cq-cancel",
        data: "ep:ep-cancel:cancel",
        from: { username: "bae" },
        message: { chat: { id: 777 } },
      },
    }),
  }, env);

  const dispatchCall = fetchMock.calls.find((c) => c.url.endsWith("/dispatches"));
  assert.equal(dispatchCall, undefined, "dispatch must not fire on cancel");
  const ack = fetchMock.calls.find((c) => c.url.includes("/answerCallbackQuery"));
  assert.ok(ack);
  const ackBody = JSON.parse(ack.body);
  assert.equal(ackBody.text, "Cancelled");
});

// ---- parse edge cases for v0.8 vocab ------------------------------------

test("parseCallbackData: accepts merge / reject / merge-unsafe / merge-confirmed / cancel", () => {
  for (const action of ["merge", "reject", "merge-unsafe", "merge-confirmed", "cancel"]) {
    const parsed = parseCallbackData(`ep:ep-xyz:${action}`);
    assert.deepEqual(parsed, { episodicId: "ep-xyz", outcome: action }, `action=${action}`);
  }
  assert.equal(parseCallbackData("ep:ep-xyz:not-a-real-action"), null);
});
