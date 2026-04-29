/**
 * PIA-6 — Anthropic API error classification.
 *
 * Pre-PIA-6, autofix's worker-error path returned `err.message`
 * verbatim. Five operationally distinct issues — bad API key (401),
 * exhausted credit (400+billing), rate limit (429), transient overload
 * (529), malformed prompt (400 generic) — all surfaced identically as
 * "ClaudeWorker call failed: ..." with no action guidance.
 *
 * classifyAnthropicError + formatClassifiedReason convert raw errors
 * into a tagged classification with a one-line user action and a
 * retry hint. autofix-worker.ts uses formatClassifiedReason as the
 * BlockerFix.reason so the PR comment + Telegram show the actionable
 * line instead of the raw blob.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyAnthropicError,
  formatClassifiedReason,
} from "../dist/lib/anthropic-error-classify.js";

test("PIA-6: 401 → kind=auth, retryable=false, mentions ANTHROPIC_API_KEY", () => {
  const err = Object.assign(new Error("401 Unauthorized: invalid x-api-key"), {
    status: 401,
  });
  const c = classifyAnthropicError(err);
  assert.equal(c.kind, "auth");
  assert.equal(c.retryable, false);
  assert.match(c.userMessage, /ANTHROPIC_API_KEY|API key/i);
});

test("PIA-6: 403 → kind=permission, mentions plan/permission", () => {
  const err = Object.assign(new Error("403 Forbidden: permission_denied"), {
    status: 403,
  });
  const c = classifyAnthropicError(err);
  assert.equal(c.kind, "permission");
  assert.equal(c.retryable, false);
  assert.match(c.userMessage, /permission|plan/i);
});

test("PIA-6: credit balance too low → kind=credit, mentions billing/top up", () => {
  // Live message text from real Anthropic API response.
  const err = new Error(
    "400 invalid_request_error: Your credit balance is too low to access the Claude API.",
  );
  const c = classifyAnthropicError(err);
  assert.equal(c.kind, "credit");
  assert.equal(c.retryable, false);
  assert.match(c.userMessage, /top up|billing/i);
});

test("PIA-6: 400 invalid_request without credit text → kind=invalid-request, suggests bug report", () => {
  const err = new Error("400 invalid_request_error: messages.0.content is required");
  const c = classifyAnthropicError(err);
  assert.equal(c.kind, "invalid-request");
  assert.equal(c.retryable, false);
  assert.match(c.userMessage, /malformed|prompt|bug|file an issue/i);
});

test("PIA-6: 404 not_found → kind=not-found, suggests CLI update", () => {
  const err = new Error(
    "404 not_found_error: model 'claude-opus-99' not found",
  );
  const c = classifyAnthropicError(err);
  assert.equal(c.kind, "not-found");
  assert.equal(c.retryable, false);
  assert.match(c.userMessage, /update|stale|CLI/i);
});

test("PIA-6: 429 rate_limit → kind=rate-limit, retryable=true", () => {
  const err = Object.assign(
    new Error("429 rate_limit_error: rate limit hit"),
    { status: 429 },
  );
  const c = classifyAnthropicError(err);
  assert.equal(c.kind, "rate-limit");
  assert.equal(c.retryable, true);
  assert.match(c.userMessage, /rate limit|retry|backoff/i);
});

test("PIA-6: 529 overloaded → kind=overloaded, retryable=true", () => {
  const err = Object.assign(
    new Error("529 overloaded_error: Anthropic API overloaded"),
    { status: 529 },
  );
  const c = classifyAnthropicError(err);
  assert.equal(c.kind, "overloaded");
  assert.equal(c.retryable, true);
  assert.match(c.userMessage, /overloaded|retry/i);
});

test("PIA-6: 500-class server error → kind=server, retryable=true", () => {
  const err = Object.assign(
    new Error("500 internal_server_error: api_error"),
    { status: 500 },
  );
  const c = classifyAnthropicError(err);
  assert.equal(c.kind, "server");
  assert.equal(c.retryable, true);
});

test("PIA-6: ECONNREFUSED / ECONNRESET → kind=transport, retryable=true", () => {
  const cases = [
    new Error("connect ECONNREFUSED 127.0.0.1:443"),
    new Error("read ECONNRESET"),
    new Error("getaddrinfo ENOTFOUND api.anthropic.com"),
    new Error("fetch failed"),
  ];
  for (const err of cases) {
    const c = classifyAnthropicError(err);
    assert.equal(c.kind, "transport", `expected transport for: ${err.message}`);
    assert.equal(c.retryable, true);
    assert.match(c.userMessage, /network|retry|connectivity/i);
  }
});

test("PIA-6: unrecognised error → kind=unknown, retryable=false", () => {
  const err = new Error("kfajowiefjawoiefj");
  const c = classifyAnthropicError(err);
  assert.equal(c.kind, "unknown");
  assert.equal(c.retryable, false);
});

test("PIA-6: classifier handles non-Error inputs gracefully", () => {
  const c1 = classifyAnthropicError("plain string");
  assert.equal(c1.kind, "unknown");
  const c2 = classifyAnthropicError(null);
  assert.equal(c2.kind, "unknown");
  const c3 = classifyAnthropicError({ status: 429, body: "rate_limit_error" });
  // Object with status hits the 429 branch.
  assert.equal(c3.kind, "rate-limit");
});

test("PIA-6: rawSnippet truncates long error blobs to 300 chars + ellipsis", () => {
  const long = "x".repeat(1000);
  const c = classifyAnthropicError(new Error(long));
  assert.ok(c.rawSnippet.length <= 301, `got length ${c.rawSnippet.length}`);
  assert.ok(c.rawSnippet.endsWith("…"));
});

test("PIA-6: formatClassifiedReason produces a one-line user-facing string", () => {
  const c = classifyAnthropicError(
    new Error("400 invalid_request_error: credit balance too low"),
  );
  const formatted = formatClassifiedReason(c);
  assert.match(formatted, /\[anthropic:credit\]/);
  assert.match(formatted, /top up|billing/i);
  // Includes the raw snippet for debugging.
  assert.match(formatted, /raw:.*credit balance/i);
  // Single line.
  assert.equal(formatted.split("\n").length, 1);
});

test("PIA-6: formatClassifiedReason marks retryable kinds with :retryable tag", () => {
  const transient = classifyAnthropicError(
    Object.assign(new Error("529 overloaded"), { status: 529 }),
  );
  assert.match(formatClassifiedReason(transient), /\[anthropic:overloaded:retryable\]/);
  const terminal = classifyAnthropicError(
    Object.assign(new Error("401 invalid key"), { status: 401 }),
  );
  // No :retryable suffix for non-retryable kinds.
  assert.match(formatClassifiedReason(terminal), /\[anthropic:auth\]/);
  assert.doesNotMatch(formatClassifiedReason(terminal), /:retryable/);
});

test("PIA-6: SDK-shaped errors (status field set, message has body JSON) classify correctly", () => {
  // Reproduce the shape Anthropic SDK throws.
  const sdkLike = Object.assign(new Error("Request failed: 429 rate_limit_error"), {
    status: 429,
    statusCode: 429,
  });
  const c = classifyAnthropicError(sdkLike);
  assert.equal(c.kind, "rate-limit");
});
