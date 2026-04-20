import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectDomain,
  extractChangedFilesFromDiff,
  globToRegExp,
  DEFAULT_UI_SIGNALS,
  DEFAULT_EXCLUDES,
} from "../dist/lib/domain-detect.js";

// ─── globToRegExp: unit coverage for the inline matcher ───────────────

test("globToRegExp: literal path matches", () => {
  const re = globToRegExp("src/index.ts");
  assert.equal(re.test("src/index.ts"), true);
  assert.equal(re.test("src/index.tsx"), false);
});

test("globToRegExp: ** spans directories", () => {
  const re = globToRegExp("**/*.tsx");
  assert.equal(re.test("Button.tsx"), true);
  assert.equal(re.test("src/components/Button.tsx"), true);
  assert.equal(re.test("a/b/c/d/Button.tsx"), true);
  assert.equal(re.test("Button.ts"), false);
});

test("globToRegExp: {a,b} alternation", () => {
  const re = globToRegExp("**/*.{css,scss}");
  assert.equal(re.test("styles.css"), true);
  assert.equal(re.test("app/styles.scss"), true);
  assert.equal(re.test("styles.less"), false);
});

test("globToRegExp: character class", () => {
  const re = globToRegExp("file[0-9].ts");
  assert.equal(re.test("file1.ts"), true);
  assert.equal(re.test("fileA.ts"), false);
});

// ─── extractChangedFilesFromDiff: diff parsing ────────────────────────

test("extractChangedFilesFromDiff: parses added + modified + deleted + renamed", () => {
  const diff = [
    "diff --git a/src/Button.tsx b/src/Button.tsx",
    "new file mode 100644",
    "index 0000000..abc",
    "--- /dev/null",
    "+++ b/src/Button.tsx",
    "@@ -0,0 +1,3 @@",
    "+export const Button = () => <div/>;",
    "diff --git a/src/old.ts b/src/old.ts",
    "deleted file mode 100644",
    "index abc..0000000",
    "--- a/src/old.ts",
    "+++ /dev/null",
    "diff --git a/src/util.ts b/src/util.ts",
    "index 111..222 100644",
    "--- a/src/util.ts",
    "+++ b/src/util.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "diff --git a/src/a.ts b/src/b.ts",
    "similarity index 100%",
    "rename from src/a.ts",
    "rename to src/b.ts",
  ].join("\n");
  const files = extractChangedFilesFromDiff(diff);
  assert.deepEqual(files, [
    { path: "src/Button.tsx", status: "added" },
    { path: "src/old.ts", status: "deleted" },
    { path: "src/util.ts", status: "modified" },
    { path: "src/b.ts", status: "renamed" },
  ]);
});

test("extractChangedFilesFromDiff: empty diff returns empty array", () => {
  assert.deepEqual(extractChangedFilesFromDiff(""), []);
  assert.deepEqual(extractChangedFilesFromDiff("   "), []);
});

// ─── detectDomain: behavior matrix ────────────────────────────────────

test("detectDomain: pure code (TS only) → code", () => {
  const r = detectDomain([
    { path: "src/foo.ts", status: "modified" },
    { path: "src/bar.ts", status: "added" },
  ]);
  assert.equal(r.domain, "code");
  assert.equal(r.signals.length, 0);
  assert.match(r.reason, /no UI-signal/i);
});

test("detectDomain: pure CSS → mixed (CSS is a UI signal)", () => {
  const r = detectDomain([{ path: "src/app.css", status: "modified" }]);
  assert.equal(r.domain, "mixed");
  assert.deepEqual(r.signals, ["src/app.css"]);
  assert.match(r.reason, /\*\.css/);
});

test("detectDomain: mixed JSX + CSS → mixed", () => {
  const r = detectDomain([
    { path: "src/Button.jsx", status: "added" },
    { path: "src/Button.css", status: "added" },
    { path: "src/util.ts", status: "modified" },
  ]);
  assert.equal(r.domain, "mixed");
  assert.equal(r.signals.length, 2);
});

test("detectDomain: Tailwind config change → mixed", () => {
  const r = detectDomain([
    { path: "tailwind.config.ts", status: "modified" },
  ]);
  assert.equal(r.domain, "mixed");
  assert.equal(r.signals[0], "tailwind.config.ts");
});

test("detectDomain: nested tailwind.config.js → mixed", () => {
  const r = detectDomain([
    { path: "apps/web/tailwind.config.js", status: "modified" },
  ]);
  assert.equal(r.domain, "mixed");
});

test("detectDomain: png added → mixed", () => {
  const r = detectDomain([
    { path: "public/hero.png", status: "added" },
  ]);
  assert.equal(r.domain, "mixed");
});

test("detectDomain: png deleted-only → code (no signal)", () => {
  const r = detectDomain([
    { path: "public/hero.png", status: "deleted" },
    { path: "src/cleanup.ts", status: "modified" },
  ]);
  assert.equal(r.domain, "code");
  assert.equal(r.signals.length, 0);
});

test("detectDomain: .test.tsx file → excluded (still code)", () => {
  const r = detectDomain([
    { path: "src/Button.test.tsx", status: "added" },
  ]);
  assert.equal(r.domain, "code");
  // All files excluded path — clear reason.
  assert.match(r.reason, /excluded/i);
});

test("detectDomain: node_modules path → excluded", () => {
  const r = detectDomain([
    { path: "node_modules/@foo/bar.css", status: "modified" },
    { path: "packages/app/node_modules/baz.tsx", status: "added" },
  ]);
  assert.equal(r.domain, "code");
  assert.match(r.reason, /excluded/i);
});

test("detectDomain: dist + .next excluded", () => {
  const r = detectDomain([
    { path: "dist/Button.tsx", status: "added" },
    { path: "apps/web/.next/static/index.css", status: "added" },
  ]);
  assert.equal(r.domain, "code");
});

test("detectDomain: design-system directory → mixed", () => {
  const r = detectDomain([
    { path: "packages/design-system/tokens.json", status: "modified" },
  ]);
  assert.equal(r.domain, "mixed");
});

test("detectDomain: empty changed-files → code with no-files reason", () => {
  const r = detectDomain([]);
  assert.equal(r.domain, "code");
  assert.match(r.reason, /no changed files/i);
  assert.deepEqual(r.signals, []);
});

test("detectDomain: custom uiSignals override — only .astro counts", () => {
  const r = detectDomain(
    [
      { path: "src/Button.tsx", status: "added" },
      { path: "src/page.astro", status: "added" },
    ],
    { uiSignals: ["**/*.astro"], excludes: [] },
  );
  // .astro matched; .tsx not in override list → signal count == 1
  assert.equal(r.domain, "mixed");
  assert.deepEqual(r.signals, ["src/page.astro"]);
});

test("detectDomain: custom excludes can drop an otherwise-matching file", () => {
  const r = detectDomain(
    [{ path: "stories/Button.tsx", status: "modified" }],
    { excludes: ["stories/**"] },
  );
  assert.equal(r.domain, "code");
});

test("detectDomain: Windows-style backslashes are normalized", () => {
  const r = detectDomain([
    { path: "src\\components\\Button.tsx", status: "modified" },
  ]);
  assert.equal(r.domain, "mixed");
});

test("detectDomain: CLI short-circuit simulation — review.ts should bypass detect when autoDetect.enabled=false", () => {
  // This is a documentation test: when `autoDetect.enabled: false`,
  // review.ts MUST NOT call detectDomain and MUST default to "code".
  // We simulate by never invoking detectDomain; the test simply asserts
  // that detectDomain itself is pure + side-effect-free so the CLI
  // short-circuit is safe.
  const before = detectDomain([{ path: "src/app.css", status: "modified" }]);
  const after = detectDomain([{ path: "src/app.css", status: "modified" }]);
  assert.deepEqual(before, after);
});

test("detectDomain: explicit --domain overrides all auto-detection (doc test)", () => {
  // Behavioral contract: when args.domain is passed in review.ts, the
  // CLI MUST NOT call detectDomain. This test documents that assumption
  // by asserting detectDomain is never required to return "code" for a
  // UI-heavy diff — the caller is responsible for the override.
  const r = detectDomain([
    { path: "src/Button.tsx", status: "added" },
    { path: "src/app.css", status: "modified" },
  ]);
  // Sanity: auto-detect would say mixed…
  assert.equal(r.domain, "mixed");
  // …but review.ts's `if (args.domain) { resolvedDomain = args.domain; … }`
  // guard prevents the call in the first place. No runtime override
  // needed inside detectDomain.
});

test("DEFAULT_UI_SIGNALS / DEFAULT_EXCLUDES are exported + non-empty", () => {
  assert.ok(Array.isArray(DEFAULT_UI_SIGNALS));
  assert.ok(DEFAULT_UI_SIGNALS.length >= 5);
  assert.ok(Array.isArray(DEFAULT_EXCLUDES));
  assert.ok(DEFAULT_EXCLUDES.length >= 5);
});
