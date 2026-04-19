import { test } from "node:test";
import assert from "node:assert/strict";
import { TelegramNotifier } from "../dist/index.js";

function mockFetch(response = { ok: true, result: { message_id: 1 } }) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      json: async () => response,
      text: async () => JSON.stringify(response),
    };
  };
  fn.calls = calls;
  return fn;
}

const baseInput = {
  outcome: {
    verdict: "approve",
    rounds: 1,
    consensusReached: true,
    results: [{ agent: "claude", verdict: "approve", blockers: [], summary: "LGTM" }],
  },
  ctx: { diff: "", repo: "acme/app", pullNumber: 42, newSha: "abc" },
  episodicId: "ep-test",
  totalCostUsd: 0.01,
};

test("TelegramNotifier: constructor throws on missing token", () => {
  const orig = process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_BOT_TOKEN;
  try {
    assert.throws(() => new TelegramNotifier({ chatId: 1 }));
  } finally {
    if (orig !== undefined) process.env.TELEGRAM_BOT_TOKEN = orig;
  }
});

test("TelegramNotifier: constructor throws on missing chatId", () => {
  const orig = process.env.TELEGRAM_CHAT_ID;
  delete process.env.TELEGRAM_CHAT_ID;
  try {
    assert.throws(() => new TelegramNotifier({ token: "t" }));
  } finally {
    if (orig !== undefined) process.env.TELEGRAM_CHAT_ID = orig;
  }
});

test("TelegramNotifier: numeric-string chat id is coerced to number", async () => {
  const f = mockFetch();
  const n = new TelegramNotifier({ token: "t", chatId: "-100123", fetch: f });
  await n.notifyReview(baseInput);
  assert.equal(typeof f.calls[0].body.chat_id, "number");
  assert.equal(f.calls[0].body.chat_id, -100123);
});

test("TelegramNotifier: notifyReview posts HTML + disable_web_page_preview", async () => {
  const f = mockFetch();
  const n = new TelegramNotifier({ token: "t", chatId: 999, fetch: f });
  await n.notifyReview(baseInput);
  assert.equal(f.calls[0].body.parse_mode, "HTML");
  assert.equal(f.calls[0].body.disable_web_page_preview, true);
  assert.match(f.calls[0].body.text, /Approved/);
});

test("TelegramNotifier: includes inline action keyboard by default", async () => {
  const f = mockFetch();
  const n = new TelegramNotifier({ token: "t", chatId: 999, fetch: f });
  await n.notifyReview(baseInput);
  const kb = f.calls[0].body.reply_markup?.inline_keyboard;
  assert.ok(Array.isArray(kb));
  assert.equal(kb[0].length, 3);
  const callbacks = kb[0].map((b) => b.callback_data);
  assert.ok(callbacks[0].startsWith("ep:ep-test:merged"));
  assert.ok(callbacks[1].startsWith("ep:ep-test:reworked"));
  assert.ok(callbacks[2].startsWith("ep:ep-test:rejected"));
});

test("TelegramNotifier: includeActionButtons:false omits reply_markup", async () => {
  const f = mockFetch();
  const n = new TelegramNotifier({ token: "t", chatId: 999, fetch: f, includeActionButtons: false });
  await n.notifyReview(baseInput);
  assert.equal(f.calls[0].body.reply_markup, undefined);
});

test("TelegramNotifier: uses TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID env fallback", async () => {
  const origT = process.env.TELEGRAM_BOT_TOKEN;
  const origC = process.env.TELEGRAM_CHAT_ID;
  process.env.TELEGRAM_BOT_TOKEN = "env-token";
  process.env.TELEGRAM_CHAT_ID = "555";
  const f = mockFetch();
  try {
    const n = new TelegramNotifier({ fetch: f });
    await n.notifyReview(baseInput);
    assert.ok(f.calls[0].url.includes("env-token"));
    assert.equal(f.calls[0].body.chat_id, 555);
  } finally {
    if (origT !== undefined) process.env.TELEGRAM_BOT_TOKEN = origT;
    else delete process.env.TELEGRAM_BOT_TOKEN;
    if (origC !== undefined) process.env.TELEGRAM_CHAT_ID = origC;
    else delete process.env.TELEGRAM_CHAT_ID;
  }
});

test("TelegramNotifier: conforms to Notifier interface", () => {
  const n = new TelegramNotifier({ token: "t", chatId: 1, fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: {} }), text: async () => "" }) });
  assert.equal(n.id, "telegram");
  assert.equal(n.displayName, "Telegram");
  assert.equal(typeof n.notifyReview, "function");
});
