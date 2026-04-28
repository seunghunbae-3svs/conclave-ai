import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  deleteSolutionSidecar,
  readSolutionSidecar,
  sidecarPath,
  writeSolutionSidecar,
} from "../dist/lib/solution-sidecar.js";

function freshRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aic-soln-"));
}
function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

const samplePatch = (agent = "claude") => ({
  blockerCategory: "debug-noise",
  blockerMessage: "console.log left",
  blockerFile: "src/x.js",
  hunk: "diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@ -1,1 +1,0 @@\n-console.log('debug');\n",
  agent,
});

test("sidecarPath: encodes repo, pr, and cycle into the filename", () => {
  const p = sidecarPath({
    memoryRoot: "/tmp/m",
    repo: "acme/app",
    pullNumber: 42,
    cycleNumber: 2,
  });
  assert.match(p, /pending-solutions/);
  assert.match(p, /acme__app__pr-42__cycle-2\.json$/);
});

test("writeSolutionSidecar + readSolutionSidecar: round-trip", async () => {
  const root = freshRoot();
  try {
    const opts = { memoryRoot: root, repo: "acme/app", pullNumber: 7, cycleNumber: 2 };
    const written = await writeSolutionSidecar(opts, [samplePatch("claude"), samplePatch("openai")]);
    assert.ok(fs.existsSync(written));
    const loaded = await readSolutionSidecar(opts);
    assert.equal(loaded.length, 2);
    assert.equal(loaded[0].blockerCategory, "debug-noise");
    assert.equal(loaded[1].agent, "openai");
  } finally {
    cleanup(root);
  }
});

test("readSolutionSidecar: missing file → []", async () => {
  const root = freshRoot();
  try {
    const loaded = await readSolutionSidecar({
      memoryRoot: root,
      repo: "acme/app",
      pullNumber: 999,
      cycleNumber: 5,
    });
    assert.deepEqual(loaded, []);
  } finally {
    cleanup(root);
  }
});

test("readSolutionSidecar: malformed json → []", async () => {
  const root = freshRoot();
  try {
    const opts = { memoryRoot: root, repo: "acme/app", pullNumber: 7, cycleNumber: 2 };
    const file = sidecarPath(opts);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "not json", "utf8");
    const loaded = await readSolutionSidecar(opts);
    assert.deepEqual(loaded, []);
  } finally {
    cleanup(root);
  }
});

test("deleteSolutionSidecar: removes file; missing file no-ops", async () => {
  const root = freshRoot();
  try {
    const opts = { memoryRoot: root, repo: "acme/app", pullNumber: 7, cycleNumber: 2 };
    await writeSolutionSidecar(opts, [samplePatch()]);
    await deleteSolutionSidecar(opts);
    assert.ok(!fs.existsSync(sidecarPath(opts)));
    // No-op on second delete.
    await deleteSolutionSidecar(opts);
  } finally {
    cleanup(root);
  }
});

test("sidecarPath: separates by (repo, pr, cycle) — no cross-talk", () => {
  const a = sidecarPath({ memoryRoot: "/m", repo: "a/x", pullNumber: 1, cycleNumber: 2 });
  const b = sidecarPath({ memoryRoot: "/m", repo: "a/x", pullNumber: 1, cycleNumber: 3 });
  const c = sidecarPath({ memoryRoot: "/m", repo: "a/x", pullNumber: 2, cycleNumber: 2 });
  const d = sidecarPath({ memoryRoot: "/m", repo: "b/y", pullNumber: 1, cycleNumber: 2 });
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, d);
});
