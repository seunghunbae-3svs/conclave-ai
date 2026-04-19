import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileSystemMemoryStore } from "../../core/dist/index.js";
import { retrieveReadOnly, listEpisodic } from "../dist/commands/mcp-server.js";

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aic-mcp-"));
  return { dir, store: new FileSystemMemoryStore({ root: dir }) };
}
function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function ak(id, tags = []) {
  return {
    id,
    createdAt: "2026-04-19T10:00:00.000Z",
    domain: "code",
    pattern: "by-pattern/x",
    lesson: `lesson for ${id}`,
    tags,
  };
}

function fc(id, category = "security", severity = "blocker") {
  return {
    id,
    createdAt: "2026-04-19T10:00:00.000Z",
    domain: "code",
    category,
    severity,
    title: `title ${id}`,
    body: `body ${id}`,
    tags: [],
  };
}

function episodic(id, outcome, createdAt) {
  return {
    id,
    createdAt,
    repo: "acme/x",
    pullNumber: 1,
    sha: "a".repeat(40),
    diffSha256: "b".repeat(64),
    reviews: [],
    councilVerdict: "approve",
    outcome,
    costUsd: 0,
  };
}

test("retrieveReadOnly: returns empty buckets on empty store", async () => {
  const { dir, store } = freshStore();
  try {
    const out = await retrieveReadOnly(store, { query: "anything" });
    assert.deepEqual(out.answerKeys, []);
    assert.deepEqual(out.failures, []);
  } finally {
    cleanup(dir);
  }
});

test("retrieveReadOnly: forwards query + k + domain to store.retrieve", async () => {
  const { dir, store } = freshStore();
  try {
    await store.writeAnswerKey(ak("ak-1", ["auth"]));
    await store.writeFailure(fc("fc-1"));
    const out = await retrieveReadOnly(store, { query: "auth security", k: 5, domain: "code" });
    assert.equal(out.answerKeys.length, 1);
    assert.equal(out.answerKeys[0].id, "ak-1");
  } finally {
    cleanup(dir);
  }
});

test("retrieveReadOnly: domain filter excludes other-domain entries", async () => {
  const { dir, store } = freshStore();
  try {
    await store.writeAnswerKey(ak("ak-code"));
    await store.writeAnswerKey({ ...ak("ak-design"), domain: "design" });
    const out = await retrieveReadOnly(store, { query: "lesson", domain: "code" });
    assert.equal(out.answerKeys.length, 1);
    assert.equal(out.answerKeys[0].id, "ak-code");
  } finally {
    cleanup(dir);
  }
});

test("listEpisodic: sorts by createdAt desc and respects limit", async () => {
  const { dir, store } = freshStore();
  try {
    await store.writeEpisodic(episodic("ep-1", "merged", "2026-04-01T00:00:00Z"));
    await store.writeEpisodic(episodic("ep-2", "merged", "2026-04-19T00:00:00Z"));
    await store.writeEpisodic(episodic("ep-3", "pending", "2026-04-10T00:00:00Z"));
    const out = await listEpisodic(store, { limit: 2 });
    assert.equal(out.length, 2);
    assert.equal(out[0].id, "ep-2"); // newest first
    assert.equal(out[1].id, "ep-3");
  } finally {
    cleanup(dir);
  }
});

test("listEpisodic: outcomeFilter narrows to matching outcomes", async () => {
  const { dir, store } = freshStore();
  try {
    await store.writeEpisodic(episodic("ep-1", "merged", "2026-04-19T00:00:00Z"));
    await store.writeEpisodic(episodic("ep-2", "rejected", "2026-04-19T00:00:00Z"));
    await store.writeEpisodic(episodic("ep-3", "pending", "2026-04-19T00:00:00Z"));
    const out = await listEpisodic(store, { outcomeFilter: "pending" });
    assert.equal(out.length, 1);
    assert.equal(out[0].id, "ep-3");
  } finally {
    cleanup(dir);
  }
});

test("listEpisodic: limit defaults to 20", async () => {
  const { dir, store } = freshStore();
  try {
    for (let i = 0; i < 25; i += 1) {
      await store.writeEpisodic(
        episodic(`ep-${String(i).padStart(2, "0")}`, "merged", `2026-04-${String(i + 1).padStart(2, "0")}T00:00:00Z`),
      );
    }
    const out = await listEpisodic(store, {});
    assert.equal(out.length, 20);
  } finally {
    cleanup(dir);
  }
});
