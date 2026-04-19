import { test } from "node:test";
import assert from "node:assert/strict";
import { formatReviewForDiscord } from "../dist/index.js";

function mkInput(overrides = {}) {
  return {
    outcome: {
      verdict: "approve",
      rounds: 1,
      consensusReached: true,
      results: [{ agent: "claude", verdict: "approve", blockers: [], summary: "LGTM" }],
    },
    ctx: { diff: "", repo: "acme/app", pullNumber: 42, newSha: "abcdef1234567890" },
    episodicId: "ep-disc-1",
    totalCostUsd: 0.0153,
    ...overrides,
  };
}

test("formatReviewForDiscord: approve embed is green", () => {
  const payload = formatReviewForDiscord(mkInput());
  const embed = payload.embeds[0];
  assert.equal(embed.color, 0x22c55e);
  assert.match(embed.title, /✅ APPROVE/);
});

test("formatReviewForDiscord: reject embed is red", () => {
  const payload = formatReviewForDiscord(
    mkInput({
      outcome: {
        verdict: "reject",
        rounds: 1,
        consensusReached: true,
        results: [{ agent: "claude", verdict: "reject", blockers: [], summary: "wrong" }],
      },
    }),
  );
  assert.equal(payload.embeds[0].color, 0xef4444);
});

test("formatReviewForDiscord: rework embed is amber", () => {
  const payload = formatReviewForDiscord(
    mkInput({
      outcome: {
        verdict: "rework",
        rounds: 1,
        consensusReached: true,
        results: [{ agent: "claude", verdict: "rework", blockers: [], summary: "" }],
      },
    }),
  );
  assert.equal(payload.embeds[0].color, 0xf59e0b);
});

test("formatReviewForDiscord: embed links to prUrl when supplied", () => {
  const payload = formatReviewForDiscord(mkInput({ prUrl: "https://github.com/acme/app/pull/42" }));
  assert.equal(payload.embeds[0].url, "https://github.com/acme/app/pull/42");
});

test("formatReviewForDiscord: no consensus tag in description", () => {
  const payload = formatReviewForDiscord(
    mkInput({
      outcome: {
        verdict: "rework",
        rounds: 1,
        consensusReached: false,
        results: [{ agent: "claude", verdict: "rework", blockers: [], summary: "" }],
      },
    }),
  );
  assert.match(payload.embeds[0].description, /no consensus/);
});

test("formatReviewForDiscord: per-agent field with severity-sorted top-3 blockers", () => {
  const blockers = [
    { severity: "nit", category: "style", message: "nit 1" },
    { severity: "blocker", category: "security", message: "block 1", file: "x.ts", line: 4 },
    { severity: "minor", category: "dead-code", message: "minor 1" },
    { severity: "major", category: "regression", message: "major 1" },
    { severity: "blocker", category: "type-error", message: "block 2" },
  ];
  const payload = formatReviewForDiscord(
    mkInput({
      outcome: {
        verdict: "reject",
        rounds: 1,
        consensusReached: true,
        results: [{ agent: "claude", verdict: "reject", blockers, summary: "5 blockers" }],
      },
    }),
  );
  const field = payload.embeds[0].fields[0];
  assert.match(field.name, /❌ claude/);
  // Blockers, then block 2, then major 1 should appear in order
  const blockerIdx = field.value.indexOf("block 1");
  const block2Idx = field.value.indexOf("block 2");
  const majorIdx = field.value.indexOf("major 1");
  assert.ok(blockerIdx < block2Idx);
  assert.ok(block2Idx < majorIdx);
  // ...and "+2 more" since 5 blockers - 3 shown
  assert.match(field.value, /\+2 more/);
  // file:line rendered
  assert.match(field.value, /x\.ts:4/);
});

test("formatReviewForDiscord: field value truncates at 1024 chars", () => {
  const huge = "x".repeat(3000);
  const payload = formatReviewForDiscord(
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
  assert.ok(payload.embeds[0].fields[0].value.length <= 1024);
});

test("formatReviewForDiscord: footer includes cost + episodic id", () => {
  const payload = formatReviewForDiscord(mkInput({ totalCostUsd: 0.0345, episodicId: "ep-xyz" }));
  assert.match(payload.embeds[0].footer.text, /\$0\.0345/);
  assert.match(payload.embeds[0].footer.text, /ep-xyz/);
});

test("formatReviewForDiscord: timestamp is ISO and recent", () => {
  const payload = formatReviewForDiscord(mkInput());
  assert.match(payload.embeds[0].timestamp, /^\d{4}-\d{2}-\d{2}T/);
});

test("formatReviewForDiscord: (no blockers) placeholder per agent", () => {
  const payload = formatReviewForDiscord(mkInput());
  assert.match(payload.embeds[0].fields[0].value, /no blockers/);
});

test("formatReviewForDiscord: caps at 24 per-agent fields", () => {
  const manyResults = [];
  for (let i = 0; i < 30; i += 1) {
    manyResults.push({ agent: `agent-${i}`, verdict: "approve", blockers: [], summary: "" });
  }
  const payload = formatReviewForDiscord(
    mkInput({
      outcome: {
        verdict: "approve",
        rounds: 1,
        consensusReached: true,
        results: manyResults,
      },
    }),
  );
  assert.ok(payload.embeds[0].fields.length <= 24);
});
