import { test } from "node:test";
import assert from "node:assert/strict";
import { retrieve } from "../dist/index.js";

const corpus = [
  { id: "1", text: "authentication middleware should validate JWT signatures", tags: ["auth", "security"], repo: "acme/app" },
  { id: "2", text: "React components must handle empty cart state gracefully", tags: ["ui", "react"], repo: "acme/shop" },
  { id: "3", text: "database migrations require backwards compatibility", tags: ["db", "migration"], repo: "acme/app" },
  { id: "4", text: "accessibility contrast ratio must hit AA minimum", tags: ["a11y"], repo: "acme/shop" },
];

const extract = {
  text: (d) => d.text,
  tags: (d) => d.tags,
  repo: (d) => d.repo,
};

test("retrieve: query matches content", () => {
  const hits = retrieve(corpus, "empty cart state in React", extract, 3);
  assert.ok(hits.length > 0);
  assert.equal(hits[0].doc.id, "2");
});

test("retrieve: tag boost promotes tag-matching docs", () => {
  const hits = retrieve(corpus, "auth security", extract, 3);
  assert.equal(hits[0].doc.id, "1");
});

test("retrieve: repo boost promotes same-repo docs", () => {
  const sameRepo = [
    { id: "a", text: "generic observation", tags: [], repo: "acme/target" },
    { id: "b", text: "generic observation", tags: [], repo: "acme/other" },
  ];
  const hits = retrieve(sameRepo, "generic observation", extract, 2, { queryRepo: "acme/target" });
  assert.equal(hits[0].doc.id, "a");
});

test("retrieve: respects k", () => {
  const hits = retrieve(corpus, "state ui component auth migration contrast", extract, 2);
  assert.ok(hits.length <= 2);
});

test("retrieve: empty query returns nothing", () => {
  const hits = retrieve(corpus, "", extract, 5);
  assert.deepEqual(hits, []);
});

test("retrieve: no-match returns empty", () => {
  const hits = retrieve(corpus, "xylophone concatenate helicopter", extract, 5);
  assert.deepEqual(hits, []);
});

test("retrieve: stop words are ignored", () => {
  const onlyStops = retrieve(corpus, "the and or to of in on for", extract, 5);
  assert.deepEqual(onlyStops, []);
});

test("retrieve: Korean tokens survive tokenizer", () => {
  const kCorpus = [{ id: "k1", text: "인증 미들웨어는 상태가 없어야 한다", tags: ["auth"], repo: "x" }];
  const hits = retrieve(kCorpus, "인증 미들웨어", extract, 3);
  assert.ok(hits.length > 0);
});
