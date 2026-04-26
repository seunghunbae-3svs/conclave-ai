import { test } from "node:test";
import assert from "node:assert/strict";
import { recountHunkHeaders } from "../dist/lib/patch-fixup.js";

/**
 * v0.13.10 — patch-fixup tests.
 *
 * Live RC source: eventbadge#29 sha 279cb22 cycle 2 emitted a hunk
 * header `@@ -14,7 +14,6 @@` with body containing only 5 source
 * lines (B should have been 5, not 7), causing `git apply --recount`
 * to bail with "corrupt patch at line 10" before --recount could do
 * its work. recountHunkHeaders rewrites the header to match the body.
 */

test("recountHunkHeaders: rewrites B/D to match body counts", () => {
  // Mirror of the eventbadge#29 cycle 2 patch.
  const patch = `diff --git a/frontend/src/utils/imageCompressor.js b/frontend/src/utils/imageCompressor.js
--- a/frontend/src/utils/imageCompressor.js
+++ b/frontend/src/utils/imageCompressor.js
@@ -14,7 +14,6 @@ export function compressImage(file, opts = {}) {
-  console.log('[debug] compressImage called', file?.name);
-  const {
+  const {
     maxWidth = 1920,
     maxHeight = 1080,
     quality = 0.75,
`;
  const fixed = recountHunkHeaders(patch);
  // 5 source lines (2 deletions + 3 context), 4 result lines (1 add + 3 context).
  assert.match(fixed, /^@@ -14,5 \+14,4 @@ export function/m);
});

test("recountHunkHeaders: leaves correctly-counted hunks untouched (idempotent)", () => {
  const patch = `diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -1,3 +1,3 @@
 a
-b
+B
 c
`;
  // Body has 3 source (a, b, c) and 3 result (a, B, c).
  const fixed = recountHunkHeaders(patch);
  assert.match(fixed, /^@@ -1,3 \+1,3 @@$/m);
  // Body lines preserved.
  assert.ok(fixed.includes(" a\n-b\n+B\n c"));
});

test("recountHunkHeaders: handles single-add (B=0) and single-delete (D=0)", () => {
  const addOnly = `--- a/x
+++ b/x
@@ -10,99 +10,99 @@
+new line
`;
  const fixed = recountHunkHeaders(addOnly);
  assert.match(fixed, /^@@ -10,0 \+10,1 @@$/m);

  const delOnly = `--- a/x
+++ b/x
@@ -5,5 +5,5 @@
-gone
`;
  const fixed2 = recountHunkHeaders(delOnly);
  assert.match(fixed2, /^@@ -5,1 \+5,0 @@$/m);
});

test("recountHunkHeaders: walks multiple hunks across the same file", () => {
  const patch = `--- a/x
+++ b/x
@@ -1,99 +1,99 @@
 a
-b
+B
@@ -10,99 +10,99 @@
 c
 d
-e
`;
  const fixed = recountHunkHeaders(patch);
  // Hunk 1: 2 source (a, b), 2 result (a, B).
  assert.match(fixed, /^@@ -1,2 \+1,2 @@$/m);
  // Hunk 2: 3 source (c, d, e), 2 result (c, d).
  assert.match(fixed, /^@@ -10,3 \+10,2 @@$/m);
});

test("recountHunkHeaders: walks multiple hunks across multiple files", () => {
  const patch = `--- a/x
+++ b/x
@@ -1,99 +1,99 @@
 a
-b
+B
diff --git a/y b/y
--- a/y
+++ b/y
@@ -5,99 +5,99 @@
 c
+d
`;
  const fixed = recountHunkHeaders(patch);
  assert.match(fixed, /^@@ -1,2 \+1,2 @@$/m);
  assert.match(fixed, /^@@ -5,1 \+5,2 @@$/m);
});

test("recountHunkHeaders: preserves @@ context-suffix (function-name annotation)", () => {
  const patch = `--- a/x
+++ b/x
@@ -1,99 +1,99 @@ export function foo() {
 a
-b
+B
`;
  const fixed = recountHunkHeaders(patch);
  assert.match(fixed, /^@@ -1,2 \+1,2 @@ export function foo\(\) \{$/m);
});

test("recountHunkHeaders: handles 'no newline at end of file' marker", () => {
  const patch = `--- a/x
+++ b/x
@@ -1,99 +1,99 @@
-a
+A
\\ No newline at end of file
`;
  const fixed = recountHunkHeaders(patch);
  // \\ marker doesn't count as either source or result.
  assert.match(fixed, /^@@ -1,1 \+1,1 @@$/m);
});

test("recountHunkHeaders: empty / non-hunk input returns input unchanged", () => {
  assert.equal(recountHunkHeaders(""), "");
  assert.equal(recountHunkHeaders("not a patch\nnope"), "not a patch\nnope");
  // Single header with no body recounts to 0/0 (no source / no result lines).
  // This is structurally consistent — the apply layer will reject an empty
  // hunk anyway, but the recount itself shouldn't lie.
  assert.match(recountHunkHeaders("@@ -1,5 +1,5 @@\n"), /^@@ -1,0 \+1,0 @@$/m);
});

test("recountHunkHeaders: handles header without explicit count (defaults to ',1' equivalent)", () => {
  // Some emitters write `@@ -A +C @@` (no comma-count) when count = 1.
  // Our regex accepts that form; we always re-emit with explicit counts.
  const patch = `--- a/x
+++ b/x
@@ -3 +3 @@
-old
+new
`;
  const fixed = recountHunkHeaders(patch);
  assert.match(fixed, /^@@ -3,1 \+3,1 @@$/m);
});
