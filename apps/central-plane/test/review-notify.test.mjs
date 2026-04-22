import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import { createApp } from "../dist/router.js";

/**
 * v0.7.3 — live-fetch regression for the /review/notify this-binding
 * bug. These tests deliberately DO NOT inject a mock fetch. They run
 * the app through the exact codepath production uses (createApp()
 * with no args → default fetch.bind(globalThis) → route factories →
 * TelegramClient → globalThis.fetch). A local HTTP server stands in
 * for api.telegram.org via the `TELEGRAM_API_BASE` env override the
 * central plane honours (see below).
 *
 * If the "Illegal invocation" bug from v0.7.2's webhook path ever
 * resurfaces on /review/notify, these tests fail.
 */

// ---- mock D1 (installs + telegram_links) --------------------------------

function makeMockDb({ installs = new Map(), links = [], dedupe = [] } = {}) {
  const state = {
    installs: new Map(installs),
    links: [...links],
    // v0.7.5 — review_notify_dedupe mock. Key: `${install_id}|${episodic_id}|${repo_slug}`.
    dedupe: new Map(dedupe.map((d) => [`${d.installId}|${d.episodicId}|${d.repoSlug}`, d])),
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
          if (/SELECT notified_at, delivered FROM review_notify_dedupe/.test(sql)) {
            const [installId, episodicId, repoSlug] = bound;
            const row = state.dedupe.get(`${installId}|${episodicId}|${repoSlug}`);
            return row
              ? { notified_at: row.notifiedAt, delivered: row.delivered }
              : null;
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
          } else if (/INSERT INTO review_notify_dedupe/.test(sql)) {
            const [installId, episodicId, repoSlug, prNumber, notifiedAt, delivered] = bound;
            state.dedupe.set(`${installId}|${episodicId}|${repoSlug}`, {
              installId,
              episodicId,
              repoSlug,
              prNumber,
              notifiedAt,
              delivered,
            });
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

function makeEnv({ token = "c_rev_live_ok", repo = "acme/app", chatIds = [] } = {}) {
  const tokenHash = sha256(token);
  const installId = "c_install_live1";
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
  }));
  return {
    env: {
      DB: makeMockDb({ installs, links }),
      ENVIRONMENT: "test",
      TELEGRAM_BOT_TOKEN: "bot-live-token",
    },
    token,
    installId,
    repo,
  };
}

async function fetchApp(app, path, init = {}, env = {}) {
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
  const req = new Request(`http://localhost${path}`, init);
  const res = await app.fetch(req, env, ctx);
  return { res, body: await res.json().catch(() => null) };
}

// ---- local Telegram stand-in server --------------------------------------
//
// We spin up an HTTP server that captures every sendMessage call, and
// monkey-patch globalThis.fetch to REDIRECT requests for
// api.telegram.org to this local server. This keeps the app's fetch
// unchanged (same reference, same this-binding semantics) — so we
// still exercise the exact codepath that crashes on Workers when
// fetch is not bound.

function startLocalTelegram() {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      let buf = "";
      req.on("data", (chunk) => (buf += chunk));
      req.on("end", () => {
        requests.push({
          url: req.url,
          method: req.method,
          headers: req.headers,
          body: buf,
        });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        requests,
        base: `http://127.0.0.1:${port}`,
        async close() {
          await new Promise((r) => server.close(() => r()));
        },
      });
    });
  });
}

/** Redirect outbound Telegram requests to a local stand-in. Preserves
 *  the app's view of `fetch` (same function identity + this-binding
 *  characteristics). Returns an unpatch function. */
function patchTelegramHost(redirectBase) {
  const originalFetch = globalThis.fetch;
  // IMPORTANT: we are NOT replacing globalThis.fetch with a plain
  // function — doing so would sidestep the very bug we want to
  // catch. Instead we intercept AFTER the route hands the URL off,
  // by swapping api.telegram.org for the local base in the outbound
  // Request. To do that we wrap fetch, but we still CALL the
  // original fetch for the redirected URL — so if fetch is bound
  // wrong, we still throw "Illegal invocation".
  globalThis.fetch = function patchedFetch(input, init) {
    const urlStr = typeof input === "string" ? input : input.url;
    if (urlStr.startsWith("https://api.telegram.org/")) {
      const rewritten = urlStr.replace("https://api.telegram.org", redirectBase);
      return originalFetch.call(globalThis, rewritten, init);
    }
    return originalFetch.call(globalThis, input, init);
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

// ---- tests ---------------------------------------------------------------

test("LIVE: /review/notify happy path — globalThis.fetch is invokable without 'Illegal invocation'", async () => {
  const stand = await startLocalTelegram();
  const unpatch = patchTelegramHost(stand.base);
  try {
    // Deliberately DO NOT pass a fetch — forces the default
    // fetch.bind(globalThis) path (the exact production code path).
    const app = createApp();
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
        body: JSON.stringify({
          repo_slug: "acme/app",
          message: "live-fetch test",
          pr_number: 42,
          verdict: "approve",
          episodic_id: "ep-live-1",
        }),
      },
      env,
    );
    assert.equal(res.status, 200, `expected 200, got ${res.status} ${JSON.stringify(body)}`);
    assert.equal(body.ok, true);
    assert.equal(body.delivered, 1);
    // Telegram stand-in received exactly one sendMessage
    assert.equal(stand.requests.length, 1);
    assert.match(stand.requests[0].url, /\/sendMessage$/);
    const payload = JSON.parse(stand.requests[0].body);
    assert.equal(payload.chat_id, 777);
    // v0.8 — verdict=approve + episodic_id triggers the autonomy renderer
    // (state=approved), which rewrites the body. Assert on the rendered
    // shape rather than the raw `message` passthrough.
    assert.match(payload.text, /Ready to merge/);
    assert.equal(payload.parse_mode, "HTML");
    assert.ok(payload.reply_markup, "episodic_id must attach inline keyboard");
  } finally {
    unpatch();
    await stand.close();
  }
});

test("LIVE: /review/notify missing bearer → 401, no crash", async () => {
  const stand = await startLocalTelegram();
  const unpatch = patchTelegramHost(stand.base);
  try {
    const app = createApp();
    const { env } = makeEnv({ chatIds: [1] });
    const { res } = await fetchApp(
      app,
      "/review/notify",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo_slug: "acme/app", message: "x" }),
      },
      env,
    );
    assert.equal(res.status, 401);
    // Must not have reached Telegram
    assert.equal(stand.requests.length, 0);
  } finally {
    unpatch();
    await stand.close();
  }
});

test("LIVE: /review/notify invalid bearer → 401, no crash", async () => {
  const stand = await startLocalTelegram();
  const unpatch = patchTelegramHost(stand.base);
  try {
    const app = createApp();
    const { env } = makeEnv({ chatIds: [1] });
    const { res } = await fetchApp(
      app,
      "/review/notify",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer c_not_the_real_one",
        },
        body: JSON.stringify({ repo_slug: "acme/app", message: "x" }),
      },
      env,
    );
    assert.equal(res.status, 401);
    assert.equal(stand.requests.length, 0);
  } finally {
    unpatch();
    await stand.close();
  }
});

test("LIVE: /review/notify install with no linked chat → delivered: 0, no crash", async () => {
  const stand = await startLocalTelegram();
  const unpatch = patchTelegramHost(stand.base);
  try {
    const app = createApp();
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
    assert.equal(stand.requests.length, 0);
  } finally {
    unpatch();
    await stand.close();
  }
});

test("LIVE: /review/notify with 2 linked chats — both receive message via globalThis.fetch", async () => {
  const stand = await startLocalTelegram();
  const unpatch = patchTelegramHost(stand.base);
  try {
    const app = createApp();
    const { env, token } = makeEnv({ chatIds: [111, 222] });
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
          message: "fan-out",
        }),
      },
      env,
    );
    assert.equal(res.status, 200);
    assert.equal(body.delivered, 2);
    assert.equal(stand.requests.length, 2);
    const chatIds = stand.requests.map((r) => JSON.parse(r.body).chat_id).sort();
    assert.deepEqual(chatIds, [111, 222]);
  } finally {
    unpatch();
    await stand.close();
  }
});

test("LIVE: /review/notify plain_summary passes through body unchanged", async () => {
  const stand = await startLocalTelegram();
  const unpatch = patchTelegramHost(stand.base);
  try {
    const app = createApp();
    const { env, token } = makeEnv({ chatIds: [7] });
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
          message: "Pre-rendered plain text.",
          plain_summary: {
            whatChanged: "a",
            verdictInPlain: "b",
            nextAction: "c",
            locale: "en",
          },
        }),
      },
      env,
    );
    assert.equal(res.status, 200);
    assert.equal(body.delivered, 1);
    const payload = JSON.parse(stand.requests[0].body);
    assert.equal(payload.text, "Pre-rendered plain text.");
  } finally {
    unpatch();
    await stand.close();
  }
});

test("LIVE: /review/notify with episodic_id attaches inline keyboard (live path)", async () => {
  const stand = await startLocalTelegram();
  const unpatch = patchTelegramHost(stand.base);
  try {
    const app = createApp();
    const { env, token } = makeEnv({ chatIds: [99] });
    await fetchApp(
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
          message: "kb",
          episodic_id: "ep-kb-1",
        }),
      },
      env,
    );
    const payload = JSON.parse(stand.requests[0].body);
    assert.ok(payload.reply_markup);
    const kb = payload.reply_markup.inline_keyboard;
    assert.equal(kb.length, 1);
    assert.equal(kb[0].length, 3);
    const cbs = kb[0].map((b) => b.callback_data);
    assert.ok(cbs.includes("ep:ep-kb-1:reworked"));
    assert.ok(cbs.includes("ep:ep-kb-1:merged"));
    assert.ok(cbs.includes("ep:ep-kb-1:rejected"));
  } finally {
    unpatch();
    await stand.close();
  }
});

// ---- v0.7.5: /review/notify idempotency --------------------------------
//
// CI workflows retry review steps on transient failures. Each retry
// re-enters /review/notify, which used to fire duplicate Telegram
// messages. The dedupe table drops repeats inside a 5-minute window.

test("v0.7.5 dedupe: duplicate (install, episodic, repo) within 5min → delivered: 0 deduped:true, no send", async () => {
  const stand = await startLocalTelegram();
  const unpatch = patchTelegramHost(stand.base);
  try {
    const app = createApp();
    const { env, token } = makeEnv({ chatIds: [555] });
    // First call — normal send.
    const first = await fetchApp(app, "/review/notify", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        repo_slug: "acme/app",
        message: "first",
        episodic_id: "ep-dedupe-1",
        pr_number: 42,
      }),
    }, env);
    assert.equal(first.res.status, 200);
    assert.equal(first.body.delivered, 1);
    assert.equal(first.body.deduped, undefined);
    assert.equal(stand.requests.length, 1);

    // Second call with identical key — should dedupe, not send.
    const second = await fetchApp(app, "/review/notify", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        repo_slug: "acme/app",
        message: "DIFFERENT TEXT — should still dedupe on key",
        episodic_id: "ep-dedupe-1",
        pr_number: 42,
      }),
    }, env);
    assert.equal(second.res.status, 200);
    assert.equal(second.body.ok, true);
    assert.equal(second.body.deduped, true);
    assert.equal(second.body.reason, "duplicate_within_5min");
    // Return the last known delivered count so CLI keeps seeing parity.
    assert.equal(second.body.delivered, 1);
    // And — critically — NO second Telegram send.
    assert.equal(stand.requests.length, 1, "dedupe must prevent duplicate send");
  } finally {
    unpatch();
    await stand.close();
  }
});

test("v0.7.5 dedupe: different episodic_id bypasses dedupe (two distinct events send twice)", async () => {
  const stand = await startLocalTelegram();
  const unpatch = patchTelegramHost(stand.base);
  try {
    const app = createApp();
    const { env, token } = makeEnv({ chatIds: [555] });
    await fetchApp(app, "/review/notify", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        repo_slug: "acme/app",
        message: "first",
        episodic_id: "ep-aaa",
      }),
    }, env);
    await fetchApp(app, "/review/notify", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        repo_slug: "acme/app",
        message: "second",
        episodic_id: "ep-bbb",
      }),
    }, env);
    assert.equal(stand.requests.length, 2);
  } finally {
    unpatch();
    await stand.close();
  }
});

test("v0.7.5 dedupe: missing episodic_id → no dedupe (best-effort, doesn't gate send)", async () => {
  const stand = await startLocalTelegram();
  const unpatch = patchTelegramHost(stand.base);
  try {
    const app = createApp();
    const { env, token } = makeEnv({ chatIds: [555] });
    await fetchApp(app, "/review/notify", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ repo_slug: "acme/app", message: "no-episodic-1" }),
    }, env);
    await fetchApp(app, "/review/notify", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ repo_slug: "acme/app", message: "no-episodic-2" }),
    }, env);
    assert.equal(stand.requests.length, 2, "no-episodic-id events must never dedupe");
  } finally {
    unpatch();
    await stand.close();
  }
});

test("v0.7.5 no-linked-chat reason is machine-readable snake_case", async () => {
  const stand = await startLocalTelegram();
  const unpatch = patchTelegramHost(stand.base);
  try {
    const app = createApp();
    const { env, token } = makeEnv({ chatIds: [] });
    const { res, body } = await fetchApp(app, "/review/notify", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ repo_slug: "acme/app", message: "x" }),
    }, env);
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.delivered, 0);
    assert.equal(body.reason, "no_linked_chat");
    assert.ok(body.hint && body.hint.includes("/link"));
    // Must not have hit Telegram
    assert.equal(stand.requests.length, 0);
  } finally {
    unpatch();
    await stand.close();
  }
});
