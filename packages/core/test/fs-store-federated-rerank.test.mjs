import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FileSystemMemoryStore,
  buildFrequencyMap,
  hashAnswerKey,
  hashFailure,
} from "../dist/index.js";

function fresh() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aic-fs-rerank-"));
}
function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeJson(dir, subdir, id, payload) {
  const target = path.join(dir, subdir);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, `${id}.json`), JSON.stringify(payload));
}

function ak(id, tags, pattern = "by-pattern/x") {
  return {
    id,
    createdAt: "2026-04-19T00:00:00.000Z",
    domain: "code",
    pattern,
    lesson: `lesson for ${id} — matches query`,
    tags,
  };
}

function fc(id, tags, category = "security", severity = "blocker") {
  return {
    id,
    createdAt: "2026-04-19T00:00:00.000Z",
    domain: "code",
    category,
    severity,
    title: `title ${id} — matches query`,
    body: `body ${id}`,
    tags,
  };
}

test("retrieve: no federatedFrequency → legacy ordering preserved", async () => {
  const dir = fresh();
  try {
    writeJson(dir, "answer-keys/code", "a1", ak("ak-1", ["auth"]));
    writeJson(dir, "answer-keys/code", "a2", ak("ak-2", ["react"]));
    writeJson(dir, "failure-catalog/code", "f1", fc("fc-1", ["auth"]));
    const store = new FileSystemMemoryStore({ root: dir });
    const out = await store.retrieve({ query: "matches query", k: 8 });
    assert.equal(out.answerKeys.length, 2);
    assert.equal(out.failures.length, 1);
  } finally {
    cleanup(dir);
  }
});

test("retrieve: federatedFrequency promotes matching-hash answer-key to the top", async () => {
  const dir = fresh();
  try {
    // Both docs match the query text equally (same lesson phrasing)
    const popular = ak("ak-popular", ["auth", "security"]);
    const rare = ak("ak-rare", ["react"]);
    writeJson(dir, "answer-keys/code", "ak-popular", popular);
    writeJson(dir, "answer-keys/code", "ak-rare", rare);

    const store = new FileSystemMemoryStore({ root: dir });

    // Baseline that hashes the "auth + security" combination, seen 100 times
    const popularHash = hashAnswerKey(popular);
    const freqMap = new Map([[popularHash, 100]]);

    const out = await store.retrieve({
      query: "matches query lesson",
      k: 8,
      federatedFrequency: freqMap,
    });
    assert.equal(out.answerKeys[0].id, "ak-popular");
  } finally {
    cleanup(dir);
  }
});

test("retrieve: federatedFrequency boosts failure entries by hash match", async () => {
  const dir = fresh();
  try {
    const popular = fc("fc-popular", ["auth"], "security", "blocker");
    const rare = fc("fc-rare", ["react"], "accessibility", "minor");
    writeJson(dir, "failure-catalog/code", "fc-popular", popular);
    writeJson(dir, "failure-catalog/code", "fc-rare", rare);
    const store = new FileSystemMemoryStore({ root: dir });
    const popularHash = hashFailure(popular);
    const freqMap = new Map([[popularHash, 250]]);
    const out = await store.retrieve({
      query: "title matches query body",
      k: 8,
      federatedFrequency: freqMap,
    });
    assert.equal(out.failures[0].id, "fc-popular");
  } finally {
    cleanup(dir);
  }
});

test("retrieve: buildFrequencyMap from baselines → plugs into retrieve directly", async () => {
  const dir = fresh();
  try {
    const popular = ak("ak-pop", ["auth"]);
    writeJson(dir, "answer-keys/code", "ak-pop", popular);
    const store = new FileSystemMemoryStore({ root: dir });
    const popularHash = hashAnswerKey(popular);
    const baselines = [
      { version: 1, kind: "answer-key", contentHash: popularHash, domain: "code", tags: ["auth"], dayBucket: "2026-04-19" },
      { version: 1, kind: "answer-key", contentHash: popularHash, domain: "code", tags: ["auth"], dayBucket: "2026-04-19" },
    ];
    const freqMap = buildFrequencyMap(baselines);
    const out = await store.retrieve({
      query: "matches query",
      k: 8,
      federatedFrequency: freqMap,
    });
    assert.equal(out.answerKeys[0].id, "ak-pop");
  } finally {
    cleanup(dir);
  }
});
