import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPriorBailHints, renderPriorBailHintsSection } from "../dist/index.js";

const now = () => new Date().toISOString();

function mkFailure({ id, tags, seedBlocker, title = "x", body = "x" } = {}) {
  return {
    id,
    createdAt: now(),
    domain: "code",
    category: "regression",
    severity: "major",
    title,
    body,
    tags,
    ...(seedBlocker ? { seedBlocker } : {}),
  };
}

test("extractPriorBailHints: returns [] when no failures carry the rework-loop-failure tag", () => {
  const failures = [
    mkFailure({ id: "fc-1", tags: ["debug-noise"] }),
    mkFailure({ id: "fc-2", tags: ["security"] }),
  ];
  assert.deepEqual(extractPriorBailHints(failures), []);
});

test("extractPriorBailHints: builds a hint per rework-loop-failure entry", () => {
  const failures = [
    mkFailure({
      id: "fc-1",
      tags: ["rework-loop-failure", "bailed-no-patches", "debug-noise"],
      title: "Autofix loop bailed",
      seedBlocker: {
        severity: "major",
        category: "debug-noise",
        message: "console.log debug call left in compressImage",
        file: "src/utils/imageCompressor.js",
      },
    }),
  ];
  const hints = extractPriorBailHints(failures);
  assert.equal(hints.length, 1);
  assert.equal(hints[0].bailStatus, "bailed-no-patches");
  assert.equal(hints[0].category, "debug-noise");
  assert.match(hints[0].text, /bailed-no-patches/);
  assert.match(hints[0].text, /debug-noise/);
  assert.match(hints[0].text, /console\.log/);
  assert.match(hints[0].text, /imageCompressor\.js/);
});

test("extractPriorBailHints: dedupes by (bailStatus, category, message[:60])", () => {
  const sameSeed = {
    severity: "major",
    category: "debug-noise",
    message: "console.log debug call left",
  };
  const failures = [
    mkFailure({
      id: "a",
      tags: ["rework-loop-failure", "bailed-no-patches"],
      seedBlocker: sameSeed,
    }),
    mkFailure({
      id: "b",
      tags: ["rework-loop-failure", "bailed-no-patches"],
      seedBlocker: sameSeed,
    }),
    // Different bail status → distinct hint.
    mkFailure({
      id: "c",
      tags: ["rework-loop-failure", "bailed-build-failed"],
      seedBlocker: sameSeed,
    }),
  ];
  const hints = extractPriorBailHints(failures);
  assert.equal(hints.length, 2);
  const statuses = hints.map((h) => h.bailStatus).sort();
  assert.deepEqual(statuses, ["bailed-build-failed", "bailed-no-patches"]);
});

test("extractPriorBailHints: respects maxHints (default 5)", () => {
  const failures = [];
  for (let i = 0; i < 8; i += 1) {
    failures.push(
      mkFailure({
        id: `fc-${i}`,
        tags: ["rework-loop-failure", `bailed-${i}`, `cat-${i}`],
        seedBlocker: { severity: "major", category: `cat-${i}`, message: `msg ${i}` },
      }),
    );
  }
  assert.equal(extractPriorBailHints(failures).length, 5);
  assert.equal(extractPriorBailHints(failures, { maxHints: 3 }).length, 3);
  assert.equal(extractPriorBailHints(failures, { maxHints: 8 }).length, 8);
});

test("extractPriorBailHints: missing seedBlocker → uses title for hint message", () => {
  const failures = [
    mkFailure({
      id: "fc-1",
      tags: ["rework-loop-failure", "bailed-no-patches"],
      title: "Autofix loop bailed (bailed-no-patches)",
      // no seedBlocker
    }),
  ];
  const hints = extractPriorBailHints(failures);
  assert.equal(hints.length, 1);
  assert.equal(hints[0].category, "(unknown)");
  assert.match(hints[0].text, /Autofix loop bailed/);
});

test("extractPriorBailHints: bail status missing from tags → bailed-unknown fallback", () => {
  const failures = [
    mkFailure({
      id: "fc-1",
      tags: ["rework-loop-failure", "debug-noise"], // no bailed-* tag
      seedBlocker: { severity: "major", category: "debug-noise", message: "x" },
    }),
  ];
  const hints = extractPriorBailHints(failures);
  assert.equal(hints[0].bailStatus, "bailed-unknown");
});

test("renderPriorBailHintsSection: empty list → empty string", () => {
  assert.equal(renderPriorBailHintsSection([]), "");
});

test("renderPriorBailHintsSection: builds a numbered, captioned section", () => {
  const section = renderPriorBailHintsSection([
    { text: "bailed-no-patches on debug-noise: x", bailStatus: "bailed-no-patches", category: "debug-noise" },
    { text: "bailed-build-failed on missing-test: y", bailStatus: "bailed-build-failed", category: "missing-test" },
  ]);
  assert.match(section, /Past worker bails/);
  assert.match(section, /1\. bailed-no-patches/);
  assert.match(section, /2\. bailed-build-failed/);
});
