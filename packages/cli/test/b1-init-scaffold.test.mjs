/**
 * Phase B.1 — `conclave init` scaffolding on a real fixture git repo.
 *
 * Spins up a TEMP git repo with a fake `origin` remote, runs runInit
 * with --yes --skip-oauth, and verifies the on-disk state matches
 * the documented contract:
 *   - .conclaverc.json valid (loadConfig parses cleanly)
 *   - .github/workflows/conclave.yml present (review wrapper)
 *   - .github/workflows/conclave-rework.yml present
 *   - .github/workflows/conclave-merge.yml present
 *   - exit code 0
 *   - re-running without --reconfigure skips writes (idempotent)
 *   - re-running WITH --reconfigure overwrites cleanly
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInit } from "../dist/commands/init.js";
import { loadConfig } from "../dist/lib/config.js";

function freshGitRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aic-b1-init-"));
  // Fake repo with a fake `origin` remote so detectRepo via git config works.
  execSync("git init -q", { cwd: root });
  execSync('git config user.email "test@test"', { cwd: root });
  execSync('git config user.name "test"', { cwd: root });
  execSync("git remote add origin https://github.com/acme/fixture-app.git", { cwd: root });
  return root;
}
function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

function captureOut() {
  const lines = [];
  return {
    stdout: (s) => lines.push(s),
    stderr: (s) => lines.push(`stderr:${s}`),
    text: () => lines.join(""),
  };
}

test("B.1: fresh init scaffolds .conclaverc.json + 3 workflow files + exits 0", async () => {
  const root = freshGitRepo();
  try {
    const cap = captureOut();
    const exitCode = await runInit(
      {
        yes: true,
        reconfigure: false,
        cwd: root,
        skipOauth: true,
        help: false,
      },
      { stdout: cap.stdout, stderr: cap.stderr },
    );
    assert.equal(exitCode, 0, `init failed:\n${cap.text()}`);

    // .conclaverc.json present + parseable
    const cfgPath = path.join(root, ".conclaverc.json");
    assert.ok(fs.existsSync(cfgPath), `.conclaverc.json missing — output:\n${cap.text()}`);
    const { config } = await loadConfig(root);
    assert.equal(config.version, 1);
    // The defaults the wizard wrote should be valid + complete enough
    // for the rest of the system.
    assert.ok(Array.isArray(config.agents) && config.agents.length > 0);
    assert.equal(config.memory.activeFailureGate, true, "active gate ON by default (H2 #7)");
    assert.equal(config.efficiency.diffSplitter, true, "diff-splitter ON by default (H2 #9)");
    assert.equal(config.council.agentScoreRouting, true, "score-routing ON by default (H2 #10)");

    // 3 workflows
    const wf1 = path.join(root, ".github/workflows/conclave.yml");
    const wf2 = path.join(root, ".github/workflows/conclave-rework.yml");
    const wf3 = path.join(root, ".github/workflows/conclave-merge.yml");
    assert.ok(fs.existsSync(wf1), `${wf1} missing`);
    assert.ok(fs.existsSync(wf2), `${wf2} missing`);
    assert.ok(fs.existsSync(wf3), `${wf3} missing`);

    // Workflows must be reusable-workflow wrappers pointing at the
    // central conclave-ai repo, not inlined logic.
    const wf1Body = fs.readFileSync(wf1, "utf8");
    assert.match(wf1Body, /seunghunbae-3svs\/conclave-ai/);
    assert.match(wf1Body, /workflows\/review\.yml/);
  } finally {
    cleanup(root);
  }
});

test("B.1: re-running init WITHOUT --reconfigure is idempotent (no overwrites, exit 0)", async () => {
  const root = freshGitRepo();
  try {
    const cap1 = captureOut();
    let exit = await runInit(
      { yes: true, reconfigure: false, cwd: root, skipOauth: true, help: false },
      { stdout: cap1.stdout, stderr: cap1.stderr },
    );
    assert.equal(exit, 0);

    // Sentinel write: bump the timestamp so we can detect overwrite.
    const cfgPath = path.join(root, ".conclaverc.json");
    const before = fs.readFileSync(cfgPath, "utf8");

    const cap2 = captureOut();
    exit = await runInit(
      { yes: true, reconfigure: false, cwd: root, skipOauth: true, help: false },
      { stdout: cap2.stdout, stderr: cap2.stderr },
    );
    assert.equal(exit, 0);

    const after = fs.readFileSync(cfgPath, "utf8");
    assert.equal(after, before, "second init without --reconfigure must NOT touch .conclaverc.json");

    // The output should advertise the "skip" path.
    assert.match(cap2.text(), /skip|exists/i);
  } finally {
    cleanup(root);
  }
});

test("B.1: --reconfigure overwrites the config file cleanly", async () => {
  const root = freshGitRepo();
  try {
    let exit = await runInit(
      { yes: true, reconfigure: false, cwd: root, skipOauth: true, help: false },
      { stdout: () => {}, stderr: () => {} },
    );
    assert.equal(exit, 0);

    // Hand-edit the config so we can prove --reconfigure replaces it.
    const cfgPath = path.join(root, ".conclaverc.json");
    const json = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    json.__hand_edited = true;
    fs.writeFileSync(cfgPath, JSON.stringify(json, null, 2), "utf8");

    exit = await runInit(
      { yes: true, reconfigure: true, cwd: root, skipOauth: true, help: false },
      { stdout: () => {}, stderr: () => {} },
    );
    assert.equal(exit, 0);

    const reread = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    assert.equal(reread.__hand_edited, undefined, "--reconfigure must overwrite, not merge");
  } finally {
    cleanup(root);
  }
});

test("B.1: invalid (no remote) repo → exits non-zero with actionable error", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aic-b1-init-norem-"));
  try {
    execSync("git init -q", { cwd: root });
    // No remote add — detectRepo should fail.
    const cap = captureOut();
    const exit = await runInit(
      { yes: true, reconfigure: false, cwd: root, skipOauth: true, help: false },
      { stdout: cap.stdout, stderr: cap.stderr },
    );
    assert.equal(exit, 1, "no-remote → non-zero exit");
    assert.match(cap.text(), /repo|remote/i);
  } finally {
    cleanup(root);
  }
});

test("B.1: --repo override bypasses git remote detection", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aic-b1-init-explicit-"));
  try {
    execSync("git init -q", { cwd: root });
    // No remote, but --repo provided.
    const cap = captureOut();
    const exit = await runInit(
      { yes: true, reconfigure: false, cwd: root, skipOauth: true, help: false, repo: "owner/explicit" },
      { stdout: cap.stdout, stderr: cap.stderr },
    );
    assert.equal(exit, 0, `init with --repo failed:\n${cap.text()}`);
    assert.match(cap.text(), /owner\/explicit/);
  } finally {
    cleanup(root);
  }
});
