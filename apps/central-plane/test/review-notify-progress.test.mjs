import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createApp } from "../dist/router.js";

/**
 * v0.11 — /review/notify-progress route tests.
 *
 * Uses a fully mocked D1 + a captured fetch so we can assert which
 * Telegram method was called (sendMessage on first emit, editMessageText
 * on subsequent emits) and that the persisted progress_messages row
 * carries the expected message_id, last_lines, last_text.
 */

function sha256(s) {
  return createHash("sha256").update(s).digest("hex");
}

function makeMockDb({ installs = new Map(), links = [], progress = [] } = {}) {
  const state = {
    installs: new Map(installs),
    links: [...links],
    progress: new Map(
      progress.map((p) => [`${p.installId}|${p.episodicId}|${p.chatId}`, p]),
    ),
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
          if (/SELECT 1 AS ok/.test(sql)) {
            return { ok: 1 };
          }
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
          if (/SELECT \* FROM progress_messages WHERE/.test(sql)) {
            const [installId, episodicId, chatId] = bound;
            const row = state.progress.get(`${installId}|${episodicId}|${chatId}`);
            if (!row) return null;
            return {
              install_id: row.installId,
              episodic_id: row.episodicId,
              chat_id: row.chatId,
              message_id: row.messageId,
              pr_number: row.prNumber,
              repo_slug: row.repoSlug,
              last_lines: row.lastLines,
              last_text: row.lastText,
              created_at: row.createdAt,
              updated_at: row.updatedAt,
            };
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
          } else if (/INSERT INTO progress_messages/.test(sql)) {
            const [installId, episodicId, chatId, messageId, prNumber, repoSlug, lastLines, lastText, createdAt, updatedAt] = bound;
            state.progress.set(`${installId}|${episodicId}|${chatId}`, {
              installId,
              episodicId,
              chatId,
              messageId,
              prNumber,
              repoSlug,
              lastLines,
              lastText,
              createdAt,
              updatedAt,
            });
          } else if (/UPDATE progress_messages/.test(sql)) {
            const [lastLines, lastText, updatedAt, installId, episodicId, chatId] = bound;
            const key = `${installId}|${episodicId}|${chatId}`;
            const existing = state.progress.get(key);
            if (existing) {
              existing.lastLines = lastLines;
              existing.lastText = lastText;
              existing.updatedAt = updatedAt;
            }
          }
          return { success: true };
        },
      };
      return wrap;
    },
  };
}

function makeEnv({ token = "c_progress_ok", repo = "acme/golf-now", chatIds = [777] } = {}) {
  const tokenHash = sha256(token);
  const installId = "c_install_progress";
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
    db: makeMockDb({ installs, links }),
    token,
    installId,
    repo,
  };
}

function makeFetchCapture({ messageId = 555 } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    const isSend = url.endsWith("/sendMessage");
    return new Response(
      JSON.stringify({
        ok: true,
        result: isSend
          ? { message_id: messageId, chat: { id: body?.chat_id ?? 0 } }
          : true,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  fn.calls = calls;
  return fn;
}

async function postJson(app, path, body, env, token) {
  const req = new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });
  return { res, body: await res.json().catch(() => null) };
}

// ---- 1. happy path: first emit sendMessage, second emit editMessageText ---

test("/review/notify-progress: first call sends, second call edits same message", async () => {
  const cap = makeFetchCapture({ messageId: 12345 });
  const app = createApp({ fetch: cap });
  const { db, token, installId, repo } = makeEnv();
  const env = { DB: db, ENVIRONMENT: "test", TELEGRAM_BOT_TOKEN: "bot-tok" };

  const r1 = await postJson(
    app,
    "/review/notify-progress",
    {
      repo_slug: repo,
      episodic_id: "ep-prog-1",
      stage: "review-started",
      payload: { repo, pullNumber: 1, agentIds: ["claude", "openai"] },
    },
    env,
    token,
  );
  assert.equal(r1.res.status, 200);
  assert.equal(r1.body.ok, true);
  assert.equal(r1.body.sent, 1);
  assert.equal(r1.body.edited, 0);
  assert.equal(cap.calls.length, 1);
  assert.match(cap.calls[0].url, /\/sendMessage$/);
  // D1 has the row.
  const row1 = db.state.progress.get(`${installId}|ep-prog-1|777`);
  assert.ok(row1);
  assert.equal(row1.messageId, 12345);

  const r2 = await postJson(
    app,
    "/review/notify-progress",
    {
      repo_slug: repo,
      episodic_id: "ep-prog-1",
      stage: "tier1-done",
      payload: { repo, pullNumber: 1, blockerCount: 2, rounds: 1 },
    },
    env,
    token,
  );
  assert.equal(r2.body.ok, true);
  assert.equal(r2.body.sent, 0);
  assert.equal(r2.body.edited, 1);
  assert.equal(cap.calls.length, 2);
  assert.match(cap.calls[1].url, /\/editMessageText$/);
  assert.equal(cap.calls[1].body.message_id, 12345);
  // Cumulative text contains both lines.
  assert.match(cap.calls[1].body.text, /Review starting/);
  assert.match(cap.calls[1].body.text, /Tier-1 done/);
});

// ---- 2. validation --------------------------------------------------------

test("/review/notify-progress: missing bearer → 401", async () => {
  const cap = makeFetchCapture();
  const app = createApp({ fetch: cap });
  const { db, repo } = makeEnv();
  const env = { DB: db, ENVIRONMENT: "test", TELEGRAM_BOT_TOKEN: "bot-tok" };
  const req = new Request(`http://localhost/review/notify-progress`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repo_slug: repo, episodic_id: "ep", stage: "review-started" }),
  });
  const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });
  assert.equal(res.status, 401);
  assert.equal(cap.calls.length, 0);
});

test("/review/notify-progress: invalid stage → 400", async () => {
  const cap = makeFetchCapture();
  const app = createApp({ fetch: cap });
  const { db, token, repo } = makeEnv();
  const env = { DB: db, ENVIRONMENT: "test", TELEGRAM_BOT_TOKEN: "bot-tok" };
  const r = await postJson(
    app,
    "/review/notify-progress",
    { repo_slug: repo, episodic_id: "ep", stage: "bogus-stage" },
    env,
    token,
  );
  assert.equal(r.res.status, 400);
  assert.match(r.body.error, /stage:/);
  assert.equal(cap.calls.length, 0);
});

test("/review/notify-progress: unknown token → 401", async () => {
  const cap = makeFetchCapture();
  const app = createApp({ fetch: cap });
  const { db, repo } = makeEnv();
  const env = { DB: db, ENVIRONMENT: "test", TELEGRAM_BOT_TOKEN: "bot-tok" };
  const r = await postJson(
    app,
    "/review/notify-progress",
    { repo_slug: repo, episodic_id: "ep", stage: "review-started" },
    env,
    "wrong-token",
  );
  assert.equal(r.res.status, 401);
  assert.match(r.body.error, /unknown or revoked token/);
});

test("/review/notify-progress: no linked chats → ok with delivered=0", async () => {
  const cap = makeFetchCapture();
  const app = createApp({ fetch: cap });
  const { db, token, repo } = makeEnv({ chatIds: [] });
  const env = { DB: db, ENVIRONMENT: "test", TELEGRAM_BOT_TOKEN: "bot-tok" };
  const r = await postJson(
    app,
    "/review/notify-progress",
    { repo_slug: repo, episodic_id: "ep-x", stage: "review-started" },
    env,
    token,
  );
  assert.equal(r.res.status, 200);
  assert.equal(r.body.delivered, 0);
  assert.equal(r.body.reason, "no_linked_chat");
  assert.equal(cap.calls.length, 0);
});

// ---- 3. /healthz ----------------------------------------------------------

test("/healthz: returns ok=true with db=up when ping succeeds", async () => {
  const app = createApp();
  const { db } = makeEnv();
  const env = { DB: db, ENVIRONMENT: "test" };
  const req = new Request(`http://localhost/healthz`, { method: "GET" });
  const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.db, "up");
  assert.equal(body.service, "conclave-central-plane");
  assert.match(body.version, /^0\.11\./);
});

test("/healthz: returns ok=false with db=down when ping fails", async () => {
  const app = createApp();
  // DB binding that throws on any prepare() — simulates a bad binding
  // or downstream D1 outage.
  const brokenDb = {
    prepare() {
      throw new Error("D1 binding offline");
    },
  };
  const env = { DB: brokenDb, ENVIRONMENT: "test" };
  const req = new Request(`http://localhost/healthz`, { method: "GET" });
  const res = await app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, false);
  assert.equal(body.db, "down");
});
