import { test } from "node:test";
import assert from "node:assert/strict";
import { renderEmail } from "../dist/index.js";

function mkInput(overrides = {}) {
  return {
    outcome: {
      verdict: "approve",
      rounds: 1,
      consensusReached: true,
      results: [{ agent: "claude", verdict: "approve", blockers: [], summary: "LGTM" }],
    },
    ctx: { diff: "", repo: "acme/app", pullNumber: 42, newSha: "abc123def" },
    episodicId: "ep-mail-1",
    totalCostUsd: 0.021,
    ...overrides,
  };
}

test("renderEmail: subject contains verdict + repo + pr", () => {
  const { subject } = renderEmail(mkInput());
  assert.match(subject, /\[conclave\] APPROVE — acme\/app #42/);
});

test("renderEmail: subject no PR when pullNumber is 0", () => {
  const { subject } = renderEmail(mkInput({ ctx: { diff: "", repo: "acme/app", pullNumber: 0, newSha: "x" } }));
  assert.equal(subject, "[conclave] APPROVE — acme/app");
});

test("renderEmail: text body has verdict/repo/sha lines and per-agent section", () => {
  const { text } = renderEmail(mkInput());
  assert.match(text, /Verdict: APPROVE/);
  assert.match(text, /Repo:\s+acme\/app #42/);
  assert.match(text, /SHA:\s+abc123def/);
  assert.match(text, /claude → APPROVE/);
  assert.match(text, /LGTM/);
});

test("renderEmail: text body has 'no consensus' tag when applicable", () => {
  const { text } = renderEmail(
    mkInput({
      outcome: {
        verdict: "rework",
        rounds: 1,
        consensusReached: false,
        results: [{ agent: "claude", verdict: "rework", blockers: [], summary: "" }],
      },
    }),
  );
  assert.match(text, /no consensus reached/);
});

test("renderEmail: text body severity-sorts up to 5 blockers", () => {
  const blockers = [
    { severity: "nit", category: "style", message: "nit one" },
    { severity: "blocker", category: "security", message: "block one", file: "x.ts", line: 3 },
    { severity: "minor", category: "dead-code", message: "minor one" },
    { severity: "major", category: "regression", message: "major one" },
    { severity: "blocker", category: "type-error", message: "block two" },
    { severity: "nit", category: "style", message: "nit two" },
    { severity: "minor", category: "dead-code", message: "minor two" },
  ];
  const { text } = renderEmail(
    mkInput({
      outcome: {
        verdict: "reject",
        rounds: 1,
        consensusReached: true,
        results: [{ agent: "claude", verdict: "reject", blockers, summary: "" }],
      },
    }),
  );
  const i1 = text.indexOf("block one");
  const i2 = text.indexOf("block two");
  const i3 = text.indexOf("major one");
  assert.ok(i1 < i2);
  assert.ok(i2 < i3);
  assert.match(text, /\+2 more/); // 7 - 5 = 2
  assert.match(text, /x\.ts:3/);
});

test("renderEmail: text footer includes cost + episodic id", () => {
  const { text } = renderEmail(mkInput({ totalCostUsd: 0.0345, episodicId: "ep-xyz" }));
  assert.match(text, /\$0\.0345/);
  assert.match(text, /ep-xyz/);
});

test("renderEmail: HTML body uses inline styles only (email-safe)", () => {
  const { html } = renderEmail(mkInput());
  assert.match(html, /<h2 style=/);
  assert.match(html, /<div style=/);
  assert.ok(!html.includes("<style>"), "no <style> blocks allowed (unreliable in email clients)");
  assert.ok(!html.includes("<link"), "no external stylesheets allowed");
});

test("renderEmail: HTML escapes <, >, &, \"", () => {
  const { html } = renderEmail(
    mkInput({
      outcome: {
        verdict: "rework",
        rounds: 1,
        consensusReached: true,
        results: [
          {
            agent: "claude",
            verdict: "rework",
            blockers: [{ severity: "blocker", category: "type-error", message: `got <never> "expected"` }],
            summary: "a & b",
          },
        ],
      },
    }),
  );
  assert.match(html, /&lt;never&gt;/);
  assert.match(html, /&quot;expected&quot;/);
  assert.match(html, /a &amp; b/);
});

test("renderEmail: HTML links to prUrl", () => {
  const { html } = renderEmail(mkInput({ prUrl: "https://github.com/acme/app/pull/42" }));
  assert.match(html, /<a href="https:\/\/github\.com\/acme\/app\/pull\/42"/);
});

test("renderEmail: HTML has color-coded verdict headline", () => {
  const approve = renderEmail(mkInput());
  assert.match(approve.html, /#16a34a/);
  const reject = renderEmail(
    mkInput({
      outcome: {
        verdict: "reject",
        rounds: 1,
        consensusReached: true,
        results: [{ agent: "claude", verdict: "reject", blockers: [], summary: "" }],
      },
    }),
  );
  assert.match(reject.html, /#dc2626/);
});

test("renderEmail: (no blockers) placeholder per agent in both text + html", () => {
  const { text, html } = renderEmail(mkInput());
  assert.match(text, /no blockers/);
  assert.match(html, /no blockers/);
});
