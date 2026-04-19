import { test } from "node:test";
import assert from "node:assert/strict";
import { runBotOnce } from "../dist/index.js";

function makeFetch(responses) {
  const calls = [];
  let i = 0;
  const fn = async (url, init) => {
    calls.push({ url, init });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body ?? ""),
    };
  };
  fn.calls = calls;
  return fn;
}

function makeGh() {
  const calls = [];
  const fn = async (bin, args, opts) => {
    calls.push({ bin, args: [...args], input: opts?.input });
    return { stdout: "", stderr: "" };
  };
  fn.calls = calls;
  return fn;
}

function updatesResponse(result) {
  return { ok: true, status: 200, body: { ok: true, result } };
}

const update = (updateId, { episodicId = "ep-1", outcome = "reworked", cqId = "cq" } = {}) => ({
  update_id: updateId,
  callback_query: {
    id: cqId,
    data: `ep:${episodicId}:${outcome}`,
    from: { username: "bae" },
    message: { chat: { id: 1 }, message_id: updateId },
  },
});

test("runBotOnce: rejects missing botToken or malformed repo", async () => {
  await assert.rejects(() => runBotOnce({ botToken: "", repo: "acme/x" }), /botToken is required/);
  await assert.rejects(() => runBotOnce({ botToken: "t", repo: "no-slash" }), /owner\/name/);
});

test("runBotOnce: dispatches a repository_dispatch event for each recognised callback", async () => {
  const fetch = makeFetch([
    updatesResponse([update(100), update(101, { outcome: "merged", episodicId: "ep-2", cqId: "cq2" })]),
    { ok: true, body: { ok: true } }, // answerCallbackQuery #1
    { ok: true, body: { ok: true } }, // answerCallbackQuery #2
  ]);
  const gh = makeGh();

  const r = await runBotOnce({ botToken: "tok", repo: "acme/x", fetch, gh, pollTimeoutSec: 0 });
  assert.equal(r.parsed.length, 2);
  assert.equal(r.dispatched.length, 2);
  assert.equal(r.errors.length, 0);
  assert.equal(r.nextOffset, 102);

  // 2 dispatches fired through gh
  const dispatches = gh.calls.filter((c) => c.args.some((a) => a.includes("/dispatches")));
  assert.equal(dispatches.length, 2);
  const [d1, d2] = dispatches;
  assert.ok(d1.input.includes("conclave-rework"));
  assert.ok(d1.input.includes("ep-1"));
  assert.ok(d2.input.includes("conclave-merge"));
  assert.ok(d2.input.includes("ep-2"));
});

test("runBotOnce: non-callback updates still advance the offset", async () => {
  const fetch = makeFetch([
    updatesResponse([
      { update_id: 50, message: { text: "hello" } },
      { update_id: 51, my_chat_member: {} },
    ]),
  ]);
  const gh = makeGh();
  const r = await runBotOnce({ botToken: "t", repo: "a/b", fetch, gh, pollTimeoutSec: 0 });
  assert.equal(r.parsed.length, 0);
  assert.equal(r.dispatched.length, 0);
  assert.equal(r.nextOffset, 52);
  assert.equal(gh.calls.length, 0);
});

test("runBotOnce: allowOutcomes filters out disallowed outcomes but still acks them", async () => {
  const fetch = makeFetch([
    updatesResponse([update(200, { outcome: "merged" })]),
    { ok: true, body: { ok: true } }, // answerCallbackQuery
  ]);
  const gh = makeGh();
  const r = await runBotOnce({
    botToken: "t",
    repo: "a/b",
    fetch,
    gh,
    allowOutcomes: ["reworked"],
    pollTimeoutSec: 0,
  });
  assert.equal(r.parsed.length, 1);
  assert.equal(r.dispatched.length, 0);
  assert.equal(gh.calls.length, 0);
  // Still acked so the user sees "disabled"
  const ackCalls = fetch.calls.filter((c) => c.url.includes("answerCallbackQuery"));
  assert.equal(ackCalls.length, 1);
  assert.ok(JSON.parse(ackCalls[0].init.body).text.includes("disabled"));
});

test("runBotOnce: dispatch error records per-update error but does not throw", async () => {
  const fetch = makeFetch([
    updatesResponse([update(300)]),
    { ok: true, body: { ok: true } }, // answerCallbackQuery showing warning
  ]);
  const gh = async (_bin, _args, _opts) => {
    throw new Error("gh api boom");
  };
  const r = await runBotOnce({ botToken: "t", repo: "a/b", fetch, gh, pollTimeoutSec: 0 });
  assert.equal(r.parsed.length, 1);
  assert.equal(r.dispatched.length, 0);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].updateId, 300);
  assert.ok(r.errors[0].message.includes("gh api boom"));
  // Offset still advances so we don't re-attempt forever
  assert.equal(r.nextOffset, 301);
});

test("runBotOnce: --no-ack (ackCallbacks:false) never calls answerCallbackQuery", async () => {
  const fetch = makeFetch([updatesResponse([update(1)])]);
  const gh = makeGh();
  const r = await runBotOnce({
    botToken: "t",
    repo: "a/b",
    fetch,
    gh,
    ackCallbacks: false,
    pollTimeoutSec: 0,
  });
  assert.equal(r.dispatched.length, 1);
  const ackCalls = fetch.calls.filter((c) => c.url.includes("answerCallbackQuery"));
  assert.equal(ackCalls.length, 0);
});

test("runBotOnce: empty getUpdates result leaves offset unchanged", async () => {
  const fetch = makeFetch([updatesResponse([])]);
  const gh = makeGh();
  const r = await runBotOnce({ botToken: "t", repo: "a/b", fetch, gh, offset: 500, pollTimeoutSec: 0 });
  assert.equal(r.parsed.length, 0);
  assert.equal(r.dispatched.length, 0);
  // When offset is provided, we pass it through unchanged rather than omitting
  assert.equal(r.nextOffset, 500);
  const updatesCall = fetch.calls.find((c) => c.url.includes("getUpdates"));
  assert.ok(updatesCall.url.includes("offset=500"));
});

test("runBotOnce: custom eventTypeFor is honoured", async () => {
  const fetch = makeFetch([
    updatesResponse([update(700)]),
    { ok: true, body: { ok: true } },
  ]);
  const gh = makeGh();
  await runBotOnce({
    botToken: "t",
    repo: "a/b",
    fetch,
    gh,
    eventTypeFor: (o) => `custom-${o}`,
    pollTimeoutSec: 0,
  });
  const dispatch = gh.calls.find((c) => c.args.some((a) => a.includes("/dispatches")));
  assert.ok(dispatch.input.includes("custom-reworked"));
});

test("runBotOnce: client_payload includes triggeredBy when user is known", async () => {
  const fetch = makeFetch([
    updatesResponse([update(900)]),
    { ok: true, body: { ok: true } },
  ]);
  const gh = makeGh();
  await runBotOnce({ botToken: "t", repo: "a/b", fetch, gh, pollTimeoutSec: 0 });
  const dispatch = gh.calls.find((c) => c.args.some((a) => a.includes("/dispatches")));
  const body = JSON.parse(dispatch.input);
  assert.equal(body.client_payload.triggeredBy, "bae");
  assert.equal(body.client_payload.episodic, "ep-1");
  assert.equal(body.client_payload.outcome, "reworked");
});

test("runBotOnce: getUpdates failure is surfaced as a thrown error", async () => {
  const fetch = makeFetch([{ ok: false, status: 401, body: { ok: false, description: "unauthorized" } }]);
  const gh = makeGh();
  await assert.rejects(
    () => runBotOnce({ botToken: "t", repo: "a/b", fetch, gh, pollTimeoutSec: 0 }),
    /telegram getUpdates.*401/,
  );
});

test("TelegramClient.getUpdates: passes an AbortSignal on the fetch init", async () => {
  // We receive the fetch init and check that `signal` is present and is an
  // AbortSignal — this is the contract that prevents the cancellation-
  // consumes-callbacks bug (run 24634355279 on eventbadge).
  const fetch = makeFetch([updatesResponse([])]);
  const gh = makeGh();
  await runBotOnce({ botToken: "t", repo: "a/b", fetch, gh, pollTimeoutSec: 0 });
  const getUpdatesCall = fetch.calls.find((c) => c.url.includes("getUpdates"));
  assert.ok(getUpdatesCall, "getUpdates was not called");
  assert.ok(getUpdatesCall.init?.signal, "fetch init is missing an AbortSignal");
  assert.equal(typeof getUpdatesCall.init.signal.aborted, "boolean", "signal doesn't look like an AbortSignal");
});

test("TelegramClient.getUpdates: translates fetch AbortError into an actionable message", async () => {
  // Simulate a fetch that throws AbortError (e.g. because the client-side
  // timeout fired). The caller should see a wrapped error that names what
  // happened so the workflow log is legible, not a raw AbortError stack.
  const fetchThatAborts = async (_url, _init) => {
    const err = new Error("The user aborted a request.");
    err.name = "AbortError";
    throw err;
  };
  const gh = makeGh();
  await assert.rejects(
    () => runBotOnce({ botToken: "t", repo: "a/b", fetch: fetchThatAborts, gh, pollTimeoutSec: 0 }),
    /aborted after \d+s without response/,
  );
});
