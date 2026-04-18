import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AnswerKeySchema,
  EpisodicEntrySchema,
  FailureEntrySchema,
  SemanticRuleSchema,
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
