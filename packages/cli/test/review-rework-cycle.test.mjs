import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgv as parseReviewArgv } from "../dist/commands/review.js";
import { parseArgv as parseReworkArgv } from "../dist/commands/rework.js";
import {
  formatCycleMarker,
  parseCycleFromCommitMessage,
  AUTONOMY_HARD_CEILING_CYCLES,
} from "@conclave-ai/core";

// review --rework-cycle ---------------------------------------------------

test("review: --rework-cycle flows through to parsed args", () => {
  const a = parseReviewArgv(["--pr", "1", "--rework-cycle", "2"]);
  assert.equal(a.reworkCycle, 2);
});

test("review: missing --rework-cycle defaults to undefined (treated as 0 downstream)", () => {
  const a = parseReviewArgv(["--pr", "1"]);
  assert.equal(a.reworkCycle, undefined);
});

test("review: --max-rework-cycles propagates", () => {
  const a = parseReviewArgv(["--pr", "1", "--max-rework-cycles", "4"]);
  assert.equal(a.maxReworkCycles, 4);
});

test("review: negative --rework-cycle rejected (kept undefined)", () => {
  const a = parseReviewArgv(["--pr", "1", "--rework-cycle", "-3"]);
  assert.equal(a.reworkCycle, undefined);
});

test("review: non-numeric --rework-cycle rejected", () => {
  const a = parseReviewArgv(["--pr", "1", "--rework-cycle", "abc"]);
  assert.equal(a.reworkCycle, undefined);
});

// rework --rework-cycle + commit marker -----------------------------------

test("rework: --rework-cycle captured in args", () => {
  const a = parseReworkArgv(["--pr", "9", "--rework-cycle", "3"]);
  assert.equal(a.reworkCycle, 3);
});

test("rework: missing --rework-cycle leaves undefined (no marker embedded)", () => {
  const a = parseReworkArgv(["--pr", "9"]);
  assert.equal(a.reworkCycle, undefined);
});

// commit-marker round-trip (CLI-facing) -----------------------------------

test("formatCycleMarker produces the canonical shape", () => {
  assert.equal(formatCycleMarker(2), "[conclave-rework-cycle:2]");
});

test("parseCycleFromCommitMessage: extracts N from a real rework commit", () => {
  const msg = "fix: handle null config\n\nconclave-worker[bot] auto-fix\n\n[conclave-rework-cycle:2]";
  assert.equal(parseCycleFromCommitMessage(msg), 2);
});

test("parseCycleFromCommitMessage: absent marker on human commit → 0", () => {
  assert.equal(parseCycleFromCommitMessage("feat: add X"), 0);
});

test("parseCycleFromCommitMessage: hard-ceiling clamp", () => {
  assert.equal(parseCycleFromCommitMessage("[conclave-rework-cycle:999]"), AUTONOMY_HARD_CEILING_CYCLES);
});
