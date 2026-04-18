import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRelevanceContext, inferTestPath } from "../dist/index.js";

test("buildRelevanceContext: diff only when no readFile provided", async () => {
  const out = await buildRelevanceContext({
    diff: "diff --git a/foo.ts b/foo.ts\n+added line",
    diffPaths: ["foo.ts"],
  });
  assert.equal(out.chunks.length, 1);
  assert.equal(out.chunks[0].reason, "diff");
});

test("buildRelevanceContext: appends test file when discoverable", async () => {
  const out = await buildRelevanceContext({
    diff: "diff of foo.ts",
    diffPaths: ["src/foo.ts"],
    readFile: async (p) => (p === "src/foo.test.ts" ? "// test body" : null),
  });
  const testChunk = out.chunks.find((c) => c.reason === "test-of-diff");
  assert.ok(testChunk, "expected test chunk");
  assert.equal(testChunk.path, "src/foo.test.ts");
});

test("buildRelevanceContext: walks direct imports when graphDepth >= 1", async () => {
  const files = new Map([
    ["src/foo.ts", "// foo"],
    ["src/bar.ts", "// bar"],
  ]);
  const out = await buildRelevanceContext(
    {
      diff: "diff",
      diffPaths: ["src/foo.ts"],
      readFile: async (p) => files.get(p) ?? null,
      importsOf: async (p) => (p === "src/foo.ts" ? ["src/bar.ts"] : []),
    },
    { graphDepth: 1 },
  );
  const imp = out.chunks.find((c) => c.reason === "import-of-diff");
  assert.ok(imp);
  assert.equal(imp.path, "src/bar.ts");
});

test("buildRelevanceContext: respects tokenBudget", async () => {
  const out = await buildRelevanceContext(
    {
      diff: "x".repeat(10_000),
      diffPaths: ["huge.ts"],
    },
    { tokenBudget: 500 },
  );
  assert.ok(out.totalTokens <= 500);
});

test("inferTestPath: maps source → test path by convention", () => {
  assert.equal(inferTestPath("src/foo.ts"), "src/foo.test.ts");
  assert.equal(inferTestPath("src/a/b/c.tsx"), "src/a/b/c.test.tsx");
  assert.equal(inferTestPath("pkg/mod.js"), "pkg/mod.test.js");
  // Already a test file — returns itself so caller doesn't recurse.
  assert.equal(inferTestPath("src/foo.test.ts"), "src/foo.test.ts");
  assert.equal(inferTestPath("src/foo.spec.js"), "src/foo.spec.js");
  assert.equal(inferTestPath("no-extension"), null);
});
