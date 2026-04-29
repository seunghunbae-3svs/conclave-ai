/**
 * UX-2 / UX-3 follow-on — LIVE INVARIANT pinning the central plane's
 * VALID_STAGES list against the source of truth in the @conclave-ai/core
 * ProgressStage type.
 *
 * Pre-invariant: cli@0.14.2 added autofix-cycle-ended, autofix-blocker-
 * started, and autofix-blocker-done to core/notifier.ts ProgressStage.
 * The central plane's review.ts route validation list was NOT updated
 * → every emit of those stages got HTTP 400 → Telegram never saw cycle-
 * ended or per-blocker progress. LIVE-caught on eventbadge PR #40 rework
 * run #25121646235 — same "two messages then silence" symptom Bae's
 * complaint that drove UX-2/3 in the first place.
 *
 * This test parses BOTH source files and asserts every ProgressStage
 * literal in core appears in the Worker's VALID_STAGES list. Failing
 * here breaks CI, so a future stage addition can't ship without
 * updating the central plane in lockstep.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

function stripBlockComments(src) {
  // Remove /* ... */ blocks first (multi-line aware), then // line comments.
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function extractStagesFromCoreNotifier() {
  const raw = readFileSync(
    path.join(repoRoot, "packages/core/src/notifier.ts"),
    "utf8",
  );
  const src = stripBlockComments(raw);
  const m = src.match(/export type ProgressStage =\s*([\s\S]*?);/);
  if (!m) throw new Error("could not find ProgressStage union in core/notifier.ts");
  // Match only union member literals: lines like `  | "stage-name"`.
  const literals = [...m[1].matchAll(/\|\s*"([^"]+)"/g)].map((mm) => mm[1]);
  if (literals.length === 0) throw new Error("ProgressStage union had no string literals");
  return literals;
}

function extractValidStagesFromCentralPlane() {
  const raw = readFileSync(
    path.join(repoRoot, "apps/central-plane/src/routes/review.ts"),
    "utf8",
  );
  const src = stripBlockComments(raw);
  const m = src.match(/const VALID_STAGES:\s*readonly\s*ProgressStage\[\]\s*=\s*\[([\s\S]*?)\];/);
  if (!m) throw new Error("could not find VALID_STAGES in central-plane review.ts");
  const literals = [...m[1].matchAll(/"([^"]+)"/g)].map((mm) => mm[1]);
  if (literals.length === 0) throw new Error("VALID_STAGES array had no entries");
  return literals;
}

function extractStagesFromCentralPlaneFormat() {
  const raw = readFileSync(
    path.join(repoRoot, "apps/central-plane/src/progress-format.ts"),
    "utf8",
  );
  const src = stripBlockComments(raw);
  const m = src.match(/export type ProgressStage =\s*([\s\S]*?);/);
  if (!m) throw new Error("could not find ProgressStage union in central-plane progress-format.ts");
  return [...m[1].matchAll(/\|\s*"([^"]+)"/g)].map((mm) => mm[1]);
}

test("LIVE INVARIANT: central plane VALID_STAGES covers every core ProgressStage", () => {
  const coreStages = extractStagesFromCoreNotifier();
  const validStages = extractValidStagesFromCentralPlane();
  const missing = coreStages.filter((s) => !validStages.includes(s));
  assert.equal(
    missing.length,
    0,
    `central-plane review.ts VALID_STAGES is missing ${missing.length} stage(s) from @conclave-ai/core ProgressStage: ${missing.join(", ")}. ` +
      `Add to apps/central-plane/src/routes/review.ts and progress-format.ts. Without this, emits of those stages return HTTP 400 and the Telegram message stops updating.`,
  );
});

test("LIVE INVARIANT: central-plane progress-format.ts ProgressStage covers every core stage", () => {
  const coreStages = extractStagesFromCoreNotifier();
  const cpStages = extractStagesFromCentralPlaneFormat();
  const missing = coreStages.filter((s) => !cpStages.includes(s));
  assert.equal(
    missing.length,
    0,
    `central-plane progress-format.ts ProgressStage union is missing: ${missing.join(", ")}`,
  );
});

test("LIVE INVARIANT: integration-telegram progress-format renders every core stage (no 'undefined' lines)", () => {
  const coreStages = extractStagesFromCoreNotifier();
  const tgSrc = readFileSync(
    path.join(repoRoot, "packages/integration-telegram/src/progress-format.ts"),
    "utf8",
  );
  const missing = coreStages.filter((s) => !new RegExp(`case\\s+"${s}"\\s*:`).test(tgSrc));
  assert.equal(
    missing.length,
    0,
    `integration-telegram progress-format.ts has no case for: ${missing.join(", ")}. ` +
      `Without a case, renderProgressLine returns undefined and the message renders 'undefined' for that stage.`,
  );
});
