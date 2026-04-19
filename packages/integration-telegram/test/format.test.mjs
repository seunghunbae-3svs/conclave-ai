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

test("formatReviewForTelegram: approve uses plain-language verdict label", () => {
  const msg = formatReviewForTelegram(mkInput());
  assert.match(msg, /✅ <b>Approved<\/b>/);
  assert.match(msg, /acme\/app.*#42/);
  assert.match(msg, /All agents agreed/);
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
});

test("formatReviewForTelegram: severity-sorts distinct blockers and caps at top 3", () => {
  const blockers = [
    { severity: "nit", category: "style", message: "nit 1", file: "a.ts", line: 1 },
    { severity: "blocker", category: "security", message: "block 1", file: "b.ts", line: 2 },
    { severity: "minor", category: "dead-code", message: "minor 1", file: "c.ts", line: 3 },
    { severity: "major", category: "regression", message: "major 1", file: "d.ts", line: 4 },
    { severity: "blocker", category: "type-error", message: "block 2", file: "e.ts", line: 5 },
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
  // Top-3 by severity: block 1, block 2, major 1 — should appear in that order
  const order = ["block 1", "block 2", "major 1"];
  let lastIdx = -1;
  for (const label of order) {
    const idx = msg.indexOf(label);
    assert.ok(idx > lastIdx, `expected "${label}" to appear in order, instead got index ${idx}`);
    lastIdx = idx;
  }
  assert.match(msg, /\+ 2 more issues/);
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

test("formatReviewForTelegram: footer shows cost (2 decimals) + episodic ref", () => {
  const msg = formatReviewForTelegram(mkInput({ totalCostUsd: 0.3664, episodicId: "ep-xyz" }));
  assert.match(msg, /\$0\.37/); // rounded to 2 decimals
  assert.match(msg, /ep-xyz/);
});

test("formatReviewForTelegram: truncates if longer than 4096 chars", () => {
  // Per-blocker messages are 220-char capped; force overflow via a
  // giant repo slug so the envelope alone exceeds the 4096 cap.
  const hugeRepo = "acme/" + "x".repeat(5000);
  const msg = formatReviewForTelegram(
    mkInput({
      ctx: { diff: "", repo: hugeRepo, pullNumber: 42, newSha: "abc" },
    }),
  );
  assert.ok(msg.length <= 4096, `expected ≤ 4096 chars, got ${msg.length}`);
  assert.ok(msg.endsWith("…"));
});

test("formatReviewForTelegram: humanizes technical category labels", () => {
  const msg = formatReviewForTelegram(
    mkInput({
      outcome: {
        verdict: "rework",
        rounds: 1,
        consensusReached: false,
        results: [
          {
            agent: "claude",
            verdict: "rework",
            blockers: [
              { severity: "major", category: "secrets-exposure", message: "key may leak", file: "x.yml", line: 12 },
              { severity: "major", category: "workflow-security", message: "PR secret access", file: "x.yml", line: 5 },
              { severity: "minor", category: "supply-chain", message: "unpinned dep", file: "x.yml", line: 30 },
            ],
            summary: "",
          },
        ],
      },
    }),
  );
  assert.match(msg, /Possible secret leak/);
  assert.match(msg, /CI workflow security/);
  assert.match(msg, /Supply-chain risk/);
  // Original technical keys should NOT appear in the rendered text
  assert.ok(!msg.includes("secrets-exposure"));
  assert.ok(!msg.includes("workflow-security"));
});

test("formatReviewForTelegram: merges cross-agent blockers at same file:line", () => {
  const shared = { severity: "major", category: "security", file: "app.ts", line: 42 };
  const msg = formatReviewForTelegram(
    mkInput({
      outcome: {
        verdict: "rework",
        rounds: 1,
        consensusReached: false,
        results: [
          {
            agent: "claude",
            verdict: "rework",
            blockers: [{ ...shared, message: "Claude: auth check missing" }],
            summary: "",
          },
          {
            agent: "openai",
            verdict: "rework",
            blockers: [{ ...shared, message: "OpenAI: missing auth check (slightly longer)" }],
            summary: "",
          },
        ],
      },
    }),
  );
  // Merged — only one entry for app.ts:42
  assert.equal(msg.match(/app\.ts:42/g)?.length, 1);
  // Agreement marker shown
  assert.match(msg, /Claude \+ Openai agree|Claude \+ OpenAI agree/i);
});

test("formatReviewForTelegram: no blockers named but not approved → fallback notice", () => {
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
  assert.match(msg, /No specific blockers named/);
});
