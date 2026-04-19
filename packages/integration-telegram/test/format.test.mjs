import { test } from "node:test";
import assert from "node:assert/strict";
import { formatReviewForTelegram } from "../dist/index.js";

function mkInput(overrides = {}) {
  return {
    outcome: {
      verdict: "approve",
      rounds: 1,
      results: [{ agent: "claude", verdict: "approve", blockers: [], summary: "LGTM" }],
      consensusReached: true,
    },
    ctx: {
      diff: "",
      repo: "acme/app",
      pullNumber: 42,
      newSha: "abc123",
    },
    episodicId: "ep-test-1",
    totalCostUsd: 0.0153,
    ...overrides,
  };
}

test("formatReviewForTelegram: approve with HTML emoji header", () => {
  const msg = formatReviewForTelegram(mkInput());
  assert.match(msg, /✅ <b>APPROVE<\/b>/);
  assert.match(msg, /acme\/app.*#42/);
  assert.match(msg, /LGTM/);
});

test("formatReviewForTelegram: link to prUrl when supplied", () => {
  const msg = formatReviewForTelegram(mkInput({ prUrl: "https://github.com/acme/app/pull/42" }));
  assert.match(msg, /<a href="https:\/\/github\.com\/acme\/app\/pull\/42">/);
});

test("formatReviewForTelegram: escapes HTML-special chars in content", () => {
  const msg = formatReviewForTelegram(
    mkInput({
      outcome: {
        verdict: "rework",
        rounds: 1,
        consensusReached: true,
        results: [
          {
            agent: "claude",
            verdict: "rework",
            blockers: [
              { severity: "blocker", category: "type-error", message: "got <never> expected <string>", file: "x<.ts" },
            ],
            summary: "a & b",
          },
        ],
      },
    }),
  );
  assert.ok(!msg.includes("<never>"), "raw angle brackets must be escaped");
  assert.match(msg, /&lt;never&gt;/);
  assert.match(msg, /a &amp; b/);
});

test("formatReviewForTelegram: severity-sorts blockers and caps at 3", () => {
  const blockers = [
    { severity: "nit", category: "style", message: "nit 1" },
    { severity: "blocker", category: "security", message: "block 1" },
    { severity: "minor", category: "dead-code", message: "minor 1" },
    { severity: "major", category: "regression", message: "major 1" },
    { severity: "blocker", category: "type-error", message: "block 2" },
  ];
  const msg = formatReviewForTelegram(
    mkInput({
      outcome: {
        verdict: "reject",
        rounds: 1,
        consensusReached: true,
        results: [{ agent: "claude", verdict: "reject", blockers, summary: "" }],
      },
    }),
  );
  // Top-3 by severity: block 1, block 2, major 1
  const order = ["block 1", "block 2", "major 1"];
  let lastIdx = -1;
  for (const label of order) {
    const idx = msg.indexOf(label);
    assert.ok(idx > lastIdx, `expected "${label}" to appear in order`);
    lastIdx = idx;
  }
  assert.match(msg, /\+2 more/); // 5 blockers minus 3 shown = 2 more
});

test("formatReviewForTelegram: no-consensus tag", () => {
  const msg = formatReviewForTelegram(
    mkInput({
      outcome: {
        verdict: "rework",
        rounds: 1,
        consensusReached: false,
        results: [{ agent: "claude", verdict: "rework", blockers: [], summary: "" }],
      },
    }),
  );
  assert.match(msg, /no consensus/);
});

test("formatReviewForTelegram: footer includes cost + episodic id", () => {
  const msg = formatReviewForTelegram(mkInput({ totalCostUsd: 0.0345, episodicId: "ep-xyz" }));
  assert.match(msg, /\$0\.0345/);
  assert.match(msg, /ep-xyz/);
});

test("formatReviewForTelegram: truncates if longer than 4096 chars", () => {
  const huge = "x".repeat(12_000);
  const msg = formatReviewForTelegram(
    mkInput({
      outcome: {
        verdict: "rework",
        rounds: 1,
        consensusReached: true,
        results: [
          {
            agent: "claude",
            verdict: "rework",
            blockers: [{ severity: "blocker", category: "security", message: huge }],
            summary: "",
          },
        ],
      },
    }),
  );
  assert.ok(msg.length <= 4096, `expected ≤ 4096 chars, got ${msg.length}`);
  assert.ok(msg.endsWith("…"));
});

test("formatReviewForTelegram: (no blockers) placeholder when empty", () => {
  const msg = formatReviewForTelegram(mkInput());
  assert.match(msg, /no blockers/);
});
