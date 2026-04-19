import { test } from "node:test";
import assert from "node:assert/strict";
import { formatReviewForSlack } from "../dist/index.js";

function mkInput(overrides = {}) {
  return {
    outcome: {
      verdict: "approve",
      rounds: 1,
      consensusReached: true,
      results: [{ agent: "claude", verdict: "approve", blockers: [], summary: "LGTM" }],
    },
    ctx: { diff: "", repo: "acme/app", pullNumber: 42, newSha: "sha-head" },
    episodicId: "ep-slack-1",
    totalCostUsd: 0.0123,
    ...overrides,
  };
}

test("formatReviewForSlack: top-level text fallback summarizes verdict + repo", () => {
  const p = formatReviewForSlack(mkInput());
  assert.match(p.text, /APPROVE/);
  assert.match(p.text, /acme\/app #42/);
});

test("formatReviewForSlack: header section uses slack mrkdwn link when prUrl supplied", () => {
  const p = formatReviewForSlack(mkInput({ prUrl: "https://github.com/acme/app/pull/42" }));
  const first = p.blocks.find((b) => b.type === "section");
  assert.match(first.text.text, /<https:\/\/github\.com\/acme\/app\/pull\/42\|/);
});

test("formatReviewForSlack: no-consensus context block", () => {
  const p = formatReviewForSlack(
    mkInput({
      outcome: {
        verdict: "rework",
        rounds: 1,
        consensusReached: false,
        results: [{ agent: "claude", verdict: "rework", blockers: [], summary: "" }],
      },
    }),
  );
  const ctx = p.blocks.find((b) => b.type === "context" && b.elements?.[0]?.text?.includes("consensus"));
  assert.ok(ctx);
});

test("formatReviewForSlack: escapes slack-special chars (< > &)", () => {
  const p = formatReviewForSlack(
    mkInput({
      outcome: {
        verdict: "rework",
        rounds: 1,
        consensusReached: true,
        results: [
          {
            agent: "claude",
            verdict: "rework",
            blockers: [{ severity: "blocker", category: "type-error", message: "got <never> expected" }],
            summary: "a & b",
          },
        ],
      },
    }),
  );
  const agentSection = p.blocks.find((b) => b.type === "section" && b.text?.text?.includes("claude"));
  assert.ok(agentSection);
  assert.match(agentSection.text.text, /&lt;never&gt;/);
  assert.match(agentSection.text.text, /a &amp; b/);
});

test("formatReviewForSlack: severity-sorted top-3 + overflow count", () => {
  const blockers = [
    { severity: "nit", category: "style", message: "nit one" },
    { severity: "blocker", category: "security", message: "block one" },
    { severity: "minor", category: "dead-code", message: "minor one" },
    { severity: "major", category: "regression", message: "major one" },
    { severity: "blocker", category: "type-error", message: "block two" },
  ];
  const p = formatReviewForSlack(
    mkInput({
      outcome: {
        verdict: "reject",
        rounds: 1,
        consensusReached: true,
        results: [{ agent: "claude", verdict: "reject", blockers, summary: "" }],
      },
    }),
  );
  const section = p.blocks.find((b) => b.type === "section" && b.text?.text?.includes("claude"));
  const txt = section.text.text;
  const i1 = txt.indexOf("block one");
  const i2 = txt.indexOf("block two");
  const i3 = txt.indexOf("major one");
  assert.ok(i1 < i2);
  assert.ok(i2 < i3);
  assert.match(txt, /\+2 more/);
});

test("formatReviewForSlack: footer context block has cost + episodic id", () => {
  const p = formatReviewForSlack(mkInput({ totalCostUsd: 0.0345, episodicId: "ep-z" }));
  const footer = p.blocks[p.blocks.length - 1];
  assert.equal(footer.type, "context");
  assert.match(footer.elements[0].text, /\$0\.0345/);
  assert.match(footer.elements[0].text, /ep-z/);
});

test("formatReviewForSlack: dividers bracket the per-agent sections", () => {
  const p = formatReviewForSlack(mkInput());
  const dividers = p.blocks.filter((b) => b.type === "divider");
  assert.equal(dividers.length, 2);
});

test("formatReviewForSlack: caps total blocks under 50", () => {
  const many = [];
  for (let i = 0; i < 60; i += 1) {
    many.push({ agent: `a-${i}`, verdict: "approve", blockers: [], summary: "" });
  }
  const p = formatReviewForSlack(
    mkInput({
      outcome: {
        verdict: "approve",
        rounds: 1,
        consensusReached: true,
        results: many,
      },
    }),
  );
  assert.ok(p.blocks.length <= 50);
});

test("formatReviewForSlack: (no blockers) placeholder per agent", () => {
  const p = formatReviewForSlack(mkInput());
  const section = p.blocks.find((b) => b.type === "section" && b.text?.text?.includes("claude"));
  assert.match(section.text.text, /no blockers/);
});

test("formatReviewForSlack: truncates section text at 2900 chars", () => {
  const huge = "x".repeat(10_000);
  const p = formatReviewForSlack(
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
  for (const b of p.blocks) {
    if (b.text) assert.ok(b.text.text.length <= 2900, `block text too long: ${b.text.text.length}`);
  }
});
