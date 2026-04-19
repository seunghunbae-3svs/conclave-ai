import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveFirstPreview } from "../dist/index.js";

function fixedPlatform(id, result) {
  return {
    id,
    displayName: id,
    resolve: async () => result,
  };
}

test("resolveFirstPreview: first non-null wins", async () => {
  const out = await resolveFirstPreview(
    [fixedPlatform("a", null), fixedPlatform("b", { url: "https://b", provider: "b", sha: "s" })],
    { repo: "r", sha: "s" },
  );
  assert.equal(out?.url, "https://b");
});

test("resolveFirstPreview: throwing platform does not abort the walk", async () => {
  const throwing = {
    id: "bad",
    displayName: "bad",
    resolve: async () => {
      throw new Error("kaboom");
    },
  };
  const ok = fixedPlatform("good", { url: "https://ok", provider: "good", sha: "s" });
  const origStderr = process.stderr.write.bind(process.stderr);
  const chunks = [];
  process.stderr.write = (c) => {
    chunks.push(String(c));
    return true;
  };
  try {
    const out = await resolveFirstPreview([throwing, ok], { repo: "r", sha: "s" });
    assert.equal(out?.url, "https://ok");
  } finally {
    process.stderr.write = origStderr;
  }
  assert.match(chunks.join(""), /\[platform:bad\].*kaboom/);
});

test("resolveFirstPreview: all null → null", async () => {
  const out = await resolveFirstPreview(
    [fixedPlatform("a", null), fixedPlatform("b", null)],
    { repo: "r", sha: "s" },
  );
  assert.equal(out, null);
});

test("resolveFirstPreview: empty list → null", async () => {
  const out = await resolveFirstPreview([], { repo: "r", sha: "s" });
  assert.equal(out, null);
});
