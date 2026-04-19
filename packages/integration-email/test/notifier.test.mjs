import { test } from "node:test";
import assert from "node:assert/strict";
import { EmailNotifier, ResendTransport } from "../dist/index.js";

function mockFetch(response = { ok: true, status: 200, text: "{}" }) {
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
  episodicId: "ep-e",
  totalCostUsd: 0.01,
};

// ── ResendTransport ──────────────────────────────────────────────

test("ResendTransport: missing API key throws", () => {
  const orig = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  try {
    assert.throws(() => new ResendTransport());
  } finally {
    if (orig !== undefined) process.env.RESEND_API_KEY = orig;
  }
});

test("ResendTransport: send POSTs to /emails with bearer + JSON body", async () => {
  const f = mockFetch();
  const t = new ResendTransport({ apiKey: "re_test", fetch: f });
  await t.send({ from: "a@x.com", to: "b@x.com", subject: "s", text: "hi", html: "<b>hi</b>" });
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0].url.endsWith("/emails"));
  assert.equal(f.calls[0].init.method, "POST");
  assert.equal(f.calls[0].init.headers.authorization, "Bearer re_test");
  assert.equal(f.calls[0].init.headers["content-type"], "application/json");
  assert.deepEqual(f.calls[0].body.to, ["b@x.com"]);
  assert.equal(f.calls[0].body.html, "<b>hi</b>");
});

test("ResendTransport: `to` array passed through", async () => {
  const f = mockFetch();
  const t = new ResendTransport({ apiKey: "k", fetch: f });
  await t.send({ from: "a@x.com", to: ["b@x.com", "c@x.com"], subject: "s", text: "t" });
  assert.deepEqual(f.calls[0].body.to, ["b@x.com", "c@x.com"]);
});

test("ResendTransport: non-200 throws with status + snippet", async () => {
  const f = mockFetch({ ok: false, status: 422, text: "invalid from" });
  const t = new ResendTransport({ apiKey: "k", fetch: f });
  await assert.rejects(
    () => t.send({ from: "bad", to: "a@x.com", subject: "s", text: "t" }),
    /status 422.*invalid from/,
  );
});

// ── EmailNotifier ────────────────────────────────────────────────

test("EmailNotifier: rejects missing from", () => {
  const origF = process.env.CONCLAVE_EMAIL_FROM;
  const origT = process.env.CONCLAVE_EMAIL_TO;
  delete process.env.CONCLAVE_EMAIL_FROM;
  process.env.CONCLAVE_EMAIL_TO = "a@x.com";
  try {
    assert.throws(() => new EmailNotifier({ to: "a@x.com", transport: { id: "mock", send: async () => {} } }));
  } finally {
    if (origF !== undefined) process.env.CONCLAVE_EMAIL_FROM = origF;
    if (origT !== undefined) process.env.CONCLAVE_EMAIL_TO = origT;
    else delete process.env.CONCLAVE_EMAIL_TO;
  }
});

test("EmailNotifier: rejects missing to", () => {
  const origF = process.env.CONCLAVE_EMAIL_FROM;
  const origT = process.env.CONCLAVE_EMAIL_TO;
  process.env.CONCLAVE_EMAIL_FROM = "a@x.com";
  delete process.env.CONCLAVE_EMAIL_TO;
  try {
    assert.throws(
      () => new EmailNotifier({ from: "a@x.com", transport: { id: "mock", send: async () => {} } }),
    );
  } finally {
    if (origF !== undefined) process.env.CONCLAVE_EMAIL_FROM = origF;
    else delete process.env.CONCLAVE_EMAIL_FROM;
    if (origT !== undefined) process.env.CONCLAVE_EMAIL_TO = origT;
  }
});

test("EmailNotifier: comma-separated CONCLAVE_EMAIL_TO env → array", async () => {
  const origF = process.env.CONCLAVE_EMAIL_FROM;
  const origT = process.env.CONCLAVE_EMAIL_TO;
  process.env.CONCLAVE_EMAIL_FROM = "a@x.com";
  process.env.CONCLAVE_EMAIL_TO = "b@x.com, c@x.com";
  try {
    const sent = [];
    const transport = { id: "mock", send: async (m) => sent.push(m) };
    const n = new EmailNotifier({ transport });
    await n.notifyReview(baseInput);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].to, ["b@x.com", "c@x.com"]);
  } finally {
    if (origF !== undefined) process.env.CONCLAVE_EMAIL_FROM = origF;
    else delete process.env.CONCLAVE_EMAIL_FROM;
    if (origT !== undefined) process.env.CONCLAVE_EMAIL_TO = origT;
    else delete process.env.CONCLAVE_EMAIL_TO;
  }
});

test("EmailNotifier: subjectOverride wins over rendered subject", async () => {
  const sent = [];
  const transport = { id: "mock", send: async (m) => sent.push(m) };
  const n = new EmailNotifier({
    from: "a@x.com",
    to: "b@x.com",
    subjectOverride: "custom subject",
    transport,
  });
  await n.notifyReview(baseInput);
  assert.equal(sent[0].subject, "custom subject");
});

test("EmailNotifier: uses rendered subject by default", async () => {
  const sent = [];
  const transport = { id: "mock", send: async (m) => sent.push(m) };
  const n = new EmailNotifier({ from: "a@x.com", to: "b@x.com", transport });
  await n.notifyReview(baseInput);
  assert.match(sent[0].subject, /\[conclave\] APPROVE/);
});

test("EmailNotifier: text + html both sent", async () => {
  const sent = [];
  const transport = { id: "mock", send: async (m) => sent.push(m) };
  const n = new EmailNotifier({ from: "a@x.com", to: "b@x.com", transport });
  await n.notifyReview(baseInput);
  assert.ok(sent[0].text && sent[0].text.length > 0);
  assert.ok(sent[0].html && sent[0].html.length > 0);
  assert.ok(sent[0].html.includes("<div"));
});

test("EmailNotifier: custom transport plugs in cleanly", async () => {
  const calls = [];
  const transport = {
    id: "custom-smtp",
    send: async (m) => {
      calls.push(m);
    },
  };
  const n = new EmailNotifier({ from: "a@x.com", to: "b@x.com", transport });
  await n.notifyReview(baseInput);
  assert.equal(calls.length, 1);
});

test("EmailNotifier: Notifier interface conformance", () => {
  const n = new EmailNotifier({
    from: "a@x.com",
    to: "b@x.com",
    transport: { id: "mock", send: async () => {} },
  });
  assert.equal(n.id, "email");
  assert.equal(n.displayName, "Email");
  assert.equal(typeof n.notifyReview, "function");
});
