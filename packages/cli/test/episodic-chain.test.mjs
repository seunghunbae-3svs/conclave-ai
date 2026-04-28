import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileSystemMemoryStore } from "@conclave-ai/core";
import { findPriorEpisodicId } from "../dist/lib/episodic-chain.js";

function freshStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aic-chain-"));
  return { store: new FileSystemMemoryStore({ root }), root };
}
function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}
function ts(offsetSeconds) {
  return new Date(1_700_000_000_000 + offsetSeconds * 1000).toISOString();
}
function epEntry({ id, repo, pullNumber, cycleNumber, priorEpisodicId, createdAt }) {
  return {
    id,
    createdAt,
    repo,
    pullNumber,
    sha: "abc",
    diffSha256: "a".repeat(64),
    reviews: [],
    councilVerdict: "approve",
    outcome: "pending",
    costUsd: 0,
    cycleNumber,
    ...(priorEpisodicId ? { priorEpisodicId } : {}),
  };
}

test("findPriorEpisodicId: returns undefined for the first cycle", async () => {
  const { store, root } = freshStore();
  try {
    const id = await findPriorEpisodicId(store, "acme/app", 7, 1);
    assert.equal(id, undefined);
  } finally {
    cleanup(root);
  }
});

test("findPriorEpisodicId: locates cycle N-1 entry for the same PR", async () => {
  const { store, root } = freshStore();
  try {
    await store.writeEpisodic(
      epEntry({ id: "ep-c1", repo: "acme/app", pullNumber: 7, cycleNumber: 1, createdAt: ts(0) }),
    );
    await store.writeEpisodic(
      epEntry({ id: "ep-c2", repo: "acme/app", pullNumber: 7, cycleNumber: 2, priorEpisodicId: "ep-c1", createdAt: ts(60) }),
    );
    const found = await findPriorEpisodicId(store, "acme/app", 7, 3);
    assert.equal(found, "ep-c2");
  } finally {
    cleanup(root);
  }
});

test("findPriorEpisodicId: ignores entries from other PRs / repos", async () => {
  const { store, root } = freshStore();
  try {
    await store.writeEpisodic(
      epEntry({ id: "ep-other-repo", repo: "other/x", pullNumber: 7, cycleNumber: 1, createdAt: ts(0) }),
    );
    await store.writeEpisodic(
      epEntry({ id: "ep-other-pr", repo: "acme/app", pullNumber: 8, cycleNumber: 1, createdAt: ts(10) }),
    );
    await store.writeEpisodic(
      epEntry({ id: "ep-target", repo: "acme/app", pullNumber: 7, cycleNumber: 1, createdAt: ts(20) }),
    );
    const found = await findPriorEpisodicId(store, "acme/app", 7, 2);
    assert.equal(found, "ep-target");
  } finally {
    cleanup(root);
  }
});

test("findPriorEpisodicId: when 2 entries share cycleNumber, picks the most recent", async () => {
  const { store, root } = freshStore();
  try {
    // Should not normally happen, but defensively the heuristic should be deterministic.
    await store.writeEpisodic(
      epEntry({ id: "ep-old", repo: "acme/app", pullNumber: 7, cycleNumber: 1, createdAt: ts(0) }),
    );
    await store.writeEpisodic(
      epEntry({ id: "ep-new", repo: "acme/app", pullNumber: 7, cycleNumber: 1, createdAt: ts(60) }),
    );
    const found = await findPriorEpisodicId(store, "acme/app", 7, 2);
    assert.equal(found, "ep-new");
  } finally {
    cleanup(root);
  }
});
