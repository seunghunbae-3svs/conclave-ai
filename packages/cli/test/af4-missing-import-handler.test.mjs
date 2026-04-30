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

test("AF-4: claims when category=runtime-safety + message says 'not in this diff' + import exists", async () => {
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
          calls.push(args[0]);
          return { stdout: "", stderr: "" };
        },
      },
    );
    assert.equal(r.claimed, true);
    assert.equal(r.fix.status, "ready");
    assert.deepEqual(r.fix.appliedFiles, [file]);
    assert.equal(r.fix.costUsd, 0);
    // git add ran.
    assert.ok(calls.includes("add"));
    // File was rewritten — original static import should be commented out.
    const after = await fs.readFile(path.join(dir, file), "utf8");
    assert.ok(after.includes("// AF-4"), "marker comment present");
    assert.ok(!/^\s*import\s+\{\s*initFeatureFlagsRuntime\s*\}/m.test(after), "static import line replaced");
    // Top-level call was wrapped in IIFE.
    assert.ok(after.includes("await import('./config/feature-flags-runtime.js')"));
    assert.ok(after.includes("try { const m = await import"));
    assert.ok(after.includes("catch {}"));
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
    const after = await fs.readFile(path.join(dir, file), "utf8");
    // React import untouched.
    assert.ok(after.includes("import React from 'react'"));
    // Header function untouched.
    assert.ok(after.includes("function Header() { return <h1>Hello</h1> }"));
    assert.ok(after.includes("export default Header;"));
    // initX import + call mechanically wrapped.
    assert.ok(after.includes("AF-4"));
    assert.ok(after.includes("await import('./x.js')"));
  });
});
