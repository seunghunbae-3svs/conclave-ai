import { test } from "node:test";
import assert from "node:assert/strict";
import { TelegramClient } from "../dist/index.js";

function mockFetch(responses) {
  let i = 0;
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => r.json,
      text: async () => r.text ?? JSON.stringify(r.json),
    };
  };
  fn.calls = calls;
  return fn;
}

test("TelegramClient: rejects empty token", () => {
  assert.throws(() => new TelegramClient({ token: "" }));
});

test("TelegramClient: sendMessage issues POST to /botTOKEN/sendMessage", async () => {
  const f = mockFetch([{ json: { ok: true, result: { message_id: 1 } } }]);
  const client = new TelegramClient({ token: "test-token", fetch: f });
  await client.sendMessage({ chat_id: 123, text: "hi" });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, "https://api.telegram.org/bottest-token/sendMessage");
  assert.equal(f.calls[0].init.method, "POST");
  assert.equal(f.calls[0].init.headers["content-type"], "application/json");
  assert.match(f.calls[0].init.body, /"chat_id":123/);
});

test("TelegramClient: throws on ok=false with Telegram description", async () => {
  const f = mockFetch([
    { json: { ok: false, description: "chat not found", error_code: 400 } },
  ]);
  const client = new TelegramClient({ token: "t", fetch: f });
  await assert.rejects(
    () => client.sendMessage({ chat_id: 0, text: "x" }),
    /chat not found.*code 400/,
  );
});

test("TelegramClient: throws on non-JSON response with status + snippet", async () => {
  const f = async () => ({
    ok: false,
    status: 502,
    json: async () => {
      throw new Error("invalid json");
    },
    text: async () => "upstream error page".repeat(50),
  });
  const client = new TelegramClient({ token: "t", fetch: f });
  await assert.rejects(() => client.sendMessage({ chat_id: 0, text: "x" }), /non-JSON.*status 502/);
});

test("TelegramClient: honors baseUrl override", async () => {
  const f = mockFetch([{ json: { ok: true, result: {} } }]);
  const client = new TelegramClient({ token: "t", fetch: f, baseUrl: "https://telegram.local" });
  await client.sendMessage({ chat_id: 1, text: "hi" });
  assert.ok(f.calls[0].url.startsWith("https://telegram.local/"));
});
