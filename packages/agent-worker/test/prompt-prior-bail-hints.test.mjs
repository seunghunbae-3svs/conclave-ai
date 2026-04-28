import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCacheablePrefix } from "../dist/index.js";

const baseCtx = {
  repo: "acme/app",
  pullNumber: 1,
  newSha: "sha",
  reviews: [
    {
      agent: "claude",
      verdict: "rework",
      blockers: [{ severity: "major", category: "debug-noise", message: "x" }],
      summary: "1 blocker",
    },
  ],
  fileSnapshots: [{ path: "src/x.js", contents: "const x = 1;" }],
};

test("buildCacheablePrefix: omits the prior-bail section when absent", () => {
  const prefix = buildCacheablePrefix(baseCtx);
  assert.doesNotMatch(prefix, /Past worker bails/);
});

test("buildCacheablePrefix: omits the prior-bail section on empty array", () => {
  const prefix = buildCacheablePrefix({ ...baseCtx, priorBailHints: [] });
  assert.doesNotMatch(prefix, /Past worker bails/);
});

test("buildCacheablePrefix: appends prior-bail hints under a captioned, numbered section", () => {
  const prefix = buildCacheablePrefix({
    ...baseCtx,
    priorBailHints: [
      "bailed-no-patches on debug-noise: console.log left in compressImage",
      "bailed-build-failed on missing-test: no test for new branch",
    ],
  });
  assert.match(prefix, /Past worker bails/);
  assert.match(prefix, /1\. bailed-no-patches on debug-noise/);
  assert.match(prefix, /2\. bailed-build-failed on missing-test/);
});

test("buildCacheablePrefix: caps prior-bail section at 5 entries", () => {
  const hints = Array.from({ length: 8 }, (_, i) => `hint ${i}`);
  const prefix = buildCacheablePrefix({ ...baseCtx, priorBailHints: hints });
  assert.match(prefix, /1\. hint 0/);
  assert.match(prefix, /5\. hint 4/);
  assert.doesNotMatch(prefix, /6\. hint 5/);
});

test("buildCacheablePrefix: prior-bail section is delimited as a separate cache block", () => {
  const prefix = buildCacheablePrefix({
    ...baseCtx,
    priorBailHints: ["a"],
  });
  // Cache prefix sections are joined by "\n---\n". Ours should appear
  // as its own block to keep prompt-cache hits intact when the answer-
  // keys / failure-catalog sections drift independently.
  const blocks = prefix.split("\n---\n");
  assert.ok(blocks.some((b) => b.includes("Past worker bails")));
});
