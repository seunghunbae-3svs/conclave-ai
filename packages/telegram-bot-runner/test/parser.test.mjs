import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCallbackData, extractCallback, defaultEventTypeFor } from "../dist/index.js";

// ---- parseCallbackData ----------------------------------------------------

test("parseCallbackData: parses valid ep:<id>:<outcome>", () => {
  assert.deepEqual(parseCallbackData("ep:abc123:merged"), { episodicId: "abc123", outcome: "merged" });
  assert.deepEqual(parseCallbackData("ep:x:reworked"), { episodicId: "x", outcome: "reworked" });
  assert.deepEqual(parseCallbackData("ep:id-with-dashes:rejected"), { episodicId: "id-with-dashes", outcome: "rejected" });
});

test("parseCallbackData: rejects missing prefix", () => {
  assert.equal(parseCallbackData("abc:def:merged"), null);
});

test("parseCallbackData: rejects unknown outcome", () => {
  assert.equal(parseCallbackData("ep:abc:shipit"), null);
  assert.equal(parseCallbackData("ep:abc:approve"), null); // approve is a verdict, not an outcome
});

test("parseCallbackData: rejects empty id", () => {
  assert.equal(parseCallbackData("ep::merged"), null);
});

test("parseCallbackData: handles id with colons by splitting on LAST", () => {
  assert.deepEqual(parseCallbackData("ep:id:with:colons:merged"), {
    episodicId: "id:with:colons",
    outcome: "merged",
  });
});

test("parseCallbackData: rejects null/undefined/empty", () => {
  assert.equal(parseCallbackData(undefined), null);
  assert.equal(parseCallbackData(null), null);
  assert.equal(parseCallbackData(""), null);
});

// ---- extractCallback ------------------------------------------------------

test("extractCallback: pulls a full BotCallback from a realistic update", () => {
  const update = {
    update_id: 12345,
    callback_query: {
      id: "cq-1",
      data: "ep:abc123:reworked",
      from: { username: "bae", first_name: "Bae" },
      message: { chat: { id: 987 }, message_id: 42 },
    },
  };
  const cb = extractCallback(update);
  assert.deepEqual(cb, {
    episodicId: "abc123",
    outcome: "reworked",
    callbackQueryId: "cq-1",
    updateId: 12345,
    chatId: 987,
    messageId: 42,
    user: "bae",
  });
});

test("extractCallback: falls back to first_name when username is missing", () => {
  const cb = extractCallback({
    update_id: 1,
    callback_query: {
      id: "cq",
      data: "ep:x:merged",
      from: { first_name: "Anonymous" },
    },
  });
  assert.equal(cb.user, "Anonymous");
});

test("extractCallback: returns null for non-callback updates", () => {
  assert.equal(extractCallback({ update_id: 1, message: { text: "hi" } }), null);
  assert.equal(extractCallback({}), null);
  assert.equal(extractCallback(null), null);
});

test("extractCallback: returns null for unrecognised callback data", () => {
  const cb = extractCallback({
    update_id: 1,
    callback_query: { id: "cq", data: "something-else" },
  });
  assert.equal(cb, null);
});

// ---- defaultEventTypeFor --------------------------------------------------

test("defaultEventTypeFor: maps each outcome to a distinct event type", () => {
  assert.equal(defaultEventTypeFor("merged"), "conclave-merge");
  assert.equal(defaultEventTypeFor("reworked"), "conclave-rework");
  assert.equal(defaultEventTypeFor("rejected"), "conclave-reject");
});
