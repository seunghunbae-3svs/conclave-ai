/**
 * Phase B.4c — runaway rework loop ceiling.
 *
 * User-reported failure mode: "rework 메세지가 수십개 연속 발송".
 * The B.4b notification ledger dedup covers the message-repetition
 * angle. This test pins down the OTHER half: autofix itself MUST
 * refuse to chain past the hard ceiling, and the parseArgv input
 * sanitization MUST clamp.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REWORK_CYCLE_HARD_CEILING,
  parseArgv,
} from "../dist/commands/autofix.js";

test("B.4c: REWORK_CYCLE_HARD_CEILING is 5 (locked, change requires deliberate intent)", () => {
  assert.equal(REWORK_CYCLE_HARD_CEILING, 5);
});

test("B.4c: parseArgv clamps --rework-cycle to the hard ceiling", () => {
  const args = parseArgv(["--rework-cycle", "999"]);
  assert.equal(
    args.reworkCycle,
    REWORK_CYCLE_HARD_CEILING,
    "even malformed/runaway --rework-cycle inputs are clamped — workflow fired with cycle=999 still bails out",
  );
});

test("B.4c: parseArgv accepts a cycle value < ceiling unchanged", () => {
  const args = parseArgv(["--rework-cycle", "2"]);
  assert.equal(args.reworkCycle, 2);
});

test("B.4c: parseArgv rejects negative cycles (no rolling-back into the past)", () => {
  const args = parseArgv(["--rework-cycle", "-3"]);
  // Default is 0 if input is invalid.
  assert.equal(args.reworkCycle, 0);
});

test("B.4c: parseArgv default reworkCycle is 0 (first attempt)", () => {
  const args = parseArgv([]);
  assert.equal(args.reworkCycle, 0);
});

test("B.4c: parseArgv NaN input → defaults to 0", () => {
  const args = parseArgv(["--rework-cycle", "abc"]);
  assert.equal(args.reworkCycle, 0);
});
