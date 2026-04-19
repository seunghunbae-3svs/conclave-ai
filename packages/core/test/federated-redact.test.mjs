import { test } from "node:test";
import assert from "node:assert/strict";
import {
  redactAnswerKey,
  redactFailure,
  redactAll,
  normalizeTags,
  FederatedBaselineSchema,
} from "../dist/index.js";

const SAMPLE_KEY = {
  id: "ak-abc123",
  createdAt: "2026-04-19T10:34:56.000Z",
  domain: "code",
  pattern: "by-pattern/auth-middleware",
  repo: "secretorg/private-app",
  user: "seunghunbae-3svs",
  lesson: "Always validate JWT signatures BEFORE unpacking claims.",
  tags: ["Auth", "security", "auth", "  JWT "],
  episodicId: "ep-xyz",
};

const SAMPLE_FAILURE = {
  id: "fc-def456",
  createdAt: "2026-04-19T10:34:56.000Z",
  domain: "code",
  category: "security",
  severity: "blocker",
  title: "JWT signature check missing on /admin routes",
  body: "We accept unsigned tokens — replace with server-side verification.",
  snippet: "const payload = jwt.decode(token); // BUG",
  tags: ["auth", "security"],
  seedBlocker: {
    agent: "claude",
    severity: "blocker",
    message: "unsigned JWT accepted",
    file: "src/server/routes/admin.ts",
    line: 42,
  },
  episodicId: "ep-xyz",
};

test("normalizeTags: trims, lowercases, dedupes, sorts", () => {
  const out = normalizeTags(["Security", "  auth ", "AUTH", "a11y", ""]);
  assert.deepEqual(out, ["a11y", "auth", "security"]);
});

test("normalizeTags: empty input → empty output", () => {
  assert.deepEqual(normalizeTags([]), []);
});

test("redactAnswerKey: strips lesson/pattern/repo/user/id/episodicId", () => {
  const out = redactAnswerKey(SAMPLE_KEY);
  // Parse against the schema so any leaked field would fail validation
  const parsed = FederatedBaselineSchema.parse(out);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.kind, "answer-key");
  assert.equal(parsed.domain, "code");
  assert.deepEqual(parsed.tags, ["auth", "jwt", "security"]);
  assert.equal(parsed.dayBucket, "2026-04-19");
  // No category/severity on answer-keys
  assert.equal(parsed.category, undefined);
  assert.equal(parsed.severity, undefined);
  // Hash is sha256 (64 hex chars)
  assert.match(parsed.contentHash, /^[0-9a-f]{64}$/);
  // Sanity: the baseline object should NOT carry any of the private fields
  assert.equal("lesson" in out, false);
  assert.equal("pattern" in out, false);
  assert.equal("repo" in out, false);
  assert.equal("user" in out, false);
  assert.equal("id" in out, false);
  assert.equal("episodicId" in out, false);
});

test("redactFailure: strips title/body/snippet/seedBlocker/id/episodicId", () => {
  const out = redactFailure(SAMPLE_FAILURE);
  const parsed = FederatedBaselineSchema.parse(out);
  assert.equal(parsed.kind, "failure");
  assert.equal(parsed.category, "security");
  assert.equal(parsed.severity, "blocker");
  assert.deepEqual(parsed.tags, ["auth", "security"]);
  assert.equal("title" in out, false);
  assert.equal("body" in out, false);
  assert.equal("snippet" in out, false);
  assert.equal("seedBlocker" in out, false);
});

test("redactAnswerKey: deterministic hash — same (domain, tags) across users produces same hash", () => {
  const a = redactAnswerKey(SAMPLE_KEY);
  const b = redactAnswerKey({
    ...SAMPLE_KEY,
    id: "ak-different",
    repo: "otheruser/other-repo",
    user: "someone-else",
    lesson: "different wording, same pattern",
    pattern: "by-pattern/something-else", // pattern does NOT participate in the hash
  });
  assert.equal(a.contentHash, b.contentHash);
});

test("redactFailure: hash changes when category/severity changes", () => {
  const base = redactFailure(SAMPLE_FAILURE);
  const major = redactFailure({ ...SAMPLE_FAILURE, severity: "major" });
  const perf = redactFailure({ ...SAMPLE_FAILURE, category: "performance" });
  assert.notEqual(base.contentHash, major.contentHash);
  assert.notEqual(base.contentHash, perf.contentHash);
});

test("redactFailure: hash stable despite differing tag order + casing", () => {
  const a = redactFailure(SAMPLE_FAILURE);
  const b = redactFailure({ ...SAMPLE_FAILURE, tags: ["SECURITY", "Auth"] });
  assert.equal(a.contentHash, b.contentHash);
});

test("redactFailure vs redactAnswerKey: different kinds → different hashes even with same (domain, tags)", () => {
  const tags = ["x"];
  const ak = redactAnswerKey({ ...SAMPLE_KEY, tags });
  const fl = redactFailure({ ...SAMPLE_FAILURE, tags });
  assert.notEqual(ak.contentHash, fl.contentHash);
});

test("redactAll: concatenates answer-keys + failures, preserving order", () => {
  const out = redactAll([SAMPLE_KEY, SAMPLE_KEY], [SAMPLE_FAILURE]);
  assert.equal(out.length, 3);
  assert.equal(out[0].kind, "answer-key");
  assert.equal(out[1].kind, "answer-key");
  assert.equal(out[2].kind, "failure");
});

test("redactAnswerKey: dayBucket is YYYY-MM-DD even for end-of-day timestamps", () => {
  const key = { ...SAMPLE_KEY, createdAt: "2026-04-19T23:59:59.999Z" };
  assert.equal(redactAnswerKey(key).dayBucket, "2026-04-19");
});

test("redactAll: empty inputs → empty array", () => {
  assert.deepEqual(redactAll([], []), []);
});
