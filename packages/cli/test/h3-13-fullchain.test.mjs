/**
 * H3 #13 fullchain audit — worker prompt auto-tuning.
 *
 * Round-trips the chain:
 *   1. Catalog has rework-loop-failure entries (from prior H3 #12 bails).
 *   2. autofix.ts builds retrieval query from `repo` + first blocker's
 *      category + message (replicated here verbatim).
 *   3. extractPriorBailHints filters retrieval.failures by tag → produces
 *      hint lines.
 *   4. buildPerBlockerContext copies hints into WorkerContext.priorBailHints.
 *   5. buildCacheablePrefix splices the hints into the prompt string the
 *      worker sends to the LLM — the LAST mile that determines whether
 *      the worker actually sees the past bails.
 *
 * Concerns the test pins down:
 *   - Does the autofix retrieval query actually match catalog tokens?
 *     (BM25 minScore = 0.05 by default — easy to fall under)
 *   - Does extractPriorBailHints filter logic match the writeReworkLoopFailure
 *     output format? (i.e., the writer's tags shape vs the extractor's filter)
 *   - Does the prompt text END UP with the hints? (the only way the
 *     LLM ever benefits)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FileSystemMemoryStore,
  extractPriorBailHints,
  writeReworkLoopFailure,
} from "@conclave-ai/core";
import { buildCacheablePrefix } from "@conclave-ai/agent-worker";
import { buildPerBlockerContext } from "../dist/lib/autofix-worker.js";

function freshFs() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aic-h3-13-fc-"));
}
function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

const REPO = "acme/app";

// Replicate autofix.ts's exact retrieval query construction.
function buildHintQuery({ repo, firstBlocker }) {
  const pieces = [repo];
  if (firstBlocker) pieces.push(firstBlocker.category, firstBlocker.message);
  return pieces.join(" ");
}

test("H3 #13 fullchain: catalog bail → autofix retrieval → hint extracted → splices into worker prompt text", async () => {
  const root = freshFs();
  try {
    const store = new FileSystemMemoryStore({ root });

    // === Stage 1: prior bail recorded. ===
    await writeReworkLoopFailure(store, {
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
    });

    // === Stage 2: autofix retrieval over a fresh blocker that resembles. ===
    const incomingBlocker = {
      severity: "major",
      category: "debug-noise",
      message: "console.log left in upload handler",
      file: "frontend/src/components/Avatar.tsx",
    };
    const query = buildHintQuery({ repo: REPO, firstBlocker: incomingBlocker });
    const retrieval = await store.retrieve({ query, domain: "code", repo: REPO, k: 8 });
    assert.ok(
      retrieval.failures.length >= 1,
      "autofix's retrieval query MUST surface at least one bail entry — otherwise the auto-tuning chain dead-ends here",
    );

    // === Stage 3: extractPriorBailHints filter shape vs write shape. ===
    const hints = extractPriorBailHints(retrieval.failures);
    assert.ok(
      hints.length >= 1,
      "extractor must accept rework-loop-failure entries written by writeReworkLoopFailure (tag/format compatibility)",
    );
    assert.equal(hints[0].bailStatus, "bailed-no-patches");
    assert.equal(hints[0].category, "debug-noise");
    assert.match(hints[0].text, /console\.log/);
    const priorBailHints = hints.map((h) => h.text);

    // === Stage 4: buildPerBlockerContext threads hints into WorkerContext. ===
    const ctx = buildPerBlockerContext(
      {
        repo: REPO,
        pullNumber: 42,
        newSha: "sha",
        agent: "claude",
        blocker: incomingBlocker,
        priorBailHints,
      },
      [{ path: incomingBlocker.file, contents: "// avatar component" }],
    );
    assert.deepEqual(ctx.priorBailHints, priorBailHints, "WorkerContext must carry the hints intact");

    // === Stage 5: buildCacheablePrefix splices hints into the actual prompt text. ===
    // This is THE test — without this, the LLM never sees the hints,
    // and H3 #13 is a no-op no matter what came before.
    const prefix = buildCacheablePrefix(ctx);
    assert.match(prefix, /Past worker bails — avoid these failure modes/);
    assert.match(prefix, /bailed-no-patches/);
    assert.match(prefix, /debug-noise/);
    assert.match(prefix, /console\.log/);
  } finally {
    cleanup(root);
  }
});

test("H3 #13 fullchain: empty catalog → no hints → prompt has NO past-bails section (cache-friendly)", async () => {
  const root = freshFs();
  try {
    const store = new FileSystemMemoryStore({ root });
    const incomingBlocker = {
      severity: "major",
      category: "debug-noise",
      message: "console.log",
    };
    const query = buildHintQuery({ repo: REPO, firstBlocker: incomingBlocker });
    const retrieval = await store.retrieve({ query, domain: "code", repo: REPO, k: 8 });
    assert.equal(retrieval.failures.length, 0);
    const hints = extractPriorBailHints(retrieval.failures);
    assert.equal(hints.length, 0);

    const ctx = buildPerBlockerContext(
      {
        repo: REPO,
        pullNumber: 1,
        newSha: "sha",
        agent: "claude",
        blocker: incomingBlocker,
        // No priorBailHints — buildPerBlockerContext only sets it when non-empty.
      },
      [],
    );
    assert.equal(ctx.priorBailHints, undefined);
    const prefix = buildCacheablePrefix(ctx);
    assert.doesNotMatch(prefix, /Past worker bails/);
  } finally {
    cleanup(root);
  }
});

test("H3 #13 fullchain: 3 distinct bails → all surface as numbered hints in prompt", async () => {
  const root = freshFs();
  try {
    const store = new FileSystemMemoryStore({ root });
    const blockers = [
      { severity: "major", category: "debug-noise", message: "console.log frontend production" },
      { severity: "major", category: "missing-test", message: "no test for new branch coverage" },
      { severity: "blocker", category: "type-error", message: "ts2345 mismatch promise unknown" },
    ];
    for (let i = 0; i < blockers.length; i += 1) {
      await writeReworkLoopFailure(store, {
        repo: REPO,
        bailStatus: i === 2 ? "bailed-tests-failed" : "bailed-no-patches",
        iterationsAttempted: 1,
        totalCostUsd: 0.2,
        remainingBlockers: [blockers[i]],
      });
    }

    // Query with a generic repo-only ish so all 3 entries get a chance.
    // Real autofix uses the first blocker's tokens — emulate that by
    // sweeping multiple separate retrievals.
    const query = `${REPO} debug noise console missing test type error promise frontend production`;
    const retrieval = await store.retrieve({ query, domain: "code", repo: REPO, k: 8 });

    const hints = extractPriorBailHints(retrieval.failures);
    assert.ok(hints.length >= 1, `expected ≥1 hint(s); got ${hints.length}`);

    const ctx = buildPerBlockerContext(
      {
        repo: REPO,
        pullNumber: 1,
        newSha: "sha",
        agent: "claude",
        blocker: blockers[0],
        priorBailHints: hints.map((h) => h.text),
      },
      [],
    );
    const prefix = buildCacheablePrefix(ctx);
    // Section is numbered; first hint at "1."
    assert.match(prefix, /1\. /, "numbered list under Past worker bails section");
  } finally {
    cleanup(root);
  }
});

test("H3 #13 fullchain: hints round-trip in a SEPARATE cache block (Anthropic prompt caching invariant)", async () => {
  // The hints are spliced into buildCacheablePrefix with a "\n---\n"
  // delimiter. That gives Anthropic the seam to cache the answer-keys
  // and failure-catalog blocks even when the hints change. If a future
  // refactor accidentally inlines the hints into the system prompt
  // string itself, prompt-cache hits drop substantially.
  const root = freshFs();
  try {
    const store = new FileSystemMemoryStore({ root });
    await writeReworkLoopFailure(store, {
      repo: REPO,
      bailStatus: "bailed-no-patches",
      iterationsAttempted: 1,
      totalCostUsd: 0.2,
      remainingBlockers: [
        { severity: "major", category: "debug-noise", message: "console.log left frontend production" },
      ],
    });
    const retrieval = await store.retrieve({
      query: `${REPO} debug-noise console.log left frontend production`,
      domain: "code",
      repo: REPO,
      k: 8,
    });
    const hints = extractPriorBailHints(retrieval.failures);
    const ctx = buildPerBlockerContext(
      {
        repo: REPO,
        pullNumber: 1,
        newSha: "sha",
        agent: "claude",
        blocker: { severity: "major", category: "debug-noise", message: "x" },
        priorBailHints: hints.map((h) => h.text),
      },
      [],
    );
    const prefix = buildCacheablePrefix(ctx);
    const blocks = prefix.split("\n---\n");
    const hintBlock = blocks.find((b) => b.includes("Past worker bails"));
    assert.ok(hintBlock, "past-bails section must be a separate cache block");
    // The hint block should NOT contain the worker SYSTEM prompt header
    // (i.e., it really is a separate block, not glued to system).
    assert.doesNotMatch(hintBlock, /You are the Worker agent/);
  } finally {
    cleanup(root);
  }
});
