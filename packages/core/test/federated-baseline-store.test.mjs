import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileSystemFederatedBaselineStore } from "../dist/index.js";

function fresh() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aic-fbs-"));
}
function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function baseline(hash, kind = "failure") {
  return {
    version: 1,
    kind,
    contentHash: hash,
    domain: "code",
    ...(kind === "failure" ? { category: "security", severity: "blocker" } : {}),
    tags: ["auth"],
    dayBucket: "2026-04-19",
  };
}

test("FSBaselineStore: read() on missing file returns []", async () => {
  const dir = fresh();
  try {
    const store = new FileSystemFederatedBaselineStore({ root: dir });
    const out = await store.read();
    assert.deepEqual(out, []);
  } finally {
    cleanup(dir);
  }
});

test("FSBaselineStore: write + read round-trip", async () => {
  const dir = fresh();
  try {
    const store = new FileSystemFederatedBaselineStore({ root: dir });
    const a = baseline("a".repeat(64));
    const b = baseline("b".repeat(64), "answer-key");
    await store.write([a, b]);
    const out = await store.read();
    assert.equal(out.length, 2);
    assert.equal(out[0].contentHash, a.contentHash);
    assert.equal(out[1].contentHash, b.contentHash);
  } finally {
    cleanup(dir);
  }
});

test("FSBaselineStore: append dedupes by contentHash (last write wins)", async () => {
  const dir = fresh();
  try {
    const store = new FileSystemFederatedBaselineStore({ root: dir });
    await store.write([baseline("a".repeat(64))]);
    await store.append([baseline("a".repeat(64)), baseline("b".repeat(64))]);
    const out = await store.read();
    assert.equal(out.length, 2);
    const hashes = out.map((b) => b.contentHash).sort();
    assert.deepEqual(hashes, ["a".repeat(64), "b".repeat(64)]);
  } finally {
    cleanup(dir);
  }
});

test("FSBaselineStore: append with no existing file creates it", async () => {
  const dir = fresh();
  try {
    const nested = path.join(dir, "deep", "nested");
    const store = new FileSystemFederatedBaselineStore({ root: nested });
    await store.append([baseline("a".repeat(64))]);
    const out = await store.read();
    assert.equal(out.length, 1);
  } finally {
    cleanup(dir);
  }
});

test("FSBaselineStore: malformed lines are skipped silently", async () => {
  const dir = fresh();
  try {
    const filePath = path.join(dir, "baselines.jsonl");
    fs.writeFileSync(
      filePath,
      JSON.stringify(baseline("a".repeat(64))) +
        "\n" +
        "not json\n" +
        JSON.stringify({ version: 999, contentHash: "x" }) +
        "\n" +
        JSON.stringify(baseline("c".repeat(64))) +
        "\n",
    );
    const store = new FileSystemFederatedBaselineStore({ root: dir });
    const out = await store.read();
    assert.equal(out.length, 2);
    assert.equal(out[0].contentHash, "a".repeat(64));
    assert.equal(out[1].contentHash, "c".repeat(64));
  } finally {
    cleanup(dir);
  }
});

test("FSBaselineStore: clear() removes the file; subsequent read returns []", async () => {
  const dir = fresh();
  try {
    const store = new FileSystemFederatedBaselineStore({ root: dir });
    await store.write([baseline("a".repeat(64))]);
    await store.clear();
    assert.deepEqual(await store.read(), []);
    // Idempotent clear
    await store.clear();
  } finally {
    cleanup(dir);
  }
});

test("FSBaselineStore: respects custom filename", async () => {
  const dir = fresh();
  try {
    const store = new FileSystemFederatedBaselineStore({
      root: dir,
      filename: "custom.jsonl",
    });
    await store.write([baseline("a".repeat(64))]);
    assert.ok(fs.existsSync(path.join(dir, "custom.jsonl")));
    assert.ok(!fs.existsSync(path.join(dir, "baselines.jsonl")));
  } finally {
    cleanup(dir);
  }
});

test("FSBaselineStore: empty write clears file contents", async () => {
  const dir = fresh();
  try {
    const store = new FileSystemFederatedBaselineStore({ root: dir });
    await store.write([baseline("a".repeat(64))]);
    await store.write([]);
    const out = await store.read();
    assert.deepEqual(out, []);
  } finally {
    cleanup(dir);
  }
});
