/**
 * Phase B.6 — `conclave doctor` UX from a new user's perspective.
 *
 * A fresh install will be PARTIALLY configured most of the time —
 * one API key set but not all, no CONCLAVE_TOKEN yet, workflows
 * missing or stale, etc. doctor's job is to tell the user
 * EXACTLY what to do, not "FAIL: something."
 *
 * Verifies:
 *   - Empty env → 4 [FAIL] lines, each with an actionable hint
 *     mentioning which env var or command to run.
 *   - Partial env (Anthropic only) → 1 OK + 3 FAIL with hints.
 *   - All env set → 4 OK.
 *   - Worker /healthz unreachable → not a hard fail (cloud may be down)
 *     but emits a warning.
 *   - Workflows missing → fails with hint to run `conclave init`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { runDoctor } from "../dist/commands/doctor.js";
import { runInit } from "../dist/commands/init.js";

function freshGitRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aic-b6-"));
  execSync("git init -q", { cwd: root });
  execSync('git config user.email "test@test"', { cwd: root });
  execSync('git config user.name "test"', { cwd: root });
  execSync("git remote add origin https://github.com/acme/fixture-app.git", { cwd: root });
  return root;
}
function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

const fakeFetch = async () => {
  // Stub fetch — return a successful response for /healthz so unrelated
  // checks don't dominate the output we're inspecting.
  return new Response(JSON.stringify({ ok: true, version: "v0.13.24" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

const stableNpmFetch = async () => {
  return new Response(JSON.stringify({ "dist-tags": { latest: "0.13.24" } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

function captureOut() {
  const lines = [];
  return {
    sink: (s) => lines.push(s),
    text: () => lines.join(""),
  };
}

test("B.6: empty env → 4 FAIL env lines, each with actionable hint", async () => {
  const root = freshGitRepo();
  try {
    await runInit(
      { yes: true, reconfigure: false, cwd: root, skipOauth: true, help: false },
      { stdout: () => {}, stderr: () => {} },
    );
    const cap = captureOut();
    const { results } = await runDoctor([], {
      cwd: root,
      env: {}, // empty env
      fetch: fakeFetch,
      stdout: cap.sink,
      stderr: () => {},
    });
    const text = cap.text();

    // 4 env lines (Anthropic, OpenAI, Gemini, ConclaveToken).
    const envFails = results.filter((r) => r.key.startsWith("env-") && r.status === "fail");
    assert.equal(envFails.length, 4, "all 4 env keys must FAIL on empty env");

    // Every env-fail must carry a hint with a concrete next step.
    for (const r of envFails) {
      assert.ok(r.hint && r.hint.length > 0, `env fail missing hint: ${r.label}`);
      // Hint must say either "set X" or "run `conclave config`" etc.
      assert.match(r.hint, /set|conclave config/i, `unhelpful hint: ${r.hint}`);
    }

    // The printed output must include the [FAIL] tag + the hint arrow.
    assert.match(text, /\[FAIL\]/);
    assert.match(text, /↳/);
  } finally {
    cleanup(root);
  }
});

test("B.6: Anthropic only set → 1 env OK + 3 env FAIL (each FAIL still has a hint)", async () => {
  const root = freshGitRepo();
  try {
    await runInit(
      { yes: true, reconfigure: false, cwd: root, skipOauth: true, help: false },
      { stdout: () => {}, stderr: () => {} },
    );
    const cap = captureOut();
    const { results } = await runDoctor([], {
      cwd: root,
      env: { ANTHROPIC_API_KEY: "sk-test" },
      fetch: fakeFetch,
      stdout: cap.sink,
      stderr: () => {},
    });
    const envOks = results.filter((r) => r.key.startsWith("env-") && r.status === "ok");
    const envFails = results.filter((r) => r.key.startsWith("env-") && r.status === "fail");
    assert.equal(envOks.length, 1, "only Anthropic should be OK");
    assert.equal(envOks[0].key, "env-anthropic_api_key");
    assert.equal(envFails.length, 3);

    // Each FAIL still must have a hint.
    for (const r of envFails) {
      assert.ok(r.hint && r.hint.length > 0);
    }
  } finally {
    cleanup(root);
  }
});

test("B.6: GEMINI fallback to GOOGLE_API_KEY honored", async () => {
  const root = freshGitRepo();
  try {
    await runInit(
      { yes: true, reconfigure: false, cwd: root, skipOauth: true, help: false },
      { stdout: () => {}, stderr: () => {} },
    );
    const { results } = await runDoctor([], {
      cwd: root,
      env: { GOOGLE_API_KEY: "google-test" },
      fetch: fakeFetch,
      stdout: () => {},
      stderr: () => {},
    });
    const gemini = results.find((r) => r.key === "env-gemini_api_key");
    assert.equal(gemini.status, "ok", "GOOGLE_API_KEY should satisfy the Gemini check");
    assert.match(gemini.detail, /GOOGLE_API_KEY/);
  } finally {
    cleanup(root);
  }
});

test("B.6: workflows missing → workflow check FAILS with hint mentioning conclave init", async () => {
  const root = freshGitRepo();
  try {
    // Skip runInit — no workflows on disk.
    const cap = captureOut();
    const { results } = await runDoctor([], {
      cwd: root,
      env: { ANTHROPIC_API_KEY: "x", OPENAI_API_KEY: "x", GEMINI_API_KEY: "x", CONCLAVE_TOKEN: "x" },
      fetch: fakeFetch,
      stdout: cap.sink,
      stderr: () => {},
    });
    const wf = results.find((r) => r.key === "workflows" || r.label.toLowerCase().includes("workflow"));
    assert.ok(wf, "doctor must check workflow files");
    assert.notEqual(wf.status, "ok", "no workflow files → not OK");
    assert.ok(wf.hint, "workflow fail must include hint");
    assert.match(wf.hint, /conclave init|reconfigure|workflow/i, "hint must point at conclave init");
  } finally {
    cleanup(root);
  }
});

test("B.6: worker /healthz unreachable → warn or fail (not silent OK)", async () => {
  const root = freshGitRepo();
  try {
    await runInit(
      { yes: true, reconfigure: false, cwd: root, skipOauth: true, help: false },
      { stdout: () => {}, stderr: () => {} },
    );
    const failingFetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const { results } = await runDoctor([], {
      cwd: root,
      env: { ANTHROPIC_API_KEY: "x" },
      fetch: failingFetch,
      stdout: () => {},
      stderr: () => {},
    });
    const worker = results.find((r) => r.key === "worker-healthz");
    assert.ok(worker, "doctor must check worker health");
    assert.notEqual(worker.status, "ok", "unreachable worker must NOT be reported as OK");
  } finally {
    cleanup(root);
  }
});

test("B.6: outdated CLI version → warn with upgrade hint", async () => {
  const root = freshGitRepo();
  try {
    await runInit(
      { yes: true, reconfigure: false, cwd: root, skipOauth: true, help: false },
      { stdout: () => {}, stderr: () => {} },
    );
    // npm registry says latest=0.99.99 but we're on 0.13.24.
    const futureNpmFetch = async () =>
      new Response(JSON.stringify({ "dist-tags": { latest: "0.99.99" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const { results } = await runDoctor([], {
      cwd: root,
      env: { ANTHROPIC_API_KEY: "x" },
      fetch: fakeFetch,
      npmRegistryUrl: "https://stub.local",
      cliVersion: "0.13.24",
      stdout: () => {},
      stderr: () => {},
    });
    // Use the future npm registry by overriding fetch route.
    const { results: results2 } = await runDoctor([], {
      cwd: root,
      env: { ANTHROPIC_API_KEY: "x" },
      fetch: futureNpmFetch,
      npmRegistryUrl: "https://stub.local",
      cliVersion: "0.13.24",
      stdout: () => {},
      stderr: () => {},
    });
    const cliVersionCheck = results2.find((r) => r.label.toLowerCase().includes("cli") && r.label.toLowerCase().includes("version"));
    assert.ok(cliVersionCheck, "doctor must include a CLI-version check");
    assert.notEqual(cliVersionCheck.status, "ok", "outdated CLI must not be OK");
    assert.match(
      cliVersionCheck.hint || cliVersionCheck.detail || "",
      /upgrade|update|install|0\.99\.99/i,
      "outdated CLI must hint at upgrade",
    );
  } finally {
    cleanup(root);
  }
});

test("B.6: all OK env → exit code 0 + every line is OK", async () => {
  const root = freshGitRepo();
  try {
    await runInit(
      { yes: true, reconfigure: false, cwd: root, skipOauth: true, help: false },
      { stdout: () => {}, stderr: () => {} },
    );
    const { code, results } = await runDoctor([], {
      cwd: root,
      env: {
        ANTHROPIC_API_KEY: "x",
        OPENAI_API_KEY: "x",
        GEMINI_API_KEY: "x",
        CONCLAVE_TOKEN: "x",
      },
      fetch: fakeFetch,
      cliVersion: "0.13.24",
      npmRegistryUrl: "https://stub.local",
      stdout: () => {},
      stderr: () => {},
    });
    assert.equal(code, 0);
    const fails = results.filter((r) => r.status === "fail");
    assert.equal(fails.length, 0, `expected no fails; got: ${fails.map((f) => f.label).join(", ")}`);
  } finally {
    cleanup(root);
  }
});

test("B.6: doctor never crashes when env is undefined-laden (defensive shape)", async () => {
  const root = freshGitRepo();
  try {
    await runInit(
      { yes: true, reconfigure: false, cwd: root, skipOauth: true, help: false },
      { stdout: () => {}, stderr: () => {} },
    );
    // Pass weird env shape — undefineds, empty strings.
    const r = await runDoctor([], {
      cwd: root,
      env: { ANTHROPIC_API_KEY: "", OPENAI_API_KEY: undefined, CONCLAVE_TOKEN: " " },
      fetch: fakeFetch,
      stdout: () => {},
      stderr: () => {},
    });
    assert.ok(typeof r.code === "number", "doctor must always return a numeric code");
    assert.ok(Array.isArray(r.results) && r.results.length > 0);
  } finally {
    cleanup(root);
  }
});
