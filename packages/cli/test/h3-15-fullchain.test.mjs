/**
 * H3 #15 fullchain audit — catch-regression meta-loop.
 *
 * Round-trip:
 *   1. Catalog seeded with regular FailureEntry (no meta tag).
 *   2. PR-A diff has 1 matching token (under gate's strict threshold,
 *      no council blocker either).
 *   3. detectCatchRegressions picks it up at the relaxed threshold.
 *   4. writeCatchRegression persists a NEW FailureEntry tagged
 *      'catch-regression'.
 *   5. PR-B (next review) retrieve loads the catch-regression entry.
 *   6. applyFailureGate surfaces it as a sticky on PR-B (the entry's
 *      tokens overlap, council didn't catch it again).
 *
 * Critical invariant: detector EXCLUDES meta-tagged entries (avoids
 * self-recursion), but the gate INCLUDES them (so they're enforced
 * downstream). Test confirms both halves of that contract.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FileSystemMemoryStore,
  applyFailureGate,
  detectCatchRegressions,
  writeCatchRegression,
} from "@conclave-ai/core";

function freshFs() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aic-h3-15-fc-"));
}
function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

const REPO = "acme/app";

test("H3 #15 fullchain: relaxed-match catch → write → next-PR retrieves + gate sticky", async () => {
  const root = freshFs();
  try {
    const store = new FileSystemMemoryStore({ root });

    // === Stage 1: seed catalog with a regular debug-noise entry. ===
    await store.writeFailure({
      id: "fc-debug",
      createdAt: new Date().toISOString(),
      domain: "code",
      category: "other", // mapCategory("debug-noise") → "other"
      severity: "major",
      title: "console.log debug call left in production code",
      body:
        "Remove console.log debug calls before merging — they leak operational data to frontend production users.",
      tags: ["debug-noise"],
      seedBlocker: {
        severity: "major",
        category: "debug-noise",
        message: "console.log debug call left",
      },
    });

    // === Stage 2: PR-A diff has SOME overlap (1 token: "console") — ===
    // not enough for the strict gate (≥2), no council blocker either.
    const ctxA = {
      diff: "diff --git a/x.js b/x.js\n+++ b/x.js\n+const console = doSomethingElse();",
      repo: REPO,
      pullNumber: 100,
      newSha: "sha-A",
    };
    const councilOutcomeA = {
      verdict: "approve",
      rounds: 1,
      results: [{ agent: "claude", verdict: "approve", blockers: [], summary: "" }],
      consensusReached: true,
    };
    // Confirm the strict gate doesn't catch (precondition for the
    // meta-loop to be the right escape valve).
    const retrievalA = await store.retrieve({ query: ctxA.diff, repo: REPO, k: 8 });
    const gateOutA = applyFailureGate(councilOutcomeA, retrievalA.failures, ctxA);
    assert.equal(gateOutA.stickyBlockers.length, 0, "strict gate must NOT catch a single-token overlap");

    // === Stage 3: detectCatchRegressions at relaxed threshold catches. ===
    const regressions = detectCatchRegressions({
      outcome: gateOutA.outcome,
      ctx: { diff: ctxA.diff },
      retrievedFailures: retrievalA.failures,
    });
    assert.equal(regressions.length, 1, "relaxed-overlap must catch what strict missed");
    assert.equal(regressions[0].category, "debug-noise");

    // === Stage 4: writeCatchRegression persists a meta entry. ===
    const written = await writeCatchRegression(store, {
      contextLabel: `${REPO}#${ctxA.pullNumber}`,
      regression: regressions[0],
      episodicId: "ep-A",
    });
    assert.ok(written.tags.includes("catch-regression"));
    assert.ok(written.tags.includes("debug-noise"));

    // === Stage 5: PR-B (next review) — retrieval pulls the catch-regression. ===
    const ctxB = {
      diff:
        "diff --git a/y.js b/y.js\n+++ b/y.js\n+console.log('debug operational frontend production data');",
      repo: REPO,
      pullNumber: 101,
      newSha: "sha-B",
    };
    const retrievalB = await store.retrieve({ query: ctxB.diff, repo: REPO, k: 8 });
    const seededRegression = retrievalB.failures.find((f) => f.id === written.id);
    assert.ok(seededRegression, "catch-regression entry must surface in PR-B's retrieval");

    // === Stage 6: applyFailureGate uses the catch-regression entry. ===
    const councilOutcomeB = {
      verdict: "approve",
      rounds: 1,
      results: [{ agent: "claude", verdict: "approve", blockers: [], summary: "" }],
      consensusReached: true,
    };
    const gateOutB = applyFailureGate(councilOutcomeB, retrievalB.failures, ctxB);
    assert.ok(
      gateOutB.stickyBlockers.length >= 1,
      "gate MUST surface catch-regression entries (no meta-tag filter on gate side)",
    );
    assert.ok(
      gateOutB.stickyBlockers.some((s) => s.category === "debug-noise"),
      "regression sticky must carry the original free-form category",
    );
  } finally {
    cleanup(root);
  }
});

test("H3 #15 fullchain: detector self-recursion guard — meta-tagged entries are NOT re-flagged as regressions", async () => {
  // Detector skips entries tagged catch-regression / rework-loop-failure
  // so we don't write a regression-of-a-regression-of-a-regression
  // chain on every PR.
  const root = freshFs();
  try {
    const store = new FileSystemMemoryStore({ root });

    // Seed with ONLY meta-tagged entries (catch-regression + rework-loop-failure).
    await store.writeFailure({
      id: "fc-cr",
      createdAt: new Date().toISOString(),
      domain: "code",
      category: "regression",
      severity: "major",
      title: "Catch regression: console.log debug call",
      body: "console debug operational frontend production",
      tags: ["catch-regression", "debug-noise"],
      seedBlocker: { severity: "major", category: "debug-noise", message: "console" },
    });
    await store.writeFailure({
      id: "fc-rwl",
      createdAt: new Date().toISOString(),
      domain: "code",
      category: "other",
      severity: "major",
      title: "Autofix loop bailed (bailed-no-patches)",
      body: "console debug operational frontend production",
      tags: ["rework-loop-failure", "bailed-no-patches", "debug-noise"],
      seedBlocker: { severity: "major", category: "debug-noise", message: "console" },
    });

    const ctx = {
      diff: "diff --git a/x b/x\n+console.log('debug operational frontend production');",
      repo: REPO,
      pullNumber: 1,
      newSha: "sha",
    };
    const retrieval = await store.retrieve({ query: ctx.diff, repo: REPO, k: 8 });
    const councilOutcome = {
      verdict: "approve",
      rounds: 1,
      results: [{ agent: "claude", verdict: "approve", blockers: [], summary: "" }],
      consensusReached: true,
    };
    const regressions = detectCatchRegressions({
      outcome: councilOutcome,
      ctx,
      retrievedFailures: retrieval.failures,
    });
    assert.equal(
      regressions.length,
      0,
      "detector MUST skip meta-tagged entries (otherwise it recurses on its own output)",
    );

    // BUT the gate STILL surfaces them — both invariants must hold.
    const gateOut = applyFailureGate(councilOutcome, retrieval.failures, ctx);
    assert.ok(
      gateOut.stickyBlockers.length >= 1,
      "gate must keep enforcing meta-tagged entries even when the detector ignores them",
    );
  } finally {
    cleanup(root);
  }
});

test("H3 #15 fullchain: when council ALREADY raised same category → not a regression", async () => {
  // The detector's "caught" set comes from review.results' blockers.
  // If the council itself caught the same category, no regression.
  const root = freshFs();
  try {
    const store = new FileSystemMemoryStore({ root });
    await store.writeFailure({
      id: "fc-ok",
      createdAt: new Date().toISOString(),
      domain: "code",
      category: "other",
      severity: "major",
      title: "console.log debug call",
      body: "console debug operational frontend production",
      tags: ["debug-noise"],
      seedBlocker: { severity: "major", category: "debug-noise", message: "console" },
    });
    const ctx = {
      diff: "+++ b/x.js\n+console.log('debug')",
      repo: REPO,
      pullNumber: 1,
      newSha: "sha",
    };
    const retrieval = await store.retrieve({ query: ctx.diff, repo: REPO, k: 8 });
    const councilOutcome = {
      verdict: "rework",
      rounds: 1,
      results: [
        {
          agent: "claude",
          verdict: "rework",
          blockers: [{ severity: "major", category: "debug-noise", message: "console.log" }],
          summary: "",
        },
      ],
      consensusReached: false,
    };
    const regressions = detectCatchRegressions({
      outcome: councilOutcome,
      ctx,
      retrievedFailures: retrieval.failures,
    });
    assert.equal(
      regressions.length,
      0,
      "council caught it → not a regression even at the relaxed bar",
    );
  } finally {
    cleanup(root);
  }
});

test("H3 #15 fullchain: writeCatchRegression idempotent — same regression twice doesn't write 2 entries", async () => {
  const root = freshFs();
  try {
    const store = new FileSystemMemoryStore({ root });
    const r = {
      failureId: "fc-source",
      category: "debug-noise",
      matchedTokens: ["console"],
      title: "console.log debug",
    };
    const a = await writeCatchRegression(store, {
      contextLabel: "acme/app#1",
      regression: r,
    });
    const b = await writeCatchRegression(store, {
      contextLabel: "acme/app#2",
      regression: r,
    });
    assert.equal(a.id, b.id, "stable id");
    const failures = await store.listFailures("code");
    assert.equal(failures.length, 1);
  } finally {
    cleanup(root);
  }
});
