/**
 * AF-4 — missing-import handler hermetic tests.
 *
 * Verifies the mechanical try/catch wrap correctly handles the
 * eventbadge PR #41+ missing-import case end-to-end on a real file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { tryMissingImportFix } from "../dist/lib/autofix-handlers/missing-import.js";

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "af4-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const stubGit = () => async () => ({ stdout: "", stderr: "" });

test("AF-4: declines blockers without missing-import phrase signal", async () => {
  await withTempDir(async (dir) => {
    const file = "src/x.js";
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    await fs.writeFile(path.join(dir, file), "console.log('hi');\n");
    const r = await tryMissingImportFix(
      "claude",
      { severity: "blocker", category: "regression", message: "Bad code", file },
      { cwd: dir, git: stubGit() },
    );
    assert.equal(r.claimed, false);
  });
});

test("AF-4: declines when blocker has no `file`", async () => {
  const r = await tryMissingImportFix(
    "claude",
    { severity: "blocker", category: "runtime-safety", message: "module not in this diff" },
    { cwd: "/tmp", git: stubGit() },
  );
  assert.equal(r.claimed, false);
});

test("AF-4: creates no-op stub when imported module file is missing", async () => {
  await withTempDir(async (dir) => {
    const file = "src/main.jsx";
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    const original =
      "import { StrictMode } from 'react'\n" +
      "import { createRoot } from 'react-dom/client'\n" +
      "import App from './App.jsx'\n" +
      "import { initFeatureFlagsRuntime } from './config/feature-flags-runtime.js'\n" +
      "\n" +
      "initFeatureFlagsRuntime()\n" +
      "\n" +
      "createRoot(document.getElementById('root')).render(<App />)\n";
    await fs.writeFile(path.join(dir, file), original);
    const calls = [];
    const r = await tryMissingImportFix(
      "claude",
      {
        severity: "blocker",
        category: "runtime-safety",
        message: "module './config/feature-flags-runtime.js' is not in this diff",
        file,
      },
      {
        cwd: dir,
        git: async (_bin, args) => {
          calls.push({ args: [...args] });
          return { stdout: "", stderr: "" };
        },
      },
    );
    assert.equal(r.claimed, true);
    assert.equal(r.fix.status, "ready");
    const stubRel = "src/config/feature-flags-runtime.js";
    assert.deepEqual(r.fix.appliedFiles, [stubRel]);
    assert.equal(r.fix.costUsd, 0);
    // git add ran on the stub path.
    const adds = calls.filter((c) => c.args[0] === "add");
    assert.ok(adds.some((c) => c.args.includes(stubRel)));
    // Stub file exists with no-op exports.
    const stubAbs = path.join(dir, stubRel);
    const stubContent = await fs.readFile(stubAbs, "utf8");
    assert.match(stubContent, /AF-4 stub/);
    assert.match(stubContent, /export function initFeatureFlagsRuntime\(\)/);
    assert.match(stubContent, /export default __af4Default/);
    // Importer file UNCHANGED.
    const after = await fs.readFile(path.join(dir, file), "utf8");
    assert.equal(after, original);
  });
});

test("AF-4: claims runtime-safety blocker without 'missing'/'not in diff' phrase (PR #55 LIVE)", async () => {
  // Council labels the same defect inconsistently across runs.
  // PR #54: (missing-import) "module not in this diff"
  // PR #55: (runtime-safety) "init...Runtime() runs before React renders
  //          with no error handling; if it throws, the app fails to mount"
  // The PR #55 prose has no "missing" or "not in diff" phrase, so the
  // pre-fix detection declined and the worker pipeline ran instead.
  // With the fix, runtime-safety + "init" or "import" mention is enough.
  await withTempDir(async (dir) => {
    const file = "src/main.jsx";
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    await fs.writeFile(
      path.join(dir, file),
      "import { initFeatureFlagsRuntime } from './config/feature-flags-runtime.js'\n" +
        "initFeatureFlagsRuntime()\n",
    );
    const r = await tryMissingImportFix(
      "claude",
      {
        severity: "major",
        category: "runtime-safety",
        message: "initFeatureFlagsRuntime() runs before React renders with no error handling; if it throws, the app fails to mount",
        file,
      },
      { cwd: dir, git: stubGit() },
    );
    assert.equal(r.claimed, true);
    // Stub created.
    const stubAbs = path.join(dir, "src/config/feature-flags-runtime.js");
    const stubContent = await fs.readFile(stubAbs, "utf8");
    assert.match(stubContent, /export function initFeatureFlagsRuntime/);
  });
});

test("AF-4: declines when imported module file ALREADY exists (false-alarm blocker)", async () => {
  await withTempDir(async (dir) => {
    const file = "src/main.jsx";
    await fs.mkdir(path.join(dir, "src", "config"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "src/config/feature-flags-runtime.js"),
      "export function initFeatureFlagsRuntime() {}\n",
    );
    await fs.writeFile(
      path.join(dir, file),
      "import { initFeatureFlagsRuntime } from './config/feature-flags-runtime.js'\ninitFeatureFlagsRuntime()\n",
    );
    const r = await tryMissingImportFix(
      "claude",
      {
        severity: "blocker",
        category: "runtime-safety",
        message: "module './config/feature-flags-runtime.js' is not in this diff",
        file,
      },
      { cwd: dir, git: stubGit() },
    );
    assert.equal(r.claimed, false);
  });
});

test("AF-4: declines when no matching import is found", async () => {
  await withTempDir(async (dir) => {
    const file = "src/x.js";
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    await fs.writeFile(
      path.join(dir, file),
      "import { foo } from 'package-import'\nconsole.log(foo)\n",
    );
    const r = await tryMissingImportFix(
      "claude",
      {
        severity: "blocker",
        category: "runtime-safety",
        message: "module './missing.js' is not in this diff",
        file,
      },
      { cwd: dir, git: stubGit() },
    );
    // No relative import in the file → declines.
    assert.equal(r.claimed, false);
  });
});

test("AF-4: leaves source intact except the targeted import + call site", async () => {
  await withTempDir(async (dir) => {
    const file = "src/main.jsx";
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    const original =
      "import React from 'react'\n" +
      "import { initX } from './x.js'\n" +
      "\n" +
      "function Header() { return <h1>Hello</h1> }\n" +
      "\n" +
      "initX()\n" +
      "\n" +
      "export default Header;\n";
    await fs.writeFile(path.join(dir, file), original);
    const r = await tryMissingImportFix(
      "claude",
      {
        severity: "blocker",
        category: "runtime-safety",
        message: "module './x.js' is missing",
        file,
      },
      { cwd: dir, git: stubGit() },
    );
    assert.equal(r.claimed, true);
    // Importer source is now LEFT INTACT (post-stub-strategy fix).
    // The stub at ./x.js makes the import resolve at build time.
    const after = await fs.readFile(path.join(dir, file), "utf8");
    assert.equal(after, original);
    // Stub at ./x.js exists with no-op export for initX.
    const stubContent = await fs.readFile(path.join(dir, "src/x.js"), "utf8");
    assert.match(stubContent, /export function initX\(\)/);
  });
});
