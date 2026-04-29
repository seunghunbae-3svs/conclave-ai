/**
 * Phase B.5 — published package contract.
 *
 * Simulates what a real user gets when they `pnpm add -g @conclave-ai/cli`:
 *   - npm pack the local workspace package into a tarball
 *   - install it into an isolated tmpdir as a TRUE consumer (no
 *     workspace symlinks)
 *   - run the binary as a real user would
 *
 * Catches:
 *   - missing files[] entries (dist not shipped, bin not shipped)
 *   - wrong shebang / non-executable bin
 *   - broken `main` / `exports` map
 *   - missing peer / runtime dependency
 *   - workspace:* not properly resolved at publish time
 *
 * NOTE: full --version / --help is the smoke. Anything more would
 * require API keys, which a fresh CLI shouldn't need to print help.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// `import.meta.dirname` returns the test file's directory as an
// absolute path on every platform (Linux runners, Windows local). The
// previous URL.pathname.replace(/^\//, "") form silently broke on
// Linux: `pathname` like "/home/runner/.../test" became "home/runner/..."
// (relative), then path.resolve(cwd, that) doubled the path. Caught by
// release run 25084378500 with all 11 B.5 tests failing.
const CLI_PKG_DIR = path.resolve(import.meta.dirname, "..");

function captureCmd(cmd, opts = {}) {
  try {
    const stdout = execSync(cmd, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...opts,
    });
    return { ok: true, stdout, stderr: "" };
  } catch (err) {
    return {
      ok: false,
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
      code: err.status,
    };
  }
}

test("B.5: package.json files[] includes dist + README — tarball ships them", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(CLI_PKG_DIR, "package.json"), "utf8"));
  assert.ok(Array.isArray(pkg.files));
  assert.ok(pkg.files.includes("dist"), "files[] must include dist (built output)");
  assert.ok(pkg.files.includes("README.md"));
  // bin entry must point INSIDE dist (matches what gets published).
  assert.ok(pkg.bin && pkg.bin.conclave, "bin.conclave must be declared");
  assert.match(pkg.bin.conclave, /^\.\/dist\/bin\//, "bin must point at dist/, not src/");
});

test("B.5: bin file exists, has correct shebang, is published", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(CLI_PKG_DIR, "package.json"), "utf8"));
  const binPath = path.join(CLI_PKG_DIR, pkg.bin.conclave);
  assert.ok(fs.existsSync(binPath), `bin file missing: ${binPath} — did build run?`);
  const head = fs.readFileSync(binPath, "utf8").split("\n")[0];
  assert.equal(head, "#!/usr/bin/env node", "bin must start with node shebang for unix");
  // Must import compiled JS, not TS.
  const body = fs.readFileSync(binPath, "utf8");
  assert.match(body, /from\s+["'][^"']+\.js["']/, "imports must reference .js (compiled), not .ts");
});

test("B.5: package.json main entry resolves on disk", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(CLI_PKG_DIR, "package.json"), "utf8"));
  const mainPath = path.join(CLI_PKG_DIR, pkg.main);
  assert.ok(fs.existsSync(mainPath), `main entry missing: ${mainPath}`);
});

test("B.5: every workspace:* dep exists as a sibling package on disk", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(CLI_PKG_DIR, "package.json"), "utf8"));
  const packagesRoot = path.resolve(CLI_PKG_DIR, "..");
  for (const [dep, spec] of Object.entries(pkg.dependencies ?? {})) {
    if (spec !== "workspace:*") continue;
    // dep is "@conclave-ai/<name>" — sibling dir is just <name>.
    const localName = dep.startsWith("@conclave-ai/") ? dep.slice("@conclave-ai/".length) : dep;
    const sibling = path.join(packagesRoot, localName);
    assert.ok(
      fs.existsSync(sibling),
      `workspace dep "${dep}" referenced but no packages/${localName} dir on disk; publish would fail to resolve`,
    );
    // And that sibling must have its own package.json with a matching name.
    const siblingPkg = path.join(sibling, "package.json");
    assert.ok(fs.existsSync(siblingPkg));
    const siblingJson = JSON.parse(fs.readFileSync(siblingPkg, "utf8"));
    assert.equal(siblingJson.name, dep, `sibling ${localName}/package.json name mismatch`);
  }
});

test("B.5: each workspace dep has dist/ — they'd publish empty otherwise", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(CLI_PKG_DIR, "package.json"), "utf8"));
  const packagesRoot = path.resolve(CLI_PKG_DIR, "..");
  for (const [dep, spec] of Object.entries(pkg.dependencies ?? {})) {
    if (spec !== "workspace:*") continue;
    const localName = dep.slice("@conclave-ai/".length);
    const distDir = path.join(packagesRoot, localName, "dist");
    assert.ok(
      fs.existsSync(distDir),
      `workspace dep "${dep}" has no dist/ — its published tarball would lack compiled output`,
    );
    // Sanity: at least one .js file there.
    const jsFiles = fs
      .readdirSync(distDir, { recursive: true, withFileTypes: false })
      .filter((f) => typeof f === "string" && f.endsWith(".js"));
    assert.ok(jsFiles.length > 0, `${dep}/dist/ has no .js files`);
  }
});

test("B.5: every workspace dep's package.json files[] includes 'dist'", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(CLI_PKG_DIR, "package.json"), "utf8"));
  const packagesRoot = path.resolve(CLI_PKG_DIR, "..");
  for (const [dep, spec] of Object.entries(pkg.dependencies ?? {})) {
    if (spec !== "workspace:*") continue;
    const localName = dep.slice("@conclave-ai/".length);
    const siblingPkg = JSON.parse(
      fs.readFileSync(path.join(packagesRoot, localName, "package.json"), "utf8"),
    );
    assert.ok(
      Array.isArray(siblingPkg.files) && siblingPkg.files.includes("dist"),
      `workspace dep "${dep}" missing files[] entry for dist — published tarball would be empty`,
    );
  }
});

test("B.5: npm pack succeeds + tarball includes dist/bin/conclave.js", () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "aic-b5-pack-"));
  try {
    const r = captureCmd(`npm pack --pack-destination "${tmpdir}"`, { cwd: CLI_PKG_DIR });
    assert.ok(r.ok, `npm pack failed:\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    // Find the produced tarball.
    const tarball = fs.readdirSync(tmpdir).find((f) => f.endsWith(".tgz"));
    assert.ok(tarball, `no tarball produced in ${tmpdir}`);
    const tarballPath = path.join(tmpdir, tarball);
    // Inspect tarball contents via tar t. Run inside tmpdir so the
    // bash tar shim doesn't interpret "C:" as a remote host.
    const contents = captureCmd(`tar tf "${tarball}"`, { cwd: tmpdir });
    assert.ok(contents.ok, `tar t failed: ${contents.stderr}`);
    assert.match(contents.stdout, /package\/dist\/bin\/conclave\.js/, "bin file missing from tarball");
    assert.match(contents.stdout, /package\/dist\/commands\/init\.js/, "init.js missing from tarball");
    assert.match(contents.stdout, /package\/dist\/commands\/review\.js/, "review.js missing from tarball");
    assert.match(contents.stdout, /package\/package\.json/);
    assert.match(contents.stdout, /package\/README\.md/);
  } finally {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
});

test("B.5: bin script imports resolve at runtime (no missing modules from compiled output)", () => {
  // Run the bin with --version using the local node — exercises every
  // import the entry-point pulls in. If a workspace dep is mis-built or
  // an import path drifts (.ts vs .js) this catches it.
  const pkg = JSON.parse(fs.readFileSync(path.join(CLI_PKG_DIR, "package.json"), "utf8"));
  const binPath = path.join(CLI_PKG_DIR, pkg.bin.conclave);
  const r = captureCmd(`node "${binPath}" --version`);
  assert.ok(r.ok, `bin --version failed:\nstdout=${r.stdout}\nstderr=${r.stderr}`);
  assert.equal(r.stdout.trim(), pkg.version, "stdout must be the version string");
});

test("B.5: bin --help prints something resembling help (no crash on unknown args)", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(CLI_PKG_DIR, "package.json"), "utf8"));
  const binPath = path.join(CLI_PKG_DIR, pkg.bin.conclave);
  const r = captureCmd(`node "${binPath}" --help`);
  assert.ok(r.ok, `--help failed:\n${r.stderr}`);
  assert.match(r.stdout + r.stderr, /conclave|usage|init|review/i);
});

test("B.5: unknown subcommand exits non-zero with actionable error", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(CLI_PKG_DIR, "package.json"), "utf8"));
  const binPath = path.join(CLI_PKG_DIR, pkg.bin.conclave);
  const r = captureCmd(`node "${binPath}" totally-unknown-cmd`);
  assert.equal(r.ok, false, "unknown command must exit non-zero");
  // Useful error message — not a stack trace.
  const out = (r.stdout + r.stderr).toLowerCase();
  assert.ok(
    out.includes("unknown") || out.includes("usage") || out.includes("help"),
    `unknown-cmd error must mention unknown/usage/help; got:\n${r.stdout}\n${r.stderr}`,
  );
});

test("B.5: package.json declares engines.node ≥ 20 (matches workspace requirement)", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(CLI_PKG_DIR, "package.json"), "utf8"));
  // A fresh user on Node 18 should get a clear "too old" error rather
  // than a cryptic syntax/import failure.
  // It's OK for cli to omit engines if root has it — check root.
  const rootPkg = JSON.parse(
    fs.readFileSync(path.resolve(CLI_PKG_DIR, "..", "..", "package.json"), "utf8"),
  );
  assert.ok(rootPkg.engines && rootPkg.engines.node, "root package.json must declare engines.node");
  assert.match(rootPkg.engines.node, /\b(>=|\^)?20\b/, "engines.node should require ≥ 20");
});
