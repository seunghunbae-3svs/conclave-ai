import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AnswerKeySchema,
  EpisodicEntrySchema,
  FailureEntrySchema,
  SemanticRuleSchema,
  formatAnswerKeyForPrompt,
} from "../dist/index.js";

test("AnswerKeySchema: minimal valid shape passes", () => {
  const parsed = AnswerKeySchema.parse({
    id: "ak-1",
    createdAt: new Date().toISOString(),
    domain: "code",
    pattern: "by-pattern/auth-middleware",
    lesson: "middleware should be stateless and compose left-to-right",
    tags: ["auth", "middleware"],
  });
  assert.equal(parsed.pattern, "by-pattern/auth-middleware");
});

test("AnswerKeySchema: rejects invalid domain", () => {
  assert.throws(() =>
    AnswerKeySchema.parse({
      id: "ak-1",
      createdAt: new Date().toISOString(),
      domain: "infra", // not in enum
      pattern: "x",
      lesson: "y",
    }),
  );
});

test("FailureEntrySchema: minimal valid shape passes", () => {
  const parsed = FailureEntrySchema.parse({
    id: "fc-1",
    createdAt: new Date().toISOString(),
    domain: "code",
    category: "type-error",
    severity: "blocker",
    title: "Unsafe any",
    body: "Do not add `as any` to work around strict typing.",
  });
  assert.equal(parsed.category, "type-error");
});

test("FailureEntrySchema: rejects unknown category", () => {
  assert.throws(() =>
    FailureEntrySchema.parse({
      id: "x",
      createdAt: new Date().toISOString(),
      domain: "code",
      category: "telepathy", // not in enum
      severity: "blocker",
      title: "t",
      body: "b",
    }),
  );
});

test("EpisodicEntrySchema: accepts a full council outcome shape", () => {
  const parsed = EpisodicEntrySchema.parse({
    id: "ep-1",
    createdAt: new Date().toISOString(),
    repo: "acme/demo",
    pullNumber: 42,
    sha: "abc123",
    diffSha256: "a".repeat(64),
    reviews: [
      {
        agent: "claude",
        verdict: "approve",
        blockers: [],
        summary: "LGTM",
      },
    ],
    councilVerdict: "approve",
    outcome: "merged",
    costUsd: 0.012,
  });
  assert.equal(parsed.reviews.length, 1);
});

test("SemanticRuleSchema: default evidence arrays", () => {
  const parsed = SemanticRuleSchema.parse({
    id: "r-1",
    createdAt: new Date().toISOString(),
    tag: "auth",
    rule: "never log the full JWT — truncate to first/last 4 chars",
    evidence: {},
  });
  assert.deepEqual(parsed.evidence.answerKeyIds, []);
  assert.deepEqual(parsed.evidence.failureIds, []);
});

// H2 #6 — schema + formatter coverage for the new fields

test("EpisodicEntrySchema: cycleNumber defaults to 1, priorEpisodicId is optional", () => {
  const parsed = EpisodicEntrySchema.parse({
    id: "ep-1",
    createdAt: new Date().toISOString(),
    repo: "acme/app",
    pullNumber: 1,
    sha: "abc",
    diffSha256: "a".repeat(64),
    reviews: [],
    councilVerdict: "approve",
    outcome: "merged",
    costUsd: 0,
  });
  assert.equal(parsed.cycleNumber, 1);
  assert.equal(parsed.priorEpisodicId, undefined);
});

test("AnswerKeySchema: removedBlockers defaults to []", () => {
  const parsed = AnswerKeySchema.parse({
    id: "ak-no-removed",
    createdAt: new Date().toISOString(),
    domain: "code",
    pattern: "by-repo/x",
    lesson: "ok",
    tags: [],
  });
  assert.deepEqual(parsed.removedBlockers, []);
});

test("formatAnswerKeyForPrompt: surfaces up to 3 removed-blocker examples", () => {
  const out = formatAnswerKeyForPrompt({
    id: "ak-1",
    createdAt: new Date().toISOString(),
    domain: "code",
    pattern: "by-repo/acme/app",
    lesson: "merged after rework",
    tags: ["debug-noise", "missing-test"],
    removedBlockers: [
      { category: "debug-noise", severity: "major", message: "console.log left in compressImage" },
      { category: "missing-test", severity: "major", message: "no test for new branch" },
      { category: "type-error", severity: "blocker", message: "ts2345 mismatch" },
      { category: "security", severity: "blocker", message: "fourth one truncated" },
    ],
  });
  assert.match(out, /Resolved before merge/);
  assert.match(out, /console\.log/);
  assert.match(out, /no test for new branch/);
  assert.match(out, /ts2345 mismatch/);
  assert.doesNotMatch(out, /fourth one truncated/);
});

test("formatAnswerKeyForPrompt: omits the resolved-before-merge line when no removed blockers", () => {
  const out = formatAnswerKeyForPrompt({
    id: "ak-2",
    createdAt: new Date().toISOString(),
    domain: "code",
    pattern: "by-repo/x",
    lesson: "clean merge",
    tags: [],
    removedBlockers: [],
  });
  assert.doesNotMatch(out, /Resolved before merge/);
});
