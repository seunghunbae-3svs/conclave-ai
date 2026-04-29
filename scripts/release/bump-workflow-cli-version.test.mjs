/**
 * PIA-1 — bump-workflow-cli-version unit tests + the LIVE INVARIANT
 * that catches drift even outside release runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  WORKFLOW_FILES,
  replaceCliVersionPin,
} from "./bump-workflow-cli-version.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

test("replaceCliVersionPin: rewrites the cli-version default to the target", () => {
  const yaml = [
    "name: x",
    "on: workflow_call",
    "inputs:",
    "  cli-version:",
    "    description: 'pinned'",
    "    required: false",
    "    type: string",
    "    default: 0.13.24",
    "  build-cmd:",
    "    default: ''",
    "",
  ].join("\n");
  const out = replaceCliVersionPin(yaml, "0.14.0");
  assert.equal(out.changed, true);
  assert.equal(out.prevVersion, "0.13.24");
  assert.match(out.body, /default: 0\.14\.0\b/);
  // build-cmd default is left alone
  assert.match(out.body, /default: ''/);
});

test("replaceCliVersionPin: idempotent when already at target", () => {
  const yaml = "cli-version:\n  default: 0.14.0";
  const out = replaceCliVersionPin(yaml, "0.14.0");
  assert.equal(out.changed, false);
  assert.equal(out.prevVersion, "0.14.0");
});

test("replaceCliVersionPin: file with no cli-version block is a no-op", () => {
  const yaml = "name: foo\non: push\njobs:\n  x:\n    runs-on: ubuntu-latest";
  const out = replaceCliVersionPin(yaml, "0.14.0");
  assert.equal(out.changed, false);
  assert.equal(out.prevVersion, null);
});

test("replaceCliVersionPin: only touches the FIRST cli-version block (defensive)", () => {
  const yaml = [
    "cli-version:",
    "  default: 0.13.24",
    "another:",
    "  cli-version:",
    "    default: 0.99.99",
  ].join("\n");
  const out = replaceCliVersionPin(yaml, "0.14.0");
  // The regex matches the first cli-version block; the second is left.
  assert.equal(out.changed, true);
  assert.match(out.body, /default: 0\.14\.0/);
});

// LIVE INVARIANT — runs every CI build, catches drift.
test("LIVE INVARIANT: every workflow's cli-version default == packages/cli/package.json .version", () => {
  const cliPkg = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "packages/cli/package.json"), "utf8"),
  );
  const cliVersion = cliPkg.version;
  for (const rel of WORKFLOW_FILES) {
    const body = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
    const m = body.match(/cli-version:[\s\S]*?default:\s+([\d]+\.[\d]+\.[\d]+)/);
    assert.ok(m, `${rel}: cli-version default not found`);
    assert.equal(
      m[1],
      cliVersion,
      `${rel}: workflow default ${m[1]} ≠ cli package version ${cliVersion}. ` +
        `Run \`node scripts/release/bump-workflow-cli-version.mjs\` to bring them in lockstep.`,
    );
  }
});

test("LIVE INVARIANT: workflow file count is exactly 3 (no orphans, no missing)", () => {
  for (const rel of WORKFLOW_FILES) {
    assert.ok(
      fs.existsSync(path.join(REPO_ROOT, rel)),
      `expected workflow file ${rel} to exist`,
    );
  }
  assert.equal(WORKFLOW_FILES.length, 3);
});

// PIA-1 follow-on — release.yml must grant `workflows: write` so its
// GITHUB_TOKEN can push the auto-bumped workflow files. Without this,
// bump-workflow-cli-version.mjs runs successfully but `git push` is
// rejected with "refusing to allow a GitHub App to create or update
// workflow ...". Live-caught on release run #25104136096.
test("LIVE INVARIANT: release.yml grants `workflows: write` so PIA-1 push doesn't fail", () => {
  const release = fs.readFileSync(path.join(REPO_ROOT, ".github/workflows/release.yml"), "utf8");
  // Match the top-level `permissions:` block (the one followed by
  // `jobs:`). Inside it, look for `workflows: write`.
  const permsBlock = release.match(/^permissions:\n([\s\S]*?)\njobs:/m);
  assert.ok(permsBlock, "release.yml has a top-level permissions block");
  assert.match(
    permsBlock[1],
    /^\s+workflows:\s+write/m,
    "release.yml's permissions block must include `workflows: write` — without it, PIA-1's auto-bump push gets rejected by GitHub Actions",
  );
});
