import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createApp } from "../dist/router.js";

// ---- mock D1 covering installs + telegram_links (all + first) -----------

function makeMockDb({ installs = new Map(), links = [] } = {}) {
  const state = {
    installs: new Map(installs),
    // links is a flat array of { chatId, installId, linkedAt, userLabel }
    links: [...links],
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
          return null;
        },
        async all() {
          if (/SELECT chat_id FROM telegram_links WHERE install_id = \?/.test(sql)) {
            const installId = bound[0];
            const results = state.links
              .filter((l) => l.installId === installId)
              .map((l) => ({ chat_id: l.chatId }));
            return { results, success: true };
          }
          return { results: [], success: true };
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

function sha256(s) {
  return createHash("sha256").update(s).digest("hex");
}

function makeFetch(handlers) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const urlStr = typeof url === "string" ? url : url.url;
    calls.push({ url: urlStr, method: init.method, body: init.body, headers: init.headers });
    for (const h of handlers) {
      if (h.match(urlStr, init)) return h.respond(urlStr, init);
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
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

// ---- fixtures ------------------------------------------------------------

function makeEnv({ token = "c_rev_token_ok", repo = "acme/app", chatIds = [] } = {}) {
  const tokenHash = sha256(token);
  const installId = "c_install_rev1";
  const installs = new Map([[
    repo,
    {
      id: installId,
      repoSlug: repo,
      tokenHash,
      createdAt: "2026-04-20T00:00:00Z",
      lastSeenAt: "2026-04-20T00:00:00Z",
      status: "active",
    },
  ]]);
  const links = chatIds.map((cid) => ({
    chatId: cid,
    installId,
    linkedAt: "2026-04-20T00:00:00Z",
    userLabel: null,
  }));
  return {
    env: {
      DB: makeMockDb({ installs, links }),
      ENVIRONMENT: "test",
      TELEGRAM_BOT_TOKEN: "bot-rev-token",
    },
    token,
    installId,
    repo,
  };
}

// ---- tests ---------------------------------------------------------------

test("POST /review/notify: wrong bearer token → 401 and no dispatch", async () => {
  const fetchMock = makeFetch([
    { match: (u) => u.includes("/sendMessage"), respond: () => json(200, { ok: true }) },
  ]);
  const app = createApp({ fetch: fetchMock });
  const { env } = makeEnv({ chatIds: [42] });
  const { res, body } = await fetchApp(
    app,
    "/review/notify",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer c_not_the_right_token",
      },
      body: JSON.stringify({ repo_slug: "acme/app", message: "hi" }),
    },
    env,
  );
  assert.equal(res.status, 401);
  assert.ok(body.error);
  const sent = fetchMock.calls.find((c) => c.url.includes("/sendMessage"));
  assert.equal(sent, undefined, "no sendMessage should fire on auth failure");
});

test("POST /review/notify: missing Authorization header → 401", async () => {
  const fetchMock = makeFetch([]);
  const app = createApp({ fetch: fetchMock });
  const { env } = makeEnv();
  const { res } = await fetchApp(
    app,
    "/review/notify",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo_slug: "acme/app", message: "hi" }),
    },
    env,
  );
  assert.equal(res.status, 401);
});

test("POST /review/notify: valid token + 1 linked chat → 1 dispatch + ok body", async () => {
  const fetchMock = makeFetch([
    { match: (u) => u.includes("/sendMessage"), respond: () => json(200, { ok: true, result: {} }) },
  ]);
  const app = createApp({ fetch: fetchMock });
  const { env, token } = makeEnv({ chatIds: [777] });
  const { res, body } = await fetchApp(
    app,
    "/review/notify",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      // v0.8 — omit `verdict` so this test exercises the LEGACY fallback
      // (message pass-through + 3-button keyboard). Verdict-carrying
      // requests are covered by review-notify-autonomy.test.mjs.
      body: JSON.stringify({
        repo_slug: "acme/app",
        message: "🏛️ review complete",
        pr_number: 42,
        episodic_id: "ep-happy-1",
      }),
    },
    env,
  );
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.delivered, 1);
  const sends = fetchMock.calls.filter((c) => c.url.includes("/sendMessage"));
  assert.equal(sends.length, 1);
  const payload = JSON.parse(sends[0].body);
  assert.equal(payload.chat_id, 777);
  assert.equal(payload.text, "🏛️ review complete");
  assert.equal(payload.parse_mode, "HTML");
  // episodic_id present → legacy inline keyboard attached
  assert.ok(payload.reply_markup);
  const kb = payload.reply_markup.inline_keyboard;
  assert.ok(Array.isArray(kb) && Array.isArray(kb[0]) && kb[0].length === 3);
  const callbacks = kb[0].map((b) => b.callback_data);
  assert.ok(callbacks.some((d) => d === "ep:ep-happy-1:reworked"));
  assert.ok(callbacks.some((d) => d === "ep:ep-happy-1:merged"));
  assert.ok(callbacks.some((d) => d === "ep:ep-happy-1:rejected"));
});

test("POST /review/notify: no linked chats → ok with delivered: 0 + reason", async () => {
  const fetchMock = makeFetch([
    { match: (u) => u.includes("/sendMessage"), respond: () => json(200, { ok: true }) },
  ]);
  const app = createApp({ fetch: fetchMock });
  const { env, token } = makeEnv({ chatIds: [] });
  const { res, body } = await fetchApp(
    app,
    "/review/notify",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ repo_slug: "acme/app", message: "x" }),
    },
    env,
  );
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.delivered, 0);
  // v0.7.5 — reason is now a machine-readable snake_case token so the
  // CLI / future dashboards can branch on it without string-matching.
  assert.equal(body.reason, "no_linked_chat");
  assert.ok(typeof body.hint === "string" && body.hint.length > 0);
  const sent = fetchMock.calls.find((c) => c.url.includes("/sendMessage"));
  assert.equal(sent, undefined);
});

test("POST /review/notify: no episodic_id → no inline keyboard on message", async () => {
  const fetchMock = makeFetch([
    { match: (u) => u.includes("/sendMessage"), respond: () => json(200, { ok: true }) },
  ]);
  const app = createApp({ fetch: fetchMock });
  const { env, token } = makeEnv({ chatIds: [123] });
  await fetchApp(
    app,
    "/review/notify",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ repo_slug: "acme/app", message: "bare" }),
    },
    env,
  );
  const sent = fetchMock.calls.find((c) => c.url.includes("/sendMessage"));
  const payload = JSON.parse(sent.body);
  assert.equal(payload.reply_markup, undefined);
});

test("POST /review/notify: malformed body → 400", async () => {
  const fetchMock = makeFetch([]);
  const app = createApp({ fetch: fetchMock });
  const { env, token } = makeEnv();
  const { res } = await fetchApp(
    app,
    "/review/notify",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ repo_slug: "acme/app" }), // missing message
    },
    env,
  );
  assert.equal(res.status, 400);
});

test("POST /review/notify: invalid verdict value → 400", async () => {
  const fetchMock = makeFetch([]);
  const app = createApp({ fetch: fetchMock });
  const { env, token } = makeEnv({ chatIds: [1] });
  const { res } = await fetchApp(
    app,
    "/review/notify",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ repo_slug: "acme/app", message: "x", verdict: "approved-ish" }),
    },
    env,
  );
  assert.equal(res.status, 400);
});

test("POST /review/notify: valid token → last_seen_at is bumped", async () => {
  const fetchMock = makeFetch([
    { match: (u) => u.includes("/sendMessage"), respond: () => json(200, { ok: true }) },
  ]);
  const app = createApp({ fetch: fetchMock });
  const { env, token, installId } = makeEnv({ chatIds: [5] });
  const before = [...env.DB.state.installs.values()][0].lastSeenAt;
  await fetchApp(
    app,
    "/review/notify",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ repo_slug: "acme/app", message: "tick" }),
    },
    env,
  );
  const after = [...env.DB.state.installs.values()].find((v) => v.id === installId).lastSeenAt;
  assert.notEqual(after, before, "last_seen_at should advance");
});

// ---- plain summary (v0.6.1) --------------------------------------------

test("POST /review/notify: accepts plain_summary in body and dispatches normally", async () => {
  const fetchMock = makeFetch([
    { match: (u) => u.includes("/sendMessage"), respond: () => json(200, { ok: true, result: {} }) },
  ]);
  const app = createApp({ fetch: fetchMock });
  const { env, token } = makeEnv({ chatIds: [9999] });
  const { res, body } = await fetchApp(
    app,
    "/review/notify",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        repo_slug: "acme/app",
        message: "Plain text goes here.",
        plain_summary: {
          whatChanged: "Small UI tweak across the badge page.",
          verdictInPlain: "One visual issue to fix before release.",
          nextAction: "Tighten contrast and re-check on mobile.",
          locale: "en",
        },
      }),
    },
    env,
  );
  assert.equal(res.status, 200);
  assert.equal(body.delivered, 1);
  const sends = fetchMock.calls.filter((c) => c.url.includes("/sendMessage"));
  assert.equal(sends.length, 1);
  // Body already contains the plain prose — central plane does not re-render.
  const payload = JSON.parse(sends[0].body);
  assert.equal(payload.text, "Plain text goes here.");
});

test("POST /review/notify: malformed plain_summary.locale → 400", async () => {
  const fetchMock = makeFetch([]);
  const app = createApp({ fetch: fetchMock });
  const { env, token } = makeEnv({ chatIds: [42] });
  const { res, body } = await fetchApp(
    app,
    "/review/notify",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        repo_slug: "acme/app",
        message: "hi",
        plain_summary: {
          whatChanged: "a",
          verdictInPlain: "b",
          nextAction: "c",
          locale: "jp", // invalid
        },
      }),
    },
    env,
  );
  assert.equal(res.status, 400);
  assert.match(body.error, /plain_summary\.locale/);
});
