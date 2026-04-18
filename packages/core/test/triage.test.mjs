import { test } from "node:test";
import assert from "node:assert/strict";
import { triageReview, touchesRiskyPath } from "../dist/index.js";

test("triageReview: risky path forces full regardless of size", () => {
  const out = triageReview({
    linesChanged: 1,
    fileCount: 1,
    hasTests: true,
    touchesRiskyPath: true,
  });
  assert.equal(out.path, "full");
  assert.match(out.reason, /risky/i);
});

test("triageReview: small + tests + not risky → lite", () => {
  const out = triageReview({
    linesChanged: 20,
    fileCount: 2,
    hasTests: true,
    touchesRiskyPath: false,
  });
  assert.equal(out.path, "lite");
});

test("triageReview: large lines → full", () => {
  const out = triageReview({
    linesChanged: 500,
    fileCount: 1,
    hasTests: true,
    touchesRiskyPath: false,
  });
  assert.equal(out.path, "full");
  assert.match(out.reason, /linesChanged/);
});

test("triageReview: many files → full", () => {
  const out = triageReview({
    linesChanged: 10,
    fileCount: 10,
    hasTests: true,
    touchesRiskyPath: false,
  });
  assert.equal(out.path, "full");
  assert.match(out.reason, /fileCount/);
});

test("triageReview: non-trivial diff without tests → full", () => {
  const out = triageReview({
    linesChanged: 30,
    fileCount: 2,
    hasTests: false,
    touchesRiskyPath: false,
  });
  assert.equal(out.path, "full");
  assert.match(out.reason, /without any test/);
});

test("triageReview: trivial diff without tests still lite (not worth full council)", () => {
  const out = triageReview({
    linesChanged: 5,
    fileCount: 1,
    hasTests: false,
    touchesRiskyPath: false,
  });
  assert.equal(out.path, "lite");
});

test("touchesRiskyPath: schema / migrations / auth / payments / .sql / prisma schema match", () => {
  assert.equal(touchesRiskyPath(["src/auth/login.ts"]), true);
  assert.equal(touchesRiskyPath(["db/migrations/001_init.sql"]), true);
  assert.equal(touchesRiskyPath(["payments/stripe.ts"]), true);
  assert.equal(touchesRiskyPath(["prisma/schema.prisma"]), true);
  assert.equal(touchesRiskyPath(["sql/analytics.sql"]), true);
  assert.equal(touchesRiskyPath(["src/components/Button.tsx"]), false);
  assert.equal(touchesRiskyPath([]), false);
});
