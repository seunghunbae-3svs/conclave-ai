/**
 * H3 #12 fullchain audit — autofix bail → failure-catalog → next-PR
 * gate sticky.
 *
 * Round-trip:
 *   1. autofix bail simulated via writeReworkLoopFailure → FailureEntry
 *      tagged 'rework-loop-failure' + the bail status persisted to disk.
 *   2. Different PR with similar diff tokens → store.retrieve() picks up
 *      the rework-loop-failure entry as part of `failures[]`.
 *   3. applyFailureGate runs over the same retrieval → matches tokens
 *      → injects sticky on the new PR.
 *   4. Sticky carries the original blocker.category (free-form) so
 *      H2 #8 calibration round-trips would work for it too.
 *
 * Critical invariant: the gate must NOT filter out rework-loop-failure
 * entries (it has no meta-tag filter today; pin that down).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FileSystemMemoryStore,
  applyFailureGate,
  writeReworkLoopFailure,
} from "@conclave-ai/core";

function freshFs() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aic-h3-12-fc-"));
}
function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

const REPO = "acme/app";

test("H3 #12 fullchain: bail catalog → next-PR retrieval surfaces it → gate injects sticky", async () => {
  const root = freshFs();
  try {
    const store = new FileSystemMemoryStore({ root });

    // === Stage 1: simulate autofix bail with a debug-noise blocker. ===
    const writeOut = await writeReworkLoopFailure(store, {
      repo: REPO,
      bailStatus: "bailed-no-patches",
      iterationsAttempted: 3,
      totalCostUsd: 0.6,
      remainingBlockers: [
        {
          severity: "major",
          category: "debug-noise",
          message: "console.log debug call left in compressImage frontend production",
          file: "frontend/src/utils/imageCompressor.js",
        },
      ],
      episodicId: "ep-bailed",
    });
    assert.ok(writeOut.written, "bail must produce a FailureEntry");
    assert.ok(writeOut.written.tags.includes("rework-loop-failure"));
    assert.ok(writeOut.written.tags.includes("bailed-no-patches"));

    // === Stage 2: a NEW PR comes in with a similar pattern. ===
    const ctxNewPR = {
      diff: [
        "diff --git a/frontend/src/components/Avatar.tsx b/frontend/src/components/Avatar.tsx",
        "--- a/frontend/src/components/Avatar.tsx",
        "+++ b/frontend/src/components/Avatar.tsx",
        "@@ -1,3 +1,5 @@",
        " export function Avatar() {",
        "+  console.log('debug Avatar render frontend production data');",
        "+  return <img />;",
        " }",
      ].join("\n"),
      repo: REPO,
      pullNumber: 999,
      newSha: "sha-newPR",
    };

    const queryText = `${ctxNewPR.repo} ${ctxNewPR.diff.slice(0, 4_000)}`;
    const retrieval = await store.retrieve({ query: queryText, repo: ctxNewPR.repo, k: 8 });
    assert.ok(
      retrieval.failures.length >= 1,
      "retrieval must surface the rework-loop-failure entry on the next PR",
    );
    const seeded = retrieval.failures.find((f) => f.id === writeOut.written.id);
    assert.ok(seeded, "the specific bail entry should be in the retrieval");
    assert.ok(seeded.tags.includes("rework-loop-failure"), "tag preserved through retrieval round-trip");

    // === Stage 3: applyFailureGate runs over the retrieval. Council clean approves. ===
    const councilOutcome = {
      verdict: "approve",
      rounds: 1,
      results: [
        { agent: "claude", verdict: "approve", blockers: [], summary: "" },
        { agent: "openai", verdict: "approve", blockers: [], summary: "" },
      ],
      consensusReached: true,
    };
    const gateResult = applyFailureGate(councilOutcome, retrieval.failures, ctxNewPR);
    assert.equal(
      gateResult.stickyBlockers.length,
      1,
      "rework-loop-failure entries MUST surface as stickies on the next matching PR",
    );
    const sticky = gateResult.stickyBlockers[0];
    // Critical: free-form category preserved (H2 #7 audit invariant)
    assert.equal(sticky.category, "debug-noise", "sticky carries free-form category, not enum");
    // verdict escalates
    assert.equal(gateResult.outcome.verdict, "rework", "approve → rework via major-severity sticky");
  } finally {
    cleanup(root);
  }
});

test("H3 #12 fullchain: bail entry's tokens match retrieval scoring (BM25 over title+body+tags)", async () => {
  // Confirms the bail FailureEntry's text is rich enough that the
  // retrieval BM25 actually picks it up. Real concern: writeReworkLoopFailure's
  // body string format changes, the next PR's diff fails to score above
  // minScore, and the entire gate-on-bail path silently no-ops.
  const root = freshFs();
  try {
    const store = new FileSystemMemoryStore({ root });

    await writeReworkLoopFailure(store, {
      repo: REPO,
      bailStatus: "bailed-build-failed",
      iterationsAttempted: 2,
      totalCostUsd: 0.4,
      remainingBlockers: [
        {
          severity: "major",
          category: "type-error",
          message: "ts2345 mismatch on Promise<unknown> assignment to Promise<string>",
          file: "src/api/auth.ts",
        },
      ],
    });

    // PR with a similar pattern — type-error related tokens.
    const newDiff = [
      "+++ b/src/api/users.ts",
      "+const result: Promise<string> = unknownFn(); // ts2345 mismatch?",
    ].join("\n");
    const retrieval = await store.retrieve({ query: newDiff, repo: REPO, k: 8 });
    assert.ok(
      retrieval.failures.some((f) => f.tags.includes("rework-loop-failure")),
      "retrieval BM25 must rank the bail entry above the minScore threshold for related diffs",
    );
  } finally {
    cleanup(root);
  }
});

test("H3 #12 fullchain: stable id — re-running the same bail shape doesn't pollute retrieval with duplicates", async () => {
  const root = freshFs();
  try {
    const store = new FileSystemMemoryStore({ root });
    const input = {
      repo: REPO,
      bailStatus: "bailed-no-patches",
      iterationsAttempted: 3,
      totalCostUsd: 0.6,
      remainingBlockers: [
        {
          severity: "major",
          category: "debug-noise",
          message: "console.log debug call left",
          file: "x.js",
        },
      ],
    };
    await writeReworkLoopFailure(store, input);
    await writeReworkLoopFailure(store, input);
    await writeReworkLoopFailure(store, input);
    const all = await store.listFailures("code");
    assert.equal(all.length, 1, "stable id deduplicates re-runs of identical bails");
  } finally {
    cleanup(root);
  }
});

test("H3 #12 fullchain: gate suppresses bail-sticky if council already raised same category + same file", async () => {
  // Even though the bail entry is tagged 'rework-loop-failure', it
  // still goes through the same alreadyCoveredByCouncil check (no
  // special privilege). Suppression should fire when council already
  // surfaces the issue.
  const root = freshFs();
  try {
    const store = new FileSystemMemoryStore({ root });
    await writeReworkLoopFailure(store, {
      repo: REPO,
      bailStatus: "bailed-no-patches",
      iterationsAttempted: 1,
      totalCostUsd: 0.2,
      remainingBlockers: [
        {
          severity: "major",
          category: "debug-noise",
          message: "console.log left frontend production operational",
          file: "x.js",
        },
      ],
    });
    const ctx = {
      diff: "+++ b/x.js\n+console.log('debug operational frontend production');",
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
          blockers: [
            { severity: "major", category: "debug-noise", message: "console.log on line 1", file: "x.js" },
          ],
          summary: "",
        },
      ],
      consensusReached: false,
    };
    const gateResult = applyFailureGate(councilOutcome, retrieval.failures, ctx);
    assert.equal(
      gateResult.stickyBlockers.length,
      0,
      "council-already-raised → suppression applies even to bail-tagged entries",
    );
  } finally {
    cleanup(root);
  }
});
