import { test } from "node:test";
import assert from "node:assert/strict";
import { DiscordNotifier } from "../dist/index.js";

function mockFetch(response = { ok: true, status: 204, text: "" }) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return {
      ok: response.ok,
      status: response.status,
      text: async () => response.text,
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
  episodicId: "ep-d",
  totalCostUsd: 0.01,
};

const GOOD_WEBHOOK = "https://discord.com/api/webhooks/123/abc";

test("DiscordNotifier: rejects missing webhook URL", () => {
  const orig = process.env.DISCORD_WEBHOOK_URL;
  delete process.env.DISCORD_WEBHOOK_URL;
  try {
    assert.throws(() => new DiscordNotifier());
  } finally {
    if (orig !== undefined) process.env.DISCORD_WEBHOOK_URL = orig;
  }
});

test("DiscordNotifier: rejects non-Discord URL", () => {
  assert.throws(() => new DiscordNotifier({ webhookUrl: "https://evil.example.com/webhook" }));
});

test("DiscordNotifier: accepts both discord.com and discordapp.com hosts", () => {
  const f = mockFetch();
  const n1 = new DiscordNotifier({
    webhookUrl: "https://discord.com/api/webhooks/1/x",
    fetch: f,
  });
  const n2 = new DiscordNotifier({
    webhookUrl: "https://discordapp.com/api/webhooks/1/x",
    fetch: f,
  });
  assert.ok(n1 && n2);
});

test("DiscordNotifier: notifyReview POSTs to webhook URL with JSON body", async () => {
  const f = mockFetch();
  const n = new DiscordNotifier({ webhookUrl: GOOD_WEBHOOK, fetch: f });
  await n.notifyReview(baseInput);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, GOOD_WEBHOOK);
  assert.equal(f.calls[0].init.method, "POST");
  assert.equal(f.calls[0].init.headers["content-type"], "application/json");
});

test("DiscordNotifier: default username = Ai-Conclave", async () => {
  const f = mockFetch();
  const n = new DiscordNotifier({ webhookUrl: GOOD_WEBHOOK, fetch: f });
  await n.notifyReview(baseInput);
  assert.equal(f.calls[0].body.username, "Ai-Conclave");
});

test("DiscordNotifier: username override is honored", async () => {
  const f = mockFetch();
  const n = new DiscordNotifier({ webhookUrl: GOOD_WEBHOOK, fetch: f, username: "Conclave Bot" });
  await n.notifyReview(baseInput);
  assert.equal(f.calls[0].body.username, "Conclave Bot");
});

test("DiscordNotifier: avatarUrl propagates when supplied", async () => {
  const f = mockFetch();
  const n = new DiscordNotifier({
    webhookUrl: GOOD_WEBHOOK,
    fetch: f,
    avatarUrl: "https://example.com/avatar.png",
  });
  await n.notifyReview(baseInput);
  assert.equal(f.calls[0].body.avatar_url, "https://example.com/avatar.png");
});

test("DiscordNotifier: non-200 response throws with status + snippet", async () => {
  const f = mockFetch({ ok: false, status: 400, text: "bad request: invalid embed" });
  const n = new DiscordNotifier({ webhookUrl: GOOD_WEBHOOK, fetch: f });
  await assert.rejects(() => n.notifyReview(baseInput), /status 400.*bad request/);
});

test("DiscordNotifier: env fallback for DISCORD_WEBHOOK_URL", async () => {
  const orig = process.env.DISCORD_WEBHOOK_URL;
  process.env.DISCORD_WEBHOOK_URL = GOOD_WEBHOOK;
  const f = mockFetch();
  try {
    const n = new DiscordNotifier({ fetch: f });
    await n.notifyReview(baseInput);
    assert.equal(f.calls[0].url, GOOD_WEBHOOK);
  } finally {
    if (orig !== undefined) process.env.DISCORD_WEBHOOK_URL = orig;
    else delete process.env.DISCORD_WEBHOOK_URL;
  }
});

test("DiscordNotifier: conforms to Notifier interface", () => {
  const n = new DiscordNotifier({ webhookUrl: GOOD_WEBHOOK, fetch: async () => ({ ok: true, status: 204, text: async () => "" }) });
  assert.equal(n.id, "discord");
  assert.equal(n.displayName, "Discord");
  assert.equal(typeof n.notifyReview, "function");
});
