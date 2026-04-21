import { test } from "node:test";
import assert from "node:assert/strict";
import { renderReview, renderPlainSummarySection, verdictToExitCode } from "../dist/lib/output.js";
import { summarizeDiff } from "../dist/commands/review.js";

const baseMetrics = {
  callCount: 1,
  totalInputTokens: 1_000,
  totalOutputTokens: 200,
  totalCostUsd: 0.015,
  totalLatencyMs: 900,
  cacheHitRate: 0.5,
  byAgent: { claude: { calls: 1, costUsd: 0.015 } },
  byModel: { "claude-sonnet-4-6": { calls: 1, costUsd: 0.015 } },
};

test("verdictToExitCode: approve=0, rework=1, reject=2", () => {
  assert.equal(verdictToExitCode("approve"), 0);
  assert.equal(verdictToExitCode("rework"), 1);
  assert.equal(verdictToExitCode("reject"), 2);
});

test("renderReview: approve + no blockers produces clean output", () => {
  const out = renderReview({
    repo: "acme/my-app",
    pullNumber: 7,
    sha: "abcdef1234567890",
    source: "gh-pr",
    councilVerdict: "approve",
    consensus: true,
    results: [{ agent: "claude", verdict: "approve", blockers: [], summary: "LGTM" }],
    metrics: baseMetrics,
  });
  assert.match(out, /Verdict: APPROVE/);
  assert.match(out, /acme\/my-app #7/);
  assert.match(out, /no blockers/);
  assert.match(out, /cache hit:  50.0%/);
});

test("renderReview: rework with mixed-severity blockers sorts by severity", () => {
  const out = renderReview({
    repo: "acme/my-app",
    pullNumber: 0,
    sha: "sha",
    source: "git-diff",
    councilVerdict: "rework",
    consensus: false,
    results: [
      {
        agent: "claude",
        verdict: "rework",
        blockers: [
          { severity: "nit", category: "style", message: "unused var" },
          { severity: "blocker", category: "type-error", message: "ts2345", file: "x.ts", line: 10 },
          { severity: "major", category: "security", message: "hardcoded secret" },
        ],
        summary: "1 blocker + 1 major + 1 nit",
      },
    ],
    metrics: baseMetrics,
  });
  const blockerIdx = out.indexOf("[BLOCKER]");
  const majorIdx = out.indexOf("[MAJOR]");
  const nitIdx = out.indexOf("[NIT]");
  assert.ok(blockerIdx < majorIdx, "blocker should come before major");
  assert.ok(majorIdx < nitIdx, "major should come before nit");
  assert.match(out, /no consensus/);
  assert.match(out, /x\.ts:10/);
});

test("renderReview: reject output tagged", () => {
  const out = renderReview({
    repo: "acme/my-app",
    pullNumber: 1,
    sha: "sha",
    source: "gh-pr",
    councilVerdict: "reject",
    consensus: true,
    results: [{ agent: "claude", verdict: "reject", blockers: [], summary: "wrong approach" }],
    metrics: baseMetrics,
  });
  assert.match(out, /Verdict: REJECT/);
});

test("renderReview: metrics section rendered", () => {
  const out = renderReview({
    repo: "acme/my-app",
    pullNumber: 1,
    sha: "sha",
    source: "gh-pr",
    councilVerdict: "approve",
    consensus: true,
    results: [{ agent: "claude", verdict: "approve", blockers: [], summary: "" }],
    metrics: { ...baseMetrics, totalCostUsd: 0.0345 },
  });
  assert.match(out, /\$0\.0345/);
  assert.match(out, /calls:      1/);
});

// ─── plain summary section ───────────────────────────────────────────

test("renderPlainSummarySection: en locale emits English heading + prose", () => {
  const out = renderPlainSummarySection({
    whatChanged: "This change updates the badge contrast.",
    verdictInPlain: "Looks ok, one small fix needed.",
    nextAction: "Tighten contrast and re-check on mobile.",
    raw: "...",
    locale: "en",
  });
  assert.match(out, /### Plain summary/);
  assert.match(out, /This change updates the badge contrast/);
  assert.match(out, /Tighten contrast/);
});

test("renderPlainSummarySection: ko locale emits Korean heading", () => {
  const out = renderPlainSummarySection({
    whatChanged: "배지 대비를 바꿨다.",
    verdictInPlain: "문제 하나만 고치면 된다.",
    nextAction: "대비를 올리고 다시 확인한다.",
    raw: "...",
    locale: "ko",
  });
  assert.match(out, /### 한 줄 요약/);
  assert.match(out, /배지 대비를 바꿨다/);
});

// ─── diff summarizer ────────────────────────────────────────────────

test("summarizeDiff: counts +/- lines and files correctly", () => {
  const diff = `diff --git a/src/foo.ts b/src/foo.ts
index 123..456 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
diff --git a/src/bar.ts b/src/bar.ts
index abc..def 100644
--- a/src/bar.ts
+++ b/src/bar.ts
@@ -1,2 +1,2 @@
-const z = 9;
+const z = 10;
`;
  const stats = summarizeDiff(diff);
  assert.equal(stats.filesChanged, 2);
  assert.equal(stats.linesAdded, 3);
  assert.equal(stats.linesRemoved, 2);
  assert.ok(stats.topFiles.includes("src/foo.ts"));
  assert.ok(stats.topFiles.includes("src/bar.ts"));
});

test("summarizeDiff: handles empty diff", () => {
  const stats = summarizeDiff("");
  assert.equal(stats.filesChanged, 0);
  assert.equal(stats.linesAdded, 0);
  assert.equal(stats.linesRemoved, 0);
  assert.deepEqual(stats.topFiles, []);
});
