/**
 * OP-1 — dev-loop "claude exited null" root cause + diagnostic output.
 *
 * The pre-OP-1 code printed every spawnSync failure shape as
 * "claude exited null", which was the direct reason cron got disabled
 * after H1.5 B's 5 consecutive crashes. describeSpawnFailure now
 * classifies every shape into (short, detail, hint).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeSpawnFailure } from "../../../scripts/dev-loop/run-next.mjs";

test("OP-1: ENOENT (claude not on PATH) → 'spawn ENOENT' + install hint", () => {
  const r = describeSpawnFailure({
    status: null,
    signal: null,
    error: { code: "ENOENT", message: "claude not found" },
  });
  assert.equal(r.short, "spawn ENOENT");
  assert.match(r.detail, /not on PATH/);
  assert.match(r.hint, /npm i -g @anthropic-ai\/claude-code/);
});

test("OP-1: maxBuffer overflow → distinct 'stdout buffer overflow' classification", () => {
  const r = describeSpawnFailure({
    status: null,
    signal: null,
    error: {
      code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      message: "stdout maxBuffer exceeded",
    },
  });
  assert.equal(r.short, "stdout buffer overflow");
  assert.match(r.detail, /maxBuffer cap/);
  assert.match(r.hint, /maxBuffer/);
});

test("OP-1: SIGTERM → 'killed by SIGTERM' (timeout/OOM-kill)", () => {
  const r = describeSpawnFailure({
    status: null,
    signal: "SIGTERM",
    error: undefined,
  });
  assert.equal(r.short, "killed by SIGTERM");
  assert.match(r.detail, /timeout|OOM/i);
  assert.match(r.hint, /timeout|memory/i);
});

test("OP-1: SIGKILL → 'killed by SIGKILL'", () => {
  const r = describeSpawnFailure({ status: null, signal: "SIGKILL" });
  assert.equal(r.short, "killed by SIGKILL");
});

test("OP-1: non-zero exit code → 'exit N' classification", () => {
  const r = describeSpawnFailure({ status: 2, signal: null });
  assert.equal(r.short, "exit 2");
  assert.match(r.detail, /non-zero status 2/);
});

test("OP-1: unknown shape (status null + signal null + no error) → defensive 'unknown failure'", () => {
  const r = describeSpawnFailure({ status: null, signal: null, error: undefined });
  assert.equal(r.short, "unknown failure");
  // Hint mentions the previous silent behavior so any operator who
  // remembers the old "claude exited null" line knows this is the fix.
  assert.match(r.hint, /OP-1|exited null/);
});

test("OP-1: error.code missing on the error object → still classifies, never throws", () => {
  const r = describeSpawnFailure({
    status: null,
    signal: null,
    error: { message: "something failed" },
  });
  assert.equal(typeof r.short, "string");
  assert.equal(typeof r.detail, "string");
  assert.equal(typeof r.hint, "string");
});

test("OP-1: every shape has non-empty short / detail / hint (no missing fields)", () => {
  const shapes = [
    { status: null, signal: null, error: { code: "ENOENT" } },
    { status: null, signal: null, error: { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" } },
    { status: null, signal: null, error: { code: "EACCES" } },
    { status: null, signal: "SIGTERM" },
    { status: null, signal: "SIGKILL" },
    { status: null, signal: "SIGUSR1" },
    { status: 1 },
    { status: 127 },
    { status: null, signal: null },
  ];
  for (const r of shapes) {
    const d = describeSpawnFailure(r);
    assert.ok(d.short.length > 0, `short empty for ${JSON.stringify(r)}`);
    assert.ok(d.detail.length > 0, `detail empty for ${JSON.stringify(r)}`);
    assert.ok(d.hint.length > 0, `hint empty for ${JSON.stringify(r)}`);
  }
});
