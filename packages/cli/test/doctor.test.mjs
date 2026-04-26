import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runDoctor,
  checkEnvKeys,
  checkWorkerHealth,
  checkWorkflowFiles,
  checkCliVersion,
  compareSemver,
} from "../dist/commands/doctor.js";

// ---- compareSemver -------------------------------------------------------

test("compareSemver: equal versions", () => {
  assert.equal(compareSemver("0.13.6", "0.13.6"), 0);
});

test("compareSemver: a < b", () => {
  assert.equal(compareSemver("0.13.6", "0.13.7"), -1);
  assert.equal(compareSemver("0.13.6", "0.14.0"), -1);
  assert.equal(compareSemver("0.13.6", "1.0.0"), -1);
});

test("compareSemver: a > b", () => {
  assert.equal(compareSemver("0.13.7", "0.13.6"), 1);
  assert.equal(compareSemver("1.0.0", "0.99.99"), 1);
});

test("compareSemver: ignores pre-release tags", () => {
  assert.equal(compareSemver("0.13.6-beta", "0.13.6"), 0);
});

// ---- checkEnvKeys --------------------------------------------------------

test("checkEnvKeys: all 4 keys present → all OK", () => {
  const env = {
    ANTHROPIC_API_KEY: "sk-ant-xxx",
    OPENAI_API_KEY: "sk-xxx",
    GEMINI_API_KEY: "g-xxx",
    CONCLAVE_TOKEN: "tok-xxx",
  };
  const out = checkEnvKeys(env);
  assert.equal(out.length, 4);
  assert.ok(out.every((r) => r.status === "ok"));
});

test("checkEnvKeys: missing OPENAI → fails for that one only", () => {
  const env = {
    ANTHROPIC_API_KEY: "sk-ant",
    GEMINI_API_KEY: "g",
    CONCLAVE_TOKEN: "t",
  };
  const out = checkEnvKeys(env);
  const failed = out.filter((r) => r.status === "fail");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].label, "env: OPENAI_API_KEY");
  assert.ok(failed[0].hint?.includes("conclave config"));
});

test("checkEnvKeys: GEMINI_API_KEY accepts GOOGLE_API_KEY fallback", () => {
  const env = {
    ANTHROPIC_API_KEY: "x",
    OPENAI_API_KEY: "x",
    GOOGLE_API_KEY: "g-fallback",
    CONCLAVE_TOKEN: "t",
  };
  const out = checkEnvKeys(env);
  const gem = out.find((r) => r.label === "env: GEMINI_API_KEY");
  assert.equal(gem.status, "ok");
  assert.ok(gem.detail?.includes("GOOGLE_API_KEY"), `detail should name fallback var; got ${gem.detail}`);
});

test("checkEnvKeys: empty-string env values are treated as missing", () => {
  const env = { ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "x", GEMINI_API_KEY: "x", CONCLAVE_TOKEN: "x" };
  const out = checkEnvKeys(env);
  const ant = out.find((r) => r.label === "env: ANTHROPIC_API_KEY");
  assert.equal(ant.status, "fail");
});

// ---- checkWorkerHealth ---------------------------------------------------

test("checkWorkerHealth: 200 + JSON body → OK with version detail", async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ service: "conclave-central-plane", version: "0.11.0", db: "up" }),
  });
  const r = await checkWorkerHealth("https://x/healthz", fakeFetch);
  assert.equal(r.status, "ok");
  assert.ok(r.detail?.includes("conclave-central-plane v0.11.0 db=up"));
});

test("checkWorkerHealth: 5xx → FAIL with hint", async () => {
  const fakeFetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  const r = await checkWorkerHealth("https://x/healthz", fakeFetch);
  assert.equal(r.status, "fail");
  assert.ok(r.detail?.includes("503"));
  assert.ok(r.hint?.includes("wrangler"));
});

test("checkWorkerHealth: network error → FAIL", async () => {
  const fakeFetch = async () => { throw new Error("ECONNREFUSED"); };
  const r = await checkWorkerHealth("https://x/healthz", fakeFetch);
  assert.equal(r.status, "fail");
  assert.ok(r.detail?.includes("ECONNREFUSED"));
});

// ---- checkWorkflowFiles --------------------------------------------------

test("checkWorkflowFiles: matching workflow with expected tag → OK", async () => {
  const r = await checkWorkflowFiles("/repo", {
    readDir: async () => ["conclave.yml"],
    readFile: async () => `name: Conclave AI\n  uses: seunghunbae-3svs/conclave-ai/.github/workflows/review.yml@v0.4\n`,
  });
  assert.equal(r.status, "ok");
  assert.ok(r.detail?.includes("@v0.4"));
});

test("checkWorkflowFiles: workflow with stale tag → WARN with bump hint", async () => {
  const r = await checkWorkflowFiles("/repo", {
    readDir: async () => ["conclave.yml"],
    readFile: async () => `uses: seunghunbae-3svs/conclave-ai/.github/workflows/review.yml@v0.3`,
  });
  assert.equal(r.status, "warn");
  assert.ok(r.detail?.includes("v0.3"));
  assert.ok(r.hint?.includes("v0.4"));
});

test("checkWorkflowFiles: no workflow references conclave-ai → WARN", async () => {
  const r = await checkWorkflowFiles("/repo", {
    readDir: async () => ["ci.yml"],
    readFile: async () => `name: CI\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest`,
  });
  assert.equal(r.status, "warn");
  assert.ok(r.detail?.includes("no workflow references"));
});

test("checkWorkflowFiles: missing .github/workflows dir → WARN", async () => {
  const r = await checkWorkflowFiles("/repo", {
    readDir: async () => { throw new Error("ENOENT"); },
  });
  assert.equal(r.status, "warn");
  assert.ok(r.detail?.includes("no workflow directory"));
});

// ---- checkCliVersion -----------------------------------------------------

test("checkCliVersion: installed === latest → OK", async () => {
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ({ version: "0.13.6" }) });
  const r = await checkCliVersion("0.13.6", "https://r/x", fakeFetch);
  assert.equal(r.status, "ok");
  assert.ok(r.detail?.includes("0.13.6"));
});

test("checkCliVersion: installed < latest → WARN with `npm i -g` hint", async () => {
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ({ version: "0.14.0" }) });
  const r = await checkCliVersion("0.13.6", "https://r/x", fakeFetch);
  assert.equal(r.status, "warn");
  assert.ok(r.detail?.includes("0.14.0"));
  assert.ok(r.hint?.includes("npm i -g @conclave-ai/cli@0.14.0"));
});

test("checkCliVersion: registry probe fails → WARN with installed version still surfaced", async () => {
  const fakeFetch = async () => { throw new Error("ETIMEDOUT"); };
  const r = await checkCliVersion("0.13.6", "https://r/x", fakeFetch);
  assert.equal(r.status, "warn");
  assert.ok(r.detail?.includes("0.13.6"));
});

test("checkCliVersion: installed > latest (dev install) → OK (don't downgrade)", async () => {
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ({ version: "0.13.6" }) });
  const r = await checkCliVersion("0.14.0-dev", "https://r/x", fakeFetch);
  assert.equal(r.status, "ok", "newer-than-latest installs should not WARN — they're often dev builds");
});

// ---- runDoctor end-to-end -----------------------------------------------

test("runDoctor: prints results + returns code 0 when no fails", async () => {
  const lines = [];
  const env = { ANTHROPIC_API_KEY: "x", OPENAI_API_KEY: "x", GEMINI_API_KEY: "x", CONCLAVE_TOKEN: "x" };
  const fakeFetch = async (url) => {
    if (url.includes("/healthz")) return { ok: true, status: 200, json: async () => ({ service: "cp", version: "0.11.0", db: "up" }) };
    return { ok: true, status: 200, json: async () => ({ version: "0.13.6" }) };
  };
  const { code, results } = await runDoctor([], {
    env,
    fetch: fakeFetch,
    readDir: async () => ["conclave.yml"],
    readFile: async () => `uses: seunghunbae-3svs/conclave-ai/.github/workflows/review.yml@v0.4`,
    cliVersion: "0.13.6",
    cwd: "/repo",
    stdout: (s) => lines.push(s),
  });
  assert.equal(code, 0);
  // 4 env + 1 worker + 1 workflow + 1 npm = 7 results
  assert.equal(results.length, 7);
  assert.ok(results.every((r) => r.status === "ok"), `expected all OK; got ${JSON.stringify(results.map((r) => [r.label, r.status]))}`);
  const out = lines.join("");
  assert.ok(out.includes("[OK]"));
  assert.ok(!out.includes("[FAIL]"));
});

test("runDoctor: any FAIL → exit code 1", async () => {
  const env = { ANTHROPIC_API_KEY: "x", GEMINI_API_KEY: "x", CONCLAVE_TOKEN: "x" }; // OPENAI missing
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ({ version: "0.13.6", service: "cp", db: "up" }) });
  const { code } = await runDoctor([], {
    env,
    fetch: fakeFetch,
    readDir: async () => [],
    cliVersion: "0.13.6",
    cwd: "/repo",
    stdout: () => {},
  });
  assert.equal(code, 1, "missing required env key must produce exit 1");
});

test("runDoctor: warns only (no fails) → exit code 0", async () => {
  const env = { ANTHROPIC_API_KEY: "x", OPENAI_API_KEY: "x", GEMINI_API_KEY: "x", CONCLAVE_TOKEN: "x" };
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ({ version: "0.13.6", service: "cp", db: "up" }) });
  const { code, results } = await runDoctor([], {
    env,
    fetch: fakeFetch,
    readDir: async () => { throw new Error("ENOENT"); },
    cliVersion: "0.13.6",
    cwd: "/repo",
    stdout: () => {},
  });
  assert.equal(code, 0, "warn-only must NOT exit 1 — doctor is informational");
  const wfWarn = results.find((r) => r.label === ".github/workflows/");
  assert.equal(wfWarn.status, "warn");
});
