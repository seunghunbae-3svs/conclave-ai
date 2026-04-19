import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileSystemMemoryStore } from "../dist/index.js";

function freshStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aic-mem-"));
  return { store: new FileSystemMemoryStore({ root }), root };
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

const now = () => new Date().toISOString();

test("FileSystemMemoryStore: write + list answer-keys round-trip", async () => {
  const { store, root } = freshStore();
  try {
    await store.writeAnswerKey({
      id: "ak-001",
      createdAt: now(),
      domain: "code",
      pattern: "by-pattern/auth",
      lesson: "stateless middleware composes",
      tags: ["auth"],
    });
    const out = await store.listAnswerKeys("code");
    assert.equal(out.length, 1);
    assert.equal(out[0].id, "ak-001");
  } finally {
    cleanup(root);
  }
});

test("FileSystemMemoryStore: list returns [] when dir missing", async () => {
  const { store, root } = freshStore();
  try {
    assert.deepEqual(await store.listAnswerKeys(), []);
    assert.deepEqual(await store.listFailures(), []);
    assert.deepEqual(await store.listRules(), []);
  } finally {
    cleanup(root);
  }
});

test("FileSystemMemoryStore: write failure + retrieve surfaces it", async () => {
  const { store, root } = freshStore();
  try {
    await store.writeFailure({
      id: "fc-001",
      createdAt: now(),
      domain: "code",
      category: "security",
      severity: "blocker",
      title: "JWT logged in full",
      body: "Truncate JWTs to first/last 4 chars before log.",
      tags: ["auth", "logging"],
    });
    const result = await store.retrieve({ query: "JWT auth logging truncate", domain: "code", k: 5 });
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].id, "fc-001");
  } finally {
    cleanup(root);
  }
});

test("FileSystemMemoryStore: domain filter excludes other-domain entries", async () => {
  const { store, root } = freshStore();
  try {
    await store.writeAnswerKey({
      id: "ak-code",
      createdAt: now(),
      domain: "code",
      pattern: "by-pattern/x",
      lesson: "code lesson",
      tags: [],
    });
    await store.writeAnswerKey({
      id: "ak-design",
      createdAt: now(),
      domain: "design",
      pattern: "by-component/Button",
      lesson: "design lesson",
      tags: [],
    });
    const code = await store.listAnswerKeys("code");
    const design = await store.listAnswerKeys("design");
    assert.equal(code.length, 1);
    assert.equal(design.length, 1);
    assert.equal(code[0].id, "ak-code");
  } finally {
    cleanup(root);
  }
});

test("FileSystemMemoryStore: retrieve returns empty buckets on empty corpus", async () => {
  const { store, root } = freshStore();
  try {
    const result = await store.retrieve({ query: "anything at all" });
    assert.deepEqual(result.answerKeys, []);
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.rules, []);
  } finally {
    cleanup(root);
  }
});

test("FileSystemMemoryStore: writeRule appends JSONL", async () => {
  const { store, root } = freshStore();
  try {
    await store.writeRule({
      id: "r1",
      createdAt: now(),
      tag: "auth",
      rule: "never log raw JWTs",
      evidence: { answerKeyIds: [], failureIds: ["fc-001"] },
    });
    await store.writeRule({
      id: "r2",
      createdAt: now(),
      tag: "a11y",
      rule: "contrast at least AA",
      evidence: { answerKeyIds: [], failureIds: [] },
    });
    const rules = await store.listRules();
    assert.equal(rules.length, 2);
    assert.equal(rules[0].id, "r1");
    assert.equal(rules[1].id, "r2");
  } finally {
    cleanup(root);
  }
});

test("FileSystemMemoryStore: writeEpisodic organizes by day + PR", async () => {
  const { store, root } = freshStore();
  try {
    const createdAt = "2026-04-19T12:00:00.000Z";
    await store.writeEpisodic({
      id: "ep-1",
      createdAt,
      repo: "acme/demo",
      pullNumber: 42,
      sha: "abc",
      diffSha256: "a".repeat(64),
      reviews: [{ agent: "claude", verdict: "approve", blockers: [], summary: "ok" }],
      councilVerdict: "approve",
      outcome: "merged",
      costUsd: 0.01,
    });
    const dayDir = path.join(root, "episodic", "2026-04-19");
    const files = fs.readdirSync(dayDir);
    assert.ok(files.some((f) => f.startsWith("pr-42")));
  } finally {
    cleanup(root);
  }
});

test("FileSystemMemoryStore: retrieve k defaults to 8", async () => {
  const { store, root } = freshStore();
  try {
    for (let i = 0; i < 12; i += 1) {
      await store.writeAnswerKey({
        id: `ak-${i}`,
        createdAt: now(),
        domain: "code",
        pattern: `by-pattern/x${i}`,
        lesson: "auth middleware stateless composition",
        tags: ["auth"],
      });
    }
    const r = await store.retrieve({ query: "auth middleware stateless" });
    assert.ok(r.answerKeys.length <= 8, `expected ≤ 8, got ${r.answerKeys.length}`);
  } finally {
    cleanup(root);
  }
});
