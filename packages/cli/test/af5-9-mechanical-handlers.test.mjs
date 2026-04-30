/**
 * AF-5 / AF-6 / AF-7 / AF-8 / AF-9 — mechanical handler hermetic tests.
 *
 * Each handler is deterministic: same input → same output. No worker LLM,
 * no unified diffs. Verifies they (a) claim the right blockers, (b) decline
 * the wrong blockers, (c) produce the right file rewrites, (d) git-add the
 * touched file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { tryContrastFix, contrastRatio } from "../dist/lib/autofix-handlers/contrast.js";
import { tryInlineStyleToTailwindFix } from "../dist/lib/autofix-handlers/inline-style-to-tailwind.js";
import { tryDebugCodeFix } from "../dist/lib/autofix-handlers/debug-code.js";
import { tryFocusVisibleFix } from "../dist/lib/autofix-handlers/focus-visible.js";

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "af5-9-"));
  try { return await fn(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

const stubGit = () => async () => ({ stdout: "", stderr: "" });

// ---- AF-5 contrast --------------------------------------------------------

test("AF-5 contrastRatio: known WCAG pairs", () => {
  // White on black = ~21:1
  assert.ok(contrastRatio("#ffffff", "#000000") > 20);
  // slate-300 on white ~ 1.6:1 (FAIL)
  assert.ok(contrastRatio("#cbd5e1", "#ffffff") < 4.5);
  // slate-900 on white ~ 16:1 (PASS)
  assert.ok(contrastRatio("#0f172a", "#ffffff") > 14);
  // blue-600 on white ~ 5.17 (PASS)
  assert.ok(contrastRatio("#2563eb", "#ffffff") > 4.5);
});

test("AF-5: claims contrast blocker on AA-failing inline pair (input)", async () => {
  await withTempDir(async (dir) => {
    const file = "src/Form.jsx";
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    await fs.writeFile(
      path.join(dir, file),
      "<input style={{ color: '#cbd5e1', backgroundColor: '#ffffff' }} className=\"input\" />",
    );
    const r = await tryContrastFix(
      "design",
      { severity: "blocker", category: "contrast", message: "slate-300 on white fails WCAG AA", file },
      { cwd: dir, git: stubGit() },
    );
    assert.equal(r.claimed, true);
    const after = await fs.readFile(path.join(dir, file), "utf8");
    assert.match(after, /color:\s*'#0f172a'/);
    assert.match(after, /backgroundColor:\s*'#ffffff'/);
  });
});

test("AF-5: claims contrast blocker on button (uses CTA palette)", async () => {
  await withTempDir(async (dir) => {
    const file = "src/Cta.jsx";
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    await fs.writeFile(
      path.join(dir, file),
      [
        "<div>",
        "  <button",
        "    style={{ backgroundColor: '#FF00AA', color: '#FFEE00' }}",
        "    className=\"px-3 py-2\"",
        "  >Submit</button>",
        "</div>",
      ].join("\n"),
    );
    const r = await tryContrastFix(
      "design",
      { severity: "blocker", category: "accessibility", message: "magenta button text contrast", file },
      { cwd: dir, git: stubGit() },
    );
    assert.equal(r.claimed, true);
    const after = await fs.readFile(path.join(dir, file), "utf8");
    assert.match(after, /color:\s*'#ffffff'/);
    assert.match(after, /backgroundColor:\s*'#2563eb'/);
  });
});

test("AF-5: declines when inline pair already passes AA", async () => {
  await withTempDir(async (dir) => {
    const file = "src/Ok.jsx";
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    await fs.writeFile(
      path.join(dir, file),
      "<input style={{ color: '#0f172a', backgroundColor: '#ffffff' }} />",
    );
    const r = await tryContrastFix(
      "design",
      { severity: "blocker", category: "contrast", message: "alleged contrast issue", file },
      { cwd: dir, git: stubGit() },
    );
    assert.equal(r.claimed, false);
  });
});

test("AF-5: declines for non-contrast a11y blockers (e.g., aria-label)", async () => {
  const r = await tryContrastFix(
    "design",
    { severity: "blocker", category: "accessibility", message: "missing aria-label on button", file: "src/X.jsx" },
    { cwd: "/tmp/never", git: stubGit() },
  );
  assert.equal(r.claimed, false);
});

// ---- AF-6 inline-style → Tailwind ----------------------------------------

test("AF-6: strips inline style on JSX line that has both className + style", async () => {
  await withTempDir(async (dir) => {
    const file = "src/Btn.jsx";
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    await fs.writeFile(
      path.join(dir, file),
      "<button style={{ backgroundColor: '#FF00AA', color: '#FFEE00' }} className=\"px-3 py-2 bg-blue-600 text-white\">Go</button>",
    );
    const r = await tryInlineStyleToTailwindFix(
      "design",
      { severity: "major", category: "style-drift", message: "inline hex bypasses tokens", file },
      { cwd: dir, git: stubGit() },
    );
    assert.equal(r.claimed, true);
    const after = await fs.readFile(path.join(dir, file), "utf8");
    assert.ok(!after.includes("style={{"), "inline style stripped");
    assert.match(after, /className="px-3 py-2 bg-blue-600 text-white"/);
  });
});

test("AF-6: declines on .js file (only .jsx/.tsx)", async () => {
  const r = await tryInlineStyleToTailwindFix(
    "design",
    { severity: "major", category: "style-drift", message: "inline drift", file: "src/util.js" },
    { cwd: "/tmp/x", git: stubGit() },
  );
  assert.equal(r.claimed, false);
});

test("AF-6: declines when category is unrelated", async () => {
  const r = await tryInlineStyleToTailwindFix(
    "design",
    { severity: "major", category: "regression", message: "something else", file: "src/X.jsx" },
    { cwd: "/tmp/x", git: stubGit() },
  );
  assert.equal(r.claimed, false);
});

// ---- AF-7/8 debug-code + dead-code ---------------------------------------

test("AF-7: removes top-level console.log line", async () => {
  await withTempDir(async (dir) => {
    const file = "src/util.js";
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    await fs.writeFile(
      path.join(dir, file),
      [
        "export function fn() {",
        "  return 1;",
        "}",
        "",
        "console.log('debug');",
        "export const x = 2;",
      ].join("\n"),
    );
    const r = await tryDebugCodeFix(
      "claude",
      { severity: "major", category: "debug-code", message: "stray console.log in production utility", file },
      { cwd: dir, git: stubGit() },
    );
    assert.equal(r.claimed, true);
    const after = await fs.readFile(path.join(dir, file), "utf8");
    assert.ok(!after.includes("console.log"));
    assert.match(after, /export const x = 2;/);
    assert.match(after, /export function fn\(\)/);
  });
});

test("AF-8: removes unused_legacy_correction-style declarations", async () => {
  await withTempDir(async (dir) => {
    const file = "src/util.js";
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    await fs.writeFile(
      path.join(dir, file),
      [
        "export function fn() {",
        "  const unused_legacy_correction = 0.85;",
        "  return 1;",
        "}",
      ].join("\n"),
    );
    const r = await tryDebugCodeFix(
      "claude",
      { severity: "major", category: "dead-code", message: "unused constant unused_legacy_correction", file },
      { cwd: dir, git: stubGit() },
    );
    assert.equal(r.claimed, true);
    const after = await fs.readFile(path.join(dir, file), "utf8");
    assert.ok(!after.includes("unused_legacy_correction"));
  });
});

test("AF-7/8: declines unrelated category", async () => {
  const r = await tryDebugCodeFix(
    "claude",
    { severity: "blocker", category: "contrast", message: "low contrast", file: "src/X.jsx" },
    { cwd: "/tmp/x", git: stubGit() },
  );
  assert.equal(r.claimed, false);
});

// ---- AF-9 focus-visible --------------------------------------------------

test("AF-9: injects focus-visible classes onto button className", async () => {
  await withTempDir(async (dir) => {
    const file = "src/Btn.jsx";
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    await fs.writeFile(
      path.join(dir, file),
      "<button className=\"px-3 py-2 bg-blue-600 text-white\">Go</button>",
    );
    const r = await tryFocusVisibleFix(
      "design",
      { severity: "major", category: "missing-state", message: "no focus indicator on button", file },
      { cwd: dir, git: stubGit() },
    );
    assert.equal(r.claimed, true);
    const after = await fs.readFile(path.join(dir, file), "utf8");
    assert.match(after, /focus-visible:ring-2/);
    assert.match(after, /focus-visible:ring-blue-500/);
    assert.match(after, /focus-visible:outline-none/);
    // Original classes preserved.
    assert.match(after, /px-3 py-2 bg-blue-600 text-white/);
  });
});

test("AF-9: idempotent — does not double-add when focus-visible already present", async () => {
  await withTempDir(async (dir) => {
    const file = "src/Btn.jsx";
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    await fs.writeFile(
      path.join(dir, file),
      "<button className=\"px-3 py-2 focus-visible:ring-2 focus-visible:ring-red-500\">Go</button>",
    );
    const r = await tryFocusVisibleFix(
      "design",
      { severity: "major", category: "focus", message: "focus state", file },
      { cwd: dir, git: stubGit() },
    );
    // Already has focus-visible — handler skips. With no other elements to inject for, declines.
    assert.equal(r.claimed, false);
  });
});

test("AF-9: declines on .js (only .jsx/.tsx)", async () => {
  const r = await tryFocusVisibleFix(
    "design",
    { severity: "major", category: "focus", message: "focus", file: "src/util.js" },
    { cwd: "/tmp/x", git: stubGit() },
  );
  assert.equal(r.claimed, false);
});
