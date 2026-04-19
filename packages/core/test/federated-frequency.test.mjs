import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildFrequencyMap,
  rerankByFrequency,
  hashAnswerKey,
  hashFailure,
  computeBaselineHash,
} from "../dist/index.js";

function baseline(kind, domain, category, severity, tags) {
  return {
    version: 1,
    kind,
    contentHash: computeBaselineHash(kind, domain, category, severity, tags),
    domain,
    ...(category ? { category } : {}),
    ...(severity ? { severity } : {}),
    tags: [...tags].map((t) => t.toLowerCase()).sort(),
    dayBucket: "2026-04-19",
  };
}

test("buildFrequencyMap: empty list → empty map", () => {
  assert.equal(buildFrequencyMap([]).size, 0);
});

test("buildFrequencyMap: counts repeats of the same contentHash", () => {
  const b1 = baseline("failure", "code", "security", "blocker", ["auth"]);
  const b2 = baseline("failure", "code", "security", "blocker", ["auth"]);
  const b3 = baseline("failure", "code", "type-error", "major", ["types"]);
  const m = buildFrequencyMap([b1, b2, b3]);
  assert.equal(m.get(b1.contentHash), 2);
  assert.equal(m.get(b3.contentHash), 1);
});

test("rerankByFrequency: zero-match docs keep their original order + score", () => {
  const docs = [
    { doc: { id: "x", tags: [], domain: "code" }, score: 1.0 },
    { doc: { id: "y", tags: [], domain: "code" }, score: 0.5 },
  ];
  const out = rerankByFrequency(docs, new Map(), () => "no-match");
  assert.equal(out[0].doc.id, "x");
  assert.equal(out[0].score, 1.0);
  assert.equal(out[0].federatedFrequency, 0);
});

test("rerankByFrequency: matched docs get a frequency-proportional boost", () => {
  const docs = [
    { doc: { id: "hit", bucket: "a" }, score: 1.0 },
    { doc: { id: "miss", bucket: "b" }, score: 1.0 },
  ];
  const freqMap = new Map([
    ["hash-a", 100],
    ["hash-b", 0],
  ]);
  const hashDoc = (d) => `hash-${d.bucket}`;
  const out = rerankByFrequency(docs, freqMap, hashDoc);
  assert.equal(out[0].doc.id, "hit");
  assert.ok(out[0].score > 1.0); // boosted
  assert.equal(out[0].federatedFrequency, 100);
  assert.equal(out[1].federatedFrequency, 0);
});

test("rerankByFrequency: boost factor is clamped between 1 and opts.boost", () => {
  const docs = [{ doc: { id: "x", bucket: "a" }, score: 1.0 }];
  const freqMap = new Map([["hash-a", 1_000_000]]);
  const hashDoc = (d) => `hash-${d.bucket}`;
  const out = rerankByFrequency(docs, freqMap, hashDoc, { boost: 2.0, saturationAt: 256 });
  // Even at absurdly high frequency, factor saturates at boost
  assert.ok(out[0].score <= 2.0 + 1e-9);
});

test("rerankByFrequency: logarithmic — 10× frequency does NOT mean 10× boost", () => {
  const docs = [
    { doc: { id: "low", bucket: "a" }, score: 1.0 },
    { doc: { id: "high", bucket: "b" }, score: 1.0 },
  ];
  const freqMap = new Map([
    ["hash-a", 10],
    ["hash-b", 100],
  ]);
  const hashDoc = (d) => `hash-${d.bucket}`;
  const out = rerankByFrequency(docs, freqMap, hashDoc);
  const highScore = out.find((r) => r.doc.id === "high").score;
  const lowScore = out.find((r) => r.doc.id === "low").score;
  const ratio = highScore / lowScore;
  // If it were linear, ratio would be ~10. Log scale means it's much less.
  assert.ok(ratio < 3, `expected log-scaled ratio << 10, got ${ratio}`);
});

test("hashAnswerKey: stable across tag order + case", () => {
  const a = {
    id: "ak-1",
    createdAt: "2026-04-19T00:00:00Z",
    domain: "code",
    pattern: "anything",
    lesson: "x",
    tags: ["Security", "auth"],
  };
  const b = { ...a, tags: ["AUTH", "security"] };
  assert.equal(hashAnswerKey(a), hashAnswerKey(b));
});

test("hashFailure: different severity → different hash", () => {
  const base = {
    id: "fc-1",
    createdAt: "2026-04-19T00:00:00Z",
    domain: "code",
    category: "security",
    severity: "blocker",
    title: "t",
    body: "b",
    tags: ["auth"],
  };
  const minor = { ...base, severity: "minor" };
  assert.notEqual(hashFailure(base), hashFailure(minor));
});

test("computeBaselineHash: matches hashAnswerKey for equivalent inputs", () => {
  const tags = ["auth", "jwt"];
  const key = {
    id: "ak-x",
    createdAt: "2026-04-19T00:00:00Z",
    domain: "code",
    pattern: "p",
    lesson: "l",
    tags,
  };
  assert.equal(
    hashAnswerKey(key),
    computeBaselineHash("answer-key", "code", undefined, undefined, tags),
  );
});
