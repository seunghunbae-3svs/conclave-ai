import { test } from "node:test";
import assert from "node:assert/strict";
import { SlackNotifier } from "../dist/index.js";

function mockFetch(response = { ok: true, status: 200, text: "ok" }) {
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
  episodicId: "ep-s",
  totalCostUsd: 0.01,
};

const GOOD_WEBHOOK = "https://hooks.slack.com/services/T000/B000/xxxx";

test("SlackNotifier: missing webhook URL throws", () => {
  const orig = process.env.SLACK_WEBHOOK_URL;
  delete process.env.SLACK_WEBHOOK_URL;
  try {
    assert.throws(() => new SlackNotifier());
  } finally {
    if (orig !== undefined) process.env.SLACK_WEBHOOK_URL = orig;
  }
});

test("SlackNotifier: non-hooks.slack.com URL throws", () => {
  assert.throws(() => new SlackNotifier({ webhookUrl: "https://evil.example.com/wh" }));
});

test("SlackNotifier: POST + JSON body", async () => {
  const f = mockFetch();
  const n = new SlackNotifier({ webhookUrl: GOOD_WEBHOOK, fetch: f });
  await n.notifyReview(baseInput);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, GOOD_WEBHOOK);
  assert.equal(f.calls[0].init.method, "POST");
  assert.equal(f.calls[0].init.headers["content-type"], "application/json");
});

test("SlackNotifier: default username + iconEmoji/iconUrl behavior", async () => {
  const f = mockFetch();
  const n = new SlackNotifier({ webhookUrl: GOOD_WEBHOOK, fetch: f });
  await n.notifyReview(baseInput);
  assert.equal(f.calls[0].body.username, "Ai-Conclave");
  assert.equal(f.calls[0].body.icon_url, undefined);
  assert.equal(f.calls[0].body.icon_emoji, undefined);
});

test("SlackNotifier: iconUrl wins over iconEmoji when both supplied", async () => {
  const f = mockFetch();
  const n = new SlackNotifier({
    webhookUrl: GOOD_WEBHOOK,
    fetch: f,
    iconUrl: "https://example.com/img.png",
    iconEmoji: ":robot_face:",
  });
  await n.notifyReview(baseInput);
  assert.equal(f.calls[0].body.icon_url, "https://example.com/img.png");
  assert.equal(f.calls[0].body.icon_emoji, undefined);
});

test("SlackNotifier: iconEmoji used when iconUrl absent", async () => {
  const f = mockFetch();
  const n = new SlackNotifier({
    webhookUrl: GOOD_WEBHOOK,
    fetch: f,
    iconEmoji: ":robot_face:",
  });
  await n.notifyReview(baseInput);
  assert.equal(f.calls[0].body.icon_emoji, ":robot_face:");
});

test("SlackNotifier: non-200 throws with status + body snippet", async () => {
  const f = mockFetch({ ok: false, status: 400, text: "invalid_payload" });
  const n = new SlackNotifier({ webhookUrl: GOOD_WEBHOOK, fetch: f });
  await assert.rejects(() => n.notifyReview(baseInput), /status 400.*invalid_payload/);
});

test("SlackNotifier: SLACK_WEBHOOK_URL env fallback", async () => {
  const orig = process.env.SLACK_WEBHOOK_URL;
  process.env.SLACK_WEBHOOK_URL = GOOD_WEBHOOK;
  const f = mockFetch();
  try {
    const n = new SlackNotifier({ fetch: f });
    await n.notifyReview(baseInput);
    assert.equal(f.calls[0].url, GOOD_WEBHOOK);
  } finally {
    if (orig !== undefined) process.env.SLACK_WEBHOOK_URL = orig;
    else delete process.env.SLACK_WEBHOOK_URL;
  }
});

test("SlackNotifier: Notifier interface conformance", () => {
  const n = new SlackNotifier({ webhookUrl: GOOD_WEBHOOK, fetch: async () => ({ ok: true, status: 200, text: async () => "" }) });
  assert.equal(n.id, "slack");
  assert.equal(n.displayName, "Slack");
  assert.equal(typeof n.notifyReview, "function");
});
