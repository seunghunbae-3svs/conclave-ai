/**
 * Phase B.9 — design domain wiring (UI PR routing).
 *
 * A user opens a PR touching React components / Tailwind config /
 * SVG assets. The system MUST:
 *   1. detectDomain → "mixed" (so code agents stay in + design agent
 *      gets called with vision context).
 *   2. Pure backend PRs (no UI signals) → "code" — no needless visual
 *      capture cost.
 *   3. node_modules / dist / build excluded from signals (false-
 *      positive prevention).
 *   4. Image-only deletions don't trigger design domain.
 *   5. tests/test directories don't accidentally count as UI.
 *   6. The actual diff parser → changed-files extractor → detector
 *      pipeline works end-to-end on a real diff string (not just
 *      pre-built ChangedFile arrays).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectDomain, extractChangedFilesFromDiff } from "../dist/lib/domain-detect.js";

function diffOf(files) {
  // Build a unified-diff text of given file paths so we go through the
  // SAME extractor review.ts uses.
  return files
    .map(({ path: p, status = "modified" }) => {
      if (status === "deleted") {
        return `diff --git a/${p} b/${p}\ndeleted file mode 100644\n--- a/${p}\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n`;
      }
      return `diff --git a/${p} b/${p}\nindex abc..def 100644\n--- a/${p}\n+++ b/${p}\n@@ -1,1 +1,2 @@\n+new line\n`;
    })
    .join("");
}

test("B.9: pure backend PR (only .ts under src/api/) → domain=code", () => {
  const diff = diffOf([
    { path: "src/api/users.ts" },
    { path: "src/api/auth.ts" },
    { path: "test/api/users.test.ts" },
  ]);
  const changed = extractChangedFilesFromDiff(diff);
  assert.ok(changed.length >= 2);
  const out = detectDomain(changed);
  assert.equal(out.domain, "code");
  assert.match(out.reason, /no UI-signal/);
  assert.equal(out.signals.length, 0);
});

test("B.9: PR touching .tsx component → domain=mixed", () => {
  const diff = diffOf([
    { path: "src/components/Button.tsx" },
    { path: "src/api/users.ts" },
  ]);
  const out = detectDomain(extractChangedFilesFromDiff(diff));
  assert.equal(out.domain, "mixed", "any tsx in components/ flips to mixed");
  assert.ok(out.signals.length >= 1);
});

test("B.9: PR touching tailwind.config.js → mixed (theme-level change is design-relevant)", () => {
  const diff = diffOf([{ path: "tailwind.config.js" }]);
  const out = detectDomain(extractChangedFilesFromDiff(diff));
  assert.equal(out.domain, "mixed");
});

test("B.9: PR touching only SVG assets → mixed", () => {
  const diff = diffOf([
    { path: "public/icons/logo.svg" },
    { path: "src/assets/hero.png" },
  ]);
  const out = detectDomain(extractChangedFilesFromDiff(diff));
  assert.equal(out.domain, "mixed");
});

test("B.9: image-only DELETE → domain=code (housekeeping, not design work)", () => {
  const diff = diffOf([
    { path: "public/old-icon.svg", status: "deleted" },
    { path: "src/api/users.ts" },
  ]);
  const out = detectDomain(extractChangedFilesFromDiff(diff));
  // Deleted SVG is excluded as a UI signal, but src/api/users.ts is not
  // a UI signal either. Result: code.
  assert.equal(out.domain, "code");
});

test("B.9: node_modules / dist / build excluded — never trigger design domain", () => {
  const diff = diffOf([
    { path: "node_modules/lib/dist/foo.tsx" },
    { path: "dist/main.css" },
    { path: "build/index.html" },
  ]);
  const out = detectDomain(extractChangedFilesFromDiff(diff));
  assert.equal(out.domain, "code");
  assert.match(out.reason, /excluded|no UI-signal/i);
});

test("B.9: empty diff (no files changed) → domain=code with explicit reason", () => {
  const out = detectDomain([]);
  assert.equal(out.domain, "code");
  assert.equal(out.reason, "no changed files");
});

test("B.9: pages/ + views/ + layouts/ all count as UI signals (route-level)", () => {
  const diff = diffOf([{ path: "src/pages/Login.tsx" }]);
  assert.equal(detectDomain(extractChangedFilesFromDiff(diff)).domain, "mixed");
  const diff2 = diffOf([{ path: "src/views/Profile.vue" }]);
  assert.equal(detectDomain(extractChangedFilesFromDiff(diff2)).domain, "mixed");
  const diff3 = diffOf([{ path: "src/layouts/AppShell.svelte" }]);
  assert.equal(detectDomain(extractChangedFilesFromDiff(diff3)).domain, "mixed");
});

test("B.9: stylesheet (.css/.scss) counts as UI signal", () => {
  const diff = diffOf([{ path: "src/global.css" }]);
  assert.equal(detectDomain(extractChangedFilesFromDiff(diff)).domain, "mixed");
  const diff2 = diffOf([{ path: "src/components/Card.scss" }]);
  assert.equal(detectDomain(extractChangedFilesFromDiff(diff2)).domain, "mixed");
});

test("B.9: detector takes custom uiSignals + excludes (config knob round-trip)", () => {
  const diff = diffOf([
    { path: "weird-ui-dir/Foo.svelte" },
    { path: "src/api/normal.ts" },
  ]);
  const changed = extractChangedFilesFromDiff(diff);
  // With default signals, Foo.svelte matches the .svelte glob → mixed.
  assert.equal(detectDomain(changed).domain, "mixed");
  // With a strict custom signal list excluding svelte → code.
  const out = detectDomain(changed, { uiSignals: ["**/*.tsx"] });
  assert.equal(out.domain, "code");
});

test("B.9: extractor + detector together — round-trip on a multi-hunk diff", () => {
  // Realistic shape: multiple files, one added, one modified, one
  // deleted. Verify the extractor doesn't lose any.
  const diff = [
    "diff --git a/src/Button.tsx b/src/Button.tsx",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/Button.tsx",
    "@@ -0,0 +1,3 @@",
    "+export function Button() {",
    "+  return <button />",
    "+}",
    "diff --git a/src/api/auth.ts b/src/api/auth.ts",
    "--- a/src/api/auth.ts",
    "+++ b/src/api/auth.ts",
    "@@ -1,1 +1,2 @@",
    "+const x = 1;",
    "diff --git a/legacy.css b/legacy.css",
    "deleted file mode 100644",
    "--- a/legacy.css",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-body{color:red}",
  ].join("\n");
  const changed = extractChangedFilesFromDiff(diff);
  // Extractor must surface all 3 files.
  const paths = changed.map((c) => c.path).sort();
  assert.deepEqual(paths, ["legacy.css", "src/Button.tsx", "src/api/auth.ts"]);
  // src/Button.tsx is a UI signal → mixed.
  const out = detectDomain(changed);
  assert.equal(out.domain, "mixed");
  assert.ok(out.signals.includes("src/Button.tsx"));
});

test("B.9: extractor preserves status (added/modified/deleted) for status-aware detection", () => {
  const diff = [
    "diff --git a/icon.svg b/icon.svg",
    "deleted file mode 100644",
    "--- a/icon.svg",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-x",
  ].join("\n");
  const changed = extractChangedFilesFromDiff(diff);
  assert.equal(changed.length, 1);
  assert.equal(changed[0].path, "icon.svg");
  assert.equal(changed[0].status, "deleted", "extractor must surface delete status for the image-skip rule");
});
