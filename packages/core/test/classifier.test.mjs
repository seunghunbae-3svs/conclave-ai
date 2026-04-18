import { test } from "node:test";
import assert from "node:assert/strict";
import { RuleBasedClassifier, newEpisodicId } from "../dist/index.js";

const now = () => new Date().toISOString();

function mkEpisodic(reviews, overrides = {}) {
  return {
    id: "ep-test",
    createdAt: now(),
    repo: "acme/app",
    pullNumber: 7,
    sha: "abc1234",
    diffSha256: "a".repeat(64),
    reviews,
    councilVerdict: overrides.councilVerdict ?? "approve",
    outcome: overrides.outcome ?? "pending",
    costUsd: 0.01,
    ...overrides,
  };
}

test("newEpisodicId: returns ep-prefixed UUID-shape", () => {
  const id = newEpisodicId();
  assert.match(id, /^ep-[0-9a-f-]+$/);
});

test("classify merged: single answer-key, no failures", () => {
  const c = new RuleBasedClassifier();
  const out = c.classify(
    mkEpisodic([{ agent: "claude", verdict: "approve", blockers: [], summary: "LGTM" }]),
    "merged",
  );
  assert.equal(out.answerKeys.length, 1);
  assert.equal(out.failures.length, 0);
  assert.equal(out.answerKeys[0].domain, "code");
  assert.match(out.answerKeys[0].pattern, /by-repo\/acme\/app/);
  assert.match(out.answerKeys[0].lesson, /LGTM/);
});

test("classify merged: empty summary falls back to default lesson", () => {
  const c = new RuleBasedClassifier();
  const out = c.classify(
    mkEpisodic([{ agent: "claude", verdict: "approve", blockers: [], summary: "" }]),
    "merged",
  );
  assert.match(out.answerKeys[0].lesson, /Merged without blockers/);
});

test("classify rejected: one failure per unique (category, severity, message)", () => {
  const c = new RuleBasedClassifier();
  const out = c.classify(
    mkEpisodic([
      {
        agent: "claude",
        verdict: "reject",
        blockers: [
          { severity: "blocker", category: "type-error", message: "ts2345 mismatch", file: "x.ts", line: 10 },
          { severity: "major", category: "security", message: "secret in source" },
          { severity: "nit", category: "style", message: "trailing whitespace" },
        ],
        summary: "2 blockers + 1 nit",
      },
    ]),
    "rejected",
  );
  assert.equal(out.answerKeys.length, 0);
  assert.equal(out.failures.length, 2); // nit excluded
  const categories = out.failures.map((f) => f.category);
  assert.ok(categories.includes("type-error"));
  assert.ok(categories.includes("security"));
});

test("classify rejected: dedupes same (category, severity, message) across agents", () => {
  const c = new RuleBasedClassifier();
  const sameBlocker = { severity: "blocker", category: "security", message: "same leak" };
  const out = c.classify(
    mkEpisodic([
      { agent: "claude", verdict: "reject", blockers: [sameBlocker], summary: "" },
      { agent: "openai", verdict: "reject", blockers: [sameBlocker], summary: "" },
    ]),
    "rejected",
  );
  assert.equal(out.failures.length, 1);
});

test("classify reworked: behaves like rejected (writes failures)", () => {
  const c = new RuleBasedClassifier();
  const out = c.classify(
    mkEpisodic([
      {
        agent: "claude",
        verdict: "rework",
        blockers: [{ severity: "major", category: "missing-test", message: "no test for new branch" }],
        summary: "1 major",
      },
    ]),
    "reworked",
  );
  assert.equal(out.answerKeys.length, 0);
  assert.equal(out.failures.length, 1);
  assert.equal(out.failures[0].category, "missing-test");
});

test("category mapping: free-form strings normalize to allowed enum", () => {
  const c = new RuleBasedClassifier();
  const { failures } = c.classify(
    mkEpisodic([
      {
        agent: "claude",
        verdict: "reject",
        blockers: [
          { severity: "blocker", category: "Type Error", message: "a" },
          { severity: "blocker", category: "UNUSED IMPORT", message: "b" },
          { severity: "blocker", category: "a11y", message: "c" },
          { severity: "blocker", category: "weird-custom", message: "d" },
        ],
        summary: "",
      },
    ]),
    "rejected",
  );
  const cats = failures.map((f) => f.category);
  assert.ok(cats.includes("type-error"));
  assert.ok(cats.includes("dead-code"));
  assert.ok(cats.includes("accessibility"));
  assert.ok(cats.includes("other"));
});

test("classify merged: tags derived from categories seen in review", () => {
  const c = new RuleBasedClassifier();
  const { answerKeys } = c.classify(
    mkEpisodic([
      {
        agent: "claude",
        verdict: "approve",
        blockers: [{ severity: "minor", category: "unused-imports", message: "ok" }],
        summary: "all fine after rework",
      },
    ]),
    "merged",
  );
  assert.ok(answerKeys[0].tags.includes("unused-imports"));
});

test("classify: ids are stable for the same input", () => {
  const c = new RuleBasedClassifier();
  const ep = mkEpisodic([
    { agent: "claude", verdict: "reject", blockers: [{ severity: "blocker", category: "security", message: "leak" }], summary: "" },
  ]);
  const a = c.classify(ep, "rejected");
  const b = c.classify(ep, "rejected");
  assert.equal(a.failures[0].id, b.failures[0].id);
});
