import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createApp } from "../dist/router.js";

/**
 * v0.8 — autonomous pipeline: /review/notify branches on verdict + cycle
 * and fires GitHub repository_dispatch for the auto-rework path. These
 * tests stub BOTH the Telegram API (observed via a captured fetch mock)
 * and the GitHub dispatch endpoint — a single mocked fetch serves both.
 */

// ---- mock D1 (installs + telegram_links) + dispatch-capable install -----

function makeMockDb({ installs = [], links = [], installTokens = new Map() } = {}) {
  const state = { installs: [...installs], links: [...links], installTokens };
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
            const row = state.installs.find((i) => i.tokenHash === bound[0] && i.status === "active");
            if (!row) return null;
            return {
              id: row.id,
              repo_slug: row.repoSlug,
              token_hash: row.tokenHash,
              created_at: row.createdAt,
              last_seen_at: row.lastSeenAt,
              status: row.status,
            };
          }
          if (/SELECT id, repo_slug, github_access_token/.test(sql)) {
            const row = state.installs.find((i) => i.id === bound[0] && i.status === "active");
            if (!row) return null;
            return {
              id: row.id,
              repo_slug: row.repoSlug,
              github_access_token: state.installTokens.get(row.id) ?? null,
              github_access_token_enc: null,
              github_token_scope: null,
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

function makeEnv({ token = "c_auto_live", repo = "acme/app", chatIds = [], githubToken = "ghp_test" } = {}) {
  const tokenHash = sha256(token);
  const installId = "c_install_auto1";
  const installs = [
    {
      id: installId,
      repoSlug: repo,
      tokenHash,
      createdAt: "2026-04-20T00:00:00Z",
      lastSeenAt: "2026-04-20T00:00:00Z",
      status: "active",
    },
  ];
  const links = chatIds.map((cid) => ({
    chatId: cid,
    installId,
    linkedAt: "2026-04-20T00:00:00Z",
  }));
  return {
    env: {
      DB: makeMockDb({
        installs,
        links,
        installTokens: new Map([[installId, githubToken]]),
      }),
      ENVIRONMENT: "test",
      TELEGRAM_BOT_TOKEN: "bot-live",
    },
    token,
    installId,
    repo,
  };
}

// Capturing mock fetch — distinguishes telegram vs. github by URL.
// GitHub's repository_dispatch endpoint returns 204 in production, but
// Node's Response constructor forbids a body with 204 — use `null` body
// for null-body statuses so the mock stays correct without tripping the
// spec check.
function makeCapturingFetch({ githubStatus = 204 } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    const urlStr = typeof url === "string" ? url : url.url;
    calls.push({ url: urlStr, init, body: init?.body ? JSON.parse(init.body) : null });
    if (urlStr.startsWith("https://api.github.com/")) {
      // 204 / 205 / 304 may NOT carry a body per the Fetch spec; passing
      // even "" trips `TypeError: Invalid response status code 204`.
      const nullBody = githubStatus === 204 || githubStatus === 205 || githubStatus === 304;
      return nullBody
        ? new Response(null, { status: githubStatus })
        : new Response("", { status: githubStatus });
    }
    // telegram
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: fn, calls };
}

async function post(app, path, env, token, body, fetchImpl) {
  const req = new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
  const res = await app.fetch(req, env, ctx);
  return { res, body: await res.json().catch(() => null) };
}

function telegramCalls(calls) {
  return calls.filter((c) => c.url.startsWith("https://api.telegram.org/"));
}
function githubCalls(calls) {
  return calls.filter((c) => c.url.startsWith("https://api.github.com/"));
}

// --- tests ---------------------------------------------------------------

test("autonomy: approve verdict → approve keyboard (Merge + Close), no dispatch", async () => {
  const { fetch, calls } = makeCapturingFetch();
  const app = createApp({ fetch });
  const { env, token } = makeEnv({ chatIds: [111] });
  const { res, body } = await post(app, "/review/notify", env, token, {
    repo_slug: "acme/app",
    message: "fallback",
    pr_number: 42,
    verdict: "approve",
    episodic_id: "ep-approve-1",
    rework_cycle: 0,
    max_rework_cycles: 3,
  });
  assert.equal(res.status, 200);
  assert.equal(body.state, "approved");
  assert.equal(body.dispatched, false);
  assert.equal(body.delivered, 1);
  const tg = telegramCalls(calls);
  assert.equal(tg.length, 1);
  const payload = tg[0].body;
  assert.match(payload.text, /Ready to merge/);
  assert.equal(payload.reply_markup.inline_keyboard[0].length, 2);
  assert.equal(payload.reply_markup.inline_keyboard[0][0].callback_data, "ep:ep-approve-1:merge");
  assert.equal(payload.reply_markup.inline_keyboard[0][1].callback_data, "ep:ep-approve-1:reject");
  // No GitHub dispatch for approve
  assert.equal(githubCalls(calls).length, 0);
});

test("autonomy: rework verdict, cycle=0 → no buttons + auto-dispatch to GitHub", async () => {
  const { fetch, calls } = makeCapturingFetch();
  const app = createApp({ fetch });
  const { env, token } = makeEnv({ chatIds: [222] });
  const { res, body } = await post(app, "/review/notify", env, token, {
    repo_slug: "acme/app",
    message: "fallback",
    pr_number: 7,
    verdict: "rework",
    episodic_id: "ep-rw-1",
    rework_cycle: 0,
    max_rework_cycles: 3,
  });
  assert.equal(res.status, 200);
  assert.equal(body.state, "reworking");
  assert.equal(body.dispatched, true);

  // Telegram: no buttons (autonomy tells user to sit tight)
  const tg = telegramCalls(calls);
  assert.equal(tg.length, 1);
  const payload = tg[0].body;
  assert.match(payload.text, /auto-fixing/i);
  assert.equal(payload.reply_markup, undefined);

  // GitHub: repository_dispatch for conclave-rework, cycle=1, pr_number=7
  const gh = githubCalls(calls);
  assert.equal(gh.length, 1);
  assert.match(gh[0].url, /\/repos\/acme\/app\/dispatches$/);
  assert.equal(gh[0].body.event_type, "conclave-rework");
  assert.equal(gh[0].body.client_payload.cycle, 1);
  assert.equal(gh[0].body.client_payload.pr_number, 7);
  assert.equal(gh[0].body.client_payload.episodic, "ep-rw-1");
});

test("autonomy: rework verdict, cycle=3 (== max) → max-cycles keyboard, NO dispatch", async () => {
  const { fetch, calls } = makeCapturingFetch();
  const app = createApp({ fetch });
  const { env, token } = makeEnv({ chatIds: [333] });
  const { res, body } = await post(app, "/review/notify", env, token, {
    repo_slug: "acme/app",
    message: "fallback",
    pr_number: 7,
    verdict: "rework",
    episodic_id: "ep-max-1",
    rework_cycle: 3,
    max_rework_cycles: 3,
    blocker_count: 2,
  });
  assert.equal(res.status, 200);
  assert.equal(body.state, "max-cycles-reached");
  assert.equal(body.dispatched, false);

  const tg = telegramCalls(calls);
  assert.equal(tg.length, 1);
  const payload = tg[0].body;
  assert.match(payload.text, /Auto-fix limit reached/i);
  const kb = payload.reply_markup.inline_keyboard[0];
  assert.equal(kb.length, 3);
  assert.equal(kb[0].callback_data, "ep:ep-max-1:merge-unsafe");
  assert.equal(kb[1].callback_data, "ep:ep-max-1:reject");
  assert.ok(kb[2].url, "third button should be a URL link to the PR");

  // No dispatch
  assert.equal(githubCalls(calls).length, 0);
});

test("autonomy: reject verdict → Close + Open PR, no dispatch", async () => {
  const { fetch, calls } = makeCapturingFetch();
  const app = createApp({ fetch });
  const { env, token } = makeEnv({ chatIds: [444] });
  const { res, body } = await post(app, "/review/notify", env, token, {
    repo_slug: "acme/app",
    message: "fallback",
    pr_number: 9,
    verdict: "reject",
    episodic_id: "ep-rej-1",
    rework_cycle: 0,
    max_rework_cycles: 3,
  });
  assert.equal(res.status, 200);
  assert.equal(body.state, "rejected");
  assert.equal(body.dispatched, false);
  const tg = telegramCalls(calls);
  const payload = tg[0].body;
  assert.match(payload.text, /discard/i);
  const kb = payload.reply_markup.inline_keyboard[0];
  assert.equal(kb.length, 2);
  assert.equal(kb[0].callback_data, "ep:ep-rej-1:reject");
  assert.ok(kb[1].url);
  assert.equal(githubCalls(calls).length, 0);
});

test("autonomy: allow_unsafe_merge=false → merge-unsafe button suppressed at max cycles", async () => {
  const { fetch, calls } = makeCapturingFetch();
  const app = createApp({ fetch });
  const { env, token } = makeEnv({ chatIds: [555] });
  const { res } = await post(app, "/review/notify", env, token, {
    repo_slug: "acme/app",
    message: "fallback",
    pr_number: 9,
    verdict: "rework",
    episodic_id: "ep-locked-1",
    rework_cycle: 3,
    max_rework_cycles: 3,
    allow_unsafe_merge: false,
  });
  assert.equal(res.status, 200);
  const tg = telegramCalls(calls);
  const payload = tg[0].body;
  const buttons = payload.reply_markup.inline_keyboard[0];
  // merge-unsafe removed; reject + open PR remain
  const callbacks = buttons.map((b) => b.callback_data).filter(Boolean);
  assert.ok(!callbacks.some((c) => c.endsWith(":merge-unsafe")));
  assert.ok(callbacks.some((c) => c.endsWith(":reject")));
});

test("autonomy: max_rework_cycles: 999 clamped to hard ceiling 5", async () => {
  const { fetch, calls } = makeCapturingFetch();
  const app = createApp({ fetch });
  const { env, token } = makeEnv({ chatIds: [666] });
  const { res, body } = await post(app, "/review/notify", env, token, {
    repo_slug: "acme/app",
    message: "fallback",
    pr_number: 9,
    verdict: "rework",
    episodic_id: "ep-clamp-1",
    rework_cycle: 5,
    max_rework_cycles: 999, // will be clamped to 5
  });
  assert.equal(res.status, 200);
  assert.equal(body.state, "max-cycles-reached");
  assert.equal(body.maxCycles, 5);
  assert.equal(githubCalls(calls).length, 0);
});

test("autonomy: no linked chat → still dispatches rework, delivered:0", async () => {
  const { fetch, calls } = makeCapturingFetch();
  const app = createApp({ fetch });
  const { env, token } = makeEnv({ chatIds: [] });
  const { res, body } = await post(app, "/review/notify", env, token, {
    repo_slug: "acme/app",
    message: "fallback",
    pr_number: 7,
    verdict: "rework",
    episodic_id: "ep-nochat-1",
    rework_cycle: 0,
  });
  assert.equal(res.status, 200);
  assert.equal(body.delivered, 0);
  // Dispatch should still have fired — autonomy loop is independent of
  // Telegram delivery.
  assert.equal(body.dispatched, true);
  assert.equal(githubCalls(calls).length, 1);
  assert.equal(telegramCalls(calls).length, 0);
});

test("autonomy: GitHub dispatch failure → 200 response, dispatchError surfaced", async () => {
  const { fetch, calls } = makeCapturingFetch({ githubStatus: 500 });
  const app = createApp({ fetch });
  const { env, token } = makeEnv({ chatIds: [777] });
  const { res, body } = await post(app, "/review/notify", env, token, {
    repo_slug: "acme/app",
    message: "fallback",
    pr_number: 7,
    verdict: "rework",
    episodic_id: "ep-ghfail-1",
    rework_cycle: 0,
  });
  assert.equal(res.status, 200);
  assert.equal(body.dispatched, false);
  assert.ok(body.dispatchError, "dispatchError should be surfaced");
  // Telegram message still sent so the user sees the state.
  assert.equal(telegramCalls(calls).length, 1);
});

test("autonomy: legacy caller (no verdict) → v0.7 three-button keyboard", async () => {
  const { fetch, calls } = makeCapturingFetch();
  const app = createApp({ fetch });
  const { env, token } = makeEnv({ chatIds: [888] });
  const { res, body } = await post(app, "/review/notify", env, token, {
    repo_slug: "acme/app",
    message: "legacy body",
    episodic_id: "ep-legacy-1",
  });
  assert.equal(res.status, 200);
  assert.equal(body.state, "legacy");
  const payload = telegramCalls(calls)[0].body;
  const kb = payload.reply_markup.inline_keyboard[0];
  assert.equal(kb.length, 3);
  const cbs = kb.map((b) => b.callback_data);
  assert.ok(cbs.includes("ep:ep-legacy-1:reworked"));
  assert.ok(cbs.includes("ep:ep-legacy-1:merged"));
  assert.ok(cbs.includes("ep:ep-legacy-1:rejected"));
});

test("autonomy: plain_summary.locale=ko drives Korean autonomy prose", async () => {
  const { fetch, calls } = makeCapturingFetch();
  const app = createApp({ fetch });
  const { env, token } = makeEnv({ chatIds: [999] });
  await post(app, "/review/notify", env, token, {
    repo_slug: "acme/app",
    message: "fallback",
    pr_number: 1,
    verdict: "approve",
    episodic_id: "ep-ko-1",
    rework_cycle: 0,
    max_rework_cycles: 3,
    plain_summary: {
      whatChanged: "x",
      verdictInPlain: "y",
      nextAction: "z",
      locale: "ko",
    },
  });
  const payload = telegramCalls(calls)[0].body;
  assert.match(payload.text, /병합 준비 완료/);
});

test("autonomy: rework_cycle negative → 400 error", async () => {
  const { fetch } = makeCapturingFetch();
  const app = createApp({ fetch });
  const { env, token } = makeEnv({ chatIds: [101] });
  const { res, body } = await post(app, "/review/notify", env, token, {
    repo_slug: "acme/app",
    message: "fallback",
    verdict: "rework",
    episodic_id: "ep-neg-1",
    rework_cycle: -1,
  });
  assert.equal(res.status, 400);
  assert.match(body.error, /rework_cycle/);
});
