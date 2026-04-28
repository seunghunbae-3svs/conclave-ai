/**
 * H2 #7 fullchain audit — failure-catalog active gating.
 *
 * Roundtrips: PR-A reject → catalog written → PR-B retrieve loads it →
 * applyFailureGate surfaces sticky → verdict escalates. Tests the full
 * chain on a real on-disk store: writeFailure (via classifier on
 * reject), retrieve, applyFailureGate.
 *
 * Semantic invariant: "same mistake never sneaks past twice."
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FileSystemMemoryStore,
  OutcomeWriter,
  applyFailureGate,
} from "@conclave-ai/core";

function freshFs() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aic-h2-7-fc-"));
}
function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

const REPO = "acme/app";

test("H2 #7 fullchain: PR-A reject → PR-B council misses → gate sticky catches it", async () => {
  const root = freshFs();
  try {
    const store = new FileSystemMemoryStore({ root });
    const writer = new OutcomeWriter({ store });

    // === Stage 1: PR-A — council REJECTS with a free-form category. ===
    const epA = await writer.writeReview({
      ctx: {
        diff: [
          "diff --git a/frontend/src/utils/imageCompressor.js b/frontend/src/utils/imageCompressor.js",
          "--- a/frontend/src/utils/imageCompressor.js",
          "+++ b/frontend/src/utils/imageCompressor.js",
          "@@ -1,3 +1,4 @@",
          " function compressImage(file) {",
          "+  console.log('debug compressImage called frontend production data');",
          "   return file;",
          " }",
        ].join("\n"),
        repo: REPO,
        pullNumber: 100,
        newSha: "sha-A",
      },
      reviews: [
        {
          agent: "claude",
          verdict: "reject",
          blockers: [
            {
              severity: "blocker",
              category: "debug-noise", // FREE-FORM
              message: "console.log debug call left in compressImage frontend production",
              file: "frontend/src/utils/imageCompressor.js",
              line: 18,
            },
          ],
          summary: "console.log leaked into production",
        },
      ],
      councilVerdict: "reject",
      costUsd: 0.05,
      cycleNumber: 1,
    });
    const rejectOut = await writer.recordOutcome({
      episodicId: epA.id,
      outcome: "rejected",
    });
    assert.equal(rejectOut.failures.length, 1, "reject should produce a FailureEntry");

    const onDisk = await store.listFailures("code");
    assert.equal(onDisk.length, 1);
    const f = onDisk[0];
    // Schema: category is enum-coerced (debug-noise → "other" since it's not in the enum).
    assert.equal(f.category, "other", "free-form blocker.category mapped to enum 'other'");
    // QA invariant: seedBlocker preserves the original free-form name.
    assert.equal(f.seedBlocker.category, "debug-noise");

    // === Stage 2: PR-B — different PR, similar pattern. Council MISSES. ===
    const ctxB = {
      diff: [
        "diff --git a/frontend/src/components/UploadButton.tsx b/frontend/src/components/UploadButton.tsx",
        "--- a/frontend/src/components/UploadButton.tsx",
        "+++ b/frontend/src/components/UploadButton.tsx",
        "@@ -1,3 +1,5 @@",
        " export function UploadButton() {",
        "+  console.log('debug UploadButton render frontend production');",
        "+  return <button>Upload</button>;",
        " }",
      ].join("\n"),
      repo: REPO,
      pullNumber: 101,
      newSha: "sha-B",
    };
    // Council MISSES — approves cleanly (no blockers).
    const councilOutcome = {
      verdict: "approve",
      rounds: 1,
      results: [
        { agent: "claude", verdict: "approve", blockers: [], summary: "looks fine" },
        { agent: "openai", verdict: "approve", blockers: [], summary: "ok" },
      ],
      consensusReached: true,
    };

    // === Stage 3: Retrieve loads the catalog entry. ===
    const queryText = `${ctxB.repo} ${ctxB.diff.slice(0, 4_000)}`;
    const retrieval = await store.retrieve({ query: queryText, repo: ctxB.repo, k: 8 });
    assert.ok(retrieval.failures.length >= 1, "PR-B retrieval should pull the seeded FailureEntry");
    const seeded = retrieval.failures.find((x) => x.id === f.id);
    assert.ok(seeded, "the specific FailureEntry should be in the retrieval");

    // === Stage 4: applyFailureGate runs against PR-B's diff. ===
    const gateResult = applyFailureGate(councilOutcome, retrieval.failures, ctxB);

    // Sticky must fire: the diff has "console", "debug", "frontend", "production"
    // tokens in common with the failure body.
    assert.equal(
      gateResult.stickyBlockers.length,
      1,
      `same mistake should NOT sneak past twice — gate should inject sticky. got ${gateResult.stickyBlockers.length} stickies. matches=${JSON.stringify(gateResult.matches)}`,
    );
    const sticky = gateResult.stickyBlockers[0];
    // QA invariant: sticky carries the FREE-FORM category, not "other".
    assert.equal(sticky.category, "debug-noise", "sticky must carry the free-form category for round-trip with calibration");
    assert.equal(sticky.severity, "blocker"); // failure was severity blocker

    // Verdict escalates: approve → reject (blocker-severity sticky).
    assert.equal(gateResult.outcome.verdict, "reject");

    // The synthetic 'failure-gate' agent should be appended as the 3rd reviewer.
    const agentIds = gateResult.outcome.results.map((r) => r.agent);
    assert.ok(agentIds.includes("failure-gate"));
  } finally {
    cleanup(root);
  }
});

test("H2 #7 fullchain: gate suppresses when council already raised same category + same file", async () => {
  const root = freshFs();
  try {
    const store = new FileSystemMemoryStore({ root });
    const writer = new OutcomeWriter({ store });

    // Seed: PR-A reject with file context.
    const epA = await writer.writeReview({
      ctx: {
        diff: "diff --git a/x.js b/x.js\n+++ b/x.js\n+console.log('debug operational frontend production');",
        repo: REPO,
        pullNumber: 200,
        newSha: "sha",
      },
      reviews: [
        {
          agent: "claude",
          verdict: "reject",
          blockers: [
            {
              severity: "major",
              category: "debug-noise",
              message: "console.log debug operational frontend production",
              file: "x.js",
            },
          ],
          summary: "",
        },
      ],
      councilVerdict: "reject",
      costUsd: 0.01,
      cycleNumber: 1,
    });
    await writer.recordOutcome({ episodicId: epA.id, outcome: "rejected" });

    // PR-B council ALREADY raised same category, same file.
    const ctxB = {
      diff: "diff --git a/x.js b/x.js\n+++ b/x.js\n+console.log('debug operational frontend production');",
      repo: REPO,
      pullNumber: 201,
      newSha: "sha-B",
    };
    const councilOutcome = {
      verdict: "rework",
      rounds: 1,
      results: [
        {
          agent: "claude",
          verdict: "rework",
          blockers: [
            {
              severity: "major",
              category: "debug-noise",
              message: "console.log on line 1",
              file: "x.js",
            },
          ],
          summary: "",
        },
      ],
      consensusReached: false,
    };

    const retrieval = await store.retrieve({ query: ctxB.diff, repo: REPO, k: 8 });
    const gateResult = applyFailureGate(councilOutcome, retrieval.failures, ctxB);
    assert.equal(
      gateResult.stickyBlockers.length,
      0,
      "no duplicate sticky when council covers same (category, file)",
    );
    assert.equal(gateResult.outcome.verdict, "rework");
  } finally {
    cleanup(root);
  }
});

test("H2 #7 fullchain: meta-tagged entries (catch-regression) ARE retrieved and CAN gate next time", async () => {
  // Confirms the gate doesn't filter out meta-tagged failures — the
  // meta-loop's whole point is to re-surface them.
  const root = freshFs();
  try {
    const store = new FileSystemMemoryStore({ root });

    // Hand-write a catch-regression entry as if H3 #15 had emitted it.
    await store.writeFailure({
      id: "fc-regression-test",
      createdAt: new Date().toISOString(),
      domain: "code",
      category: "other",
      severity: "major",
      title: "Catch regression: console.log left in production code",
      body:
        "Failure-catalog entry fc-debug (debug-noise) matched the diff but no blocker raised. " +
        "Matched tokens: console, debug, operational.",
      tags: ["catch-regression", "debug-noise"],
      seedBlocker: {
        severity: "major",
        category: "debug-noise",
        message: "console.log left in production",
      },
    });

    const ctxB = {
      diff: "diff --git a/x.js b/x.js\n+++ b/x.js\n+console.log('debug operational frontend production');",
      repo: REPO,
      pullNumber: 300,
      newSha: "sha",
    };
    const councilOutcome = {
      verdict: "approve",
      rounds: 1,
      results: [{ agent: "claude", verdict: "approve", blockers: [], summary: "" }],
      consensusReached: true,
    };

    const retrieval = await store.retrieve({ query: ctxB.diff, repo: REPO, k: 8 });
    assert.ok(retrieval.failures.some((f) => f.id === "fc-regression-test"));

    const gateResult = applyFailureGate(councilOutcome, retrieval.failures, ctxB);
    assert.equal(
      gateResult.stickyBlockers.length,
      1,
      "gate MUST surface catch-regression entries on subsequent reviews — the whole point of H3 #15",
    );
    assert.equal(gateResult.stickyBlockers[0].category, "debug-noise");
  } finally {
    cleanup(root);
  }
});
