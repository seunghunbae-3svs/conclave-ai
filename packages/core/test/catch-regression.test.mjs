import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FileSystemMemoryStore,
  detectCatchRegressions,
  writeCatchRegression,
} from "../dist/index.js";

function freshFs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aic-catchreg-"));
  return { store: new FileSystemMemoryStore({ root }), root };
}
function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

const now = () => new Date().toISOString();

function mkFailure({ id, tags = [], category = "other", title = "x", body = "x", seedBlocker } = {}) {
  return {
    id,
    createdAt: now(),
    domain: "code",
    category,
    severity: "major",
    title,
    body,
    tags,
    ...(seedBlocker ? { seedBlocker } : {}),
  };
}

function mkOutcome(reviews = [], verdict = "approve") {
  return { verdict, rounds: 1, results: reviews, consensusReached: true };
}

const debugNoiseFailure = mkFailure({
  id: "fc-debug",
  tags: ["debug-noise"],
  category: "other",
  title: "console.log debug call left in production code",
  body: "Remove console.log debug call before merging — leaks operational data.",
  seedBlocker: { severity: "major", category: "debug-noise", message: "console.log" },
});

const matchingDiff = [
  "+++ b/x.js",
  "+console.log('debug operational frontend production data');",
].join("\n");

test("detectCatchRegressions: nothing in retrieval → []", () => {
  const out = detectCatchRegressions({
    outcome: mkOutcome(),
    ctx: { diff: matchingDiff },
    retrievedFailures: [],
  });
  assert.deepEqual(out, []);
});

test("detectCatchRegressions: empty diff → []", () => {
  const out = detectCatchRegressions({
    outcome: mkOutcome(),
    ctx: { diff: "" },
    retrievedFailures: [debugNoiseFailure],
  });
  assert.deepEqual(out, []);
});

test("detectCatchRegressions: catalog pattern matches diff + council didn't raise → flagged", () => {
  const out = detectCatchRegressions({
    outcome: mkOutcome([
      { agent: "claude", verdict: "approve", blockers: [], summary: "" },
    ]),
    ctx: { diff: matchingDiff },
    retrievedFailures: [debugNoiseFailure],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].failureId, "fc-debug");
  assert.equal(out[0].category, "debug-noise");
  assert.ok(out[0].matchedTokens.length >= 1);
  assert.match(out[0].title, /console\.log/);
});

test("detectCatchRegressions: council blocker of same category → suppressed", () => {
  const out = detectCatchRegressions({
    outcome: mkOutcome([
      {
        agent: "claude",
        verdict: "rework",
        blockers: [{ severity: "major", category: "debug-noise", message: "console.log" }],
        summary: "",
      },
    ]),
    ctx: { diff: matchingDiff },
    retrievedFailures: [debugNoiseFailure],
  });
  assert.equal(out.length, 0);
});

test("detectCatchRegressions: meta-tagged failures (rework-loop / catch-regression) are skipped", () => {
  const meta = mkFailure({
    id: "fc-meta",
    tags: ["catch-regression", "debug-noise"],
    title: "console.log left",
    body: "operational frontend production",
  });
  const meta2 = mkFailure({
    id: "fc-meta2",
    tags: ["rework-loop-failure", "bailed-no-patches"],
    title: "console.log left",
    body: "operational frontend production",
  });
  const out = detectCatchRegressions({
    outcome: mkOutcome(),
    ctx: { diff: matchingDiff },
    retrievedFailures: [meta, meta2],
  });
  assert.equal(out.length, 0);
});

test("detectCatchRegressions: relaxed minOverlap default 1 (gate's 2 would've missed)", () => {
  const lonely = mkFailure({
    id: "fc-lonely",
    tags: ["debug-noise"],
    title: "console.log",
    body: "console.log left in production",
    seedBlocker: { severity: "major", category: "debug-noise", message: "x" },
  });
  // Diff shares only "console" — single-token overlap.
  const out = detectCatchRegressions({
    outcome: mkOutcome(),
    ctx: { diff: "+++ b/x.js\n+const console = 1;" },
    retrievedFailures: [lonely],
  });
  assert.equal(out.length, 1);

  // Strict (minOverlap 2) suppresses it.
  const out2 = detectCatchRegressions(
    {
      outcome: mkOutcome(),
      ctx: { diff: "+++ b/x.js\n+const console = 1;" },
      retrievedFailures: [lonely],
    },
    { minTokenOverlap: 2 },
  );
  assert.equal(out2.length, 0);
});

test("detectCatchRegressions: caps at maxRegressions (default 5)", () => {
  const failures = [];
  for (let i = 0; i < 9; i += 1) {
    failures.push(
      mkFailure({
        id: `fc-${i}`,
        tags: [`cat-${i}`],
        title: `unique${i} consoletoken${i} debug`,
        body: `unique${i} consoletoken${i} debug operational`,
        seedBlocker: { severity: "major", category: `cat-${i}`, message: "x" },
      }),
    );
  }
  const diff = `+++ b/x.js\n${failures.map((f, i) => `+unique${i} consoletoken${i} debug operational`).join("\n")}`;
  const out = detectCatchRegressions({
    outcome: mkOutcome(),
    ctx: { diff },
    retrievedFailures: failures,
  });
  assert.equal(out.length, 5);
  // maxRegressions override
  const out2 = detectCatchRegressions(
    { outcome: mkOutcome(), ctx: { diff }, retrievedFailures: failures },
    { maxRegressions: 2 },
  );
  assert.equal(out2.length, 2);
});

test("detectCatchRegressions: dedupes by (category, title[:60])", () => {
  const a = mkFailure({
    id: "a",
    tags: ["debug-noise"],
    title: "console.log left",
    body: "console.log debug operational",
    seedBlocker: { severity: "major", category: "debug-noise", message: "x" },
  });
  const b = mkFailure({
    id: "b",
    tags: ["debug-noise"],
    title: "console.log left",
    body: "console.log debug operational",
    seedBlocker: { severity: "major", category: "debug-noise", message: "y" },
  });
  const out = detectCatchRegressions({
    outcome: mkOutcome(),
    ctx: { diff: matchingDiff },
    retrievedFailures: [a, b],
  });
  assert.equal(out.length, 1);
});

test("writeCatchRegression: persists a tagged FailureEntry; deterministic id", async () => {
  const { store, root } = freshFs();
  try {
    const reg = {
      failureId: "fc-debug",
      category: "debug-noise",
      matchedTokens: ["console", "debug"],
      title: "console.log debug call",
    };
    const a = await writeCatchRegression(store, {
      contextLabel: "acme/app#42",
      regression: reg,
      episodicId: "ep-1",
    });
    assert.ok(a.tags.includes("catch-regression"));
    assert.ok(a.tags.includes("debug-noise"));
    assert.equal(a.episodicId, "ep-1");
    assert.match(a.title, /Catch regression/);
    // Idempotent: same regression key → same id.
    const b = await writeCatchRegression(store, {
      contextLabel: "acme/app#43",
      regression: reg,
    });
    assert.equal(a.id, b.id);
    const failures = await store.listFailures("code");
    assert.equal(failures.length, 1);
  } finally {
    cleanup(root);
  }
});

test("writeCatchRegression: distinct categories produce distinct ids", async () => {
  const { store, root } = freshFs();
  try {
    await writeCatchRegression(store, {
      contextLabel: "acme/app#42",
      regression: {
        failureId: "fc-1",
        category: "debug-noise",
        matchedTokens: [],
        title: "x",
      },
    });
    await writeCatchRegression(store, {
      contextLabel: "acme/app#42",
      regression: {
        failureId: "fc-1",
        category: "missing-test",
        matchedTokens: [],
        title: "x",
      },
    });
    const failures = await store.listFailures("code");
    assert.equal(failures.length, 2);
  } finally {
    cleanup(root);
  }
});
