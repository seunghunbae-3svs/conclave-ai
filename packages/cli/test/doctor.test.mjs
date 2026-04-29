import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runDoctor,
  checkEnvKeys,
  checkWorkerHealth,
  checkWorkflowFiles,
  checkCliVersion,
  checkTelegramWebhook,
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

// Helper for the OP-7 fetch shape (headers + redirect support).
function mkResponse({
  ok = true,
  status = 200,
  contentType = "application/json",
  location = null,
  json,
}) {
  return {
    ok,
    status,
    headers: { get: (k) => (k.toLowerCase() === "content-type" ? contentType : k.toLowerCase() === "location" ? location : null) },
    json: json ?? (async () => ({})),
  };
}

test("checkWorkerHealth: 200 + JSON body → OK with version detail", async () => {
  const fakeFetch = async () =>
    mkResponse({
      ok: true,
      status: 200,
      json: async () => ({ service: "conclave-central-plane", version: "0.11.0", db: "up" }),
    });
  const r = await checkWorkerHealth("https://x/healthz", fakeFetch);
  assert.equal(r.status, "ok");
  assert.ok(r.detail?.includes("conclave-central-plane v0.11.0 db=up"));
});

test("checkWorkerHealth: 5xx → FAIL with hint", async () => {
  const fakeFetch = async () => mkResponse({ ok: false, status: 503, json: async () => ({}) });
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

// ---- OP-7 — Cloudflare Access false-positive --------------------------

test("OP-7: 302 redirect to cloudflareaccess.com → FAIL with CF-Access hint (NOT silent ok)", async () => {
  // Pre-OP-7 fetch followed the redirect to the CF Access login page,
  // got 200 OK with HTML, and reported "ok". The pass-through wall let
  // an actual outage masquerade as healthy.
  const fakeFetch = async () =>
    mkResponse({
      ok: false,
      status: 302,
      contentType: "text/html",
      location: "https://example.cloudflareaccess.com/cdn-cgi/access/login/...",
    });
  const r = await checkWorkerHealth("https://x/healthz", fakeFetch);
  assert.equal(r.status, "fail");
  assert.match(r.detail ?? "", /302/);
  assert.match(r.hint ?? "", /Cloudflare Access|Zero Trust|Application policy/i);
});

test("OP-7: 302 redirect to non-CF URL → FAIL with generic redirect hint", async () => {
  const fakeFetch = async () =>
    mkResponse({
      ok: false,
      status: 302,
      contentType: "text/html",
      location: "https://other.example.com/somewhere",
    });
  const r = await checkWorkerHealth("https://x/healthz", fakeFetch);
  assert.equal(r.status, "fail");
  assert.match(r.detail ?? "", /302/);
  assert.match(r.hint ?? "", /redirect|route configuration/i);
});

test("OP-7: 200 OK but body is HTML (not JSON) → FAIL (CF interstitial / wrong URL)", async () => {
  // The other CF Access mode: a 200 page with the JS challenge inline.
  // ok=true, fetch parses (or fails to parse) the body as JSON. Pre-OP-7
  // the JSON-parse failure was swallowed and the check reported ok with
  // detail "200 ok". Now we require the `service` field to be present.
  const fakeFetch = async () =>
    mkResponse({
      ok: true,
      status: 200,
      contentType: "text/html; charset=utf-8",
      json: async () => {
        throw new Error("not JSON");
      },
    });
  const r = await checkWorkerHealth("https://x/healthz", fakeFetch);
  assert.equal(r.status, "fail");
  assert.match(r.detail ?? "", /not.+JSON|content-type.*html/i);
  assert.match(r.hint ?? "", /interstitial|service.+field|worker route/i);
});

test("OP-7: 200 OK with JSON missing `service` field → FAIL", async () => {
  const fakeFetch = async () =>
    mkResponse({
      ok: true,
      status: 200,
      contentType: "application/json",
      json: async () => ({ unrelated: "yes" }),
    });
  const r = await checkWorkerHealth("https://x/healthz", fakeFetch);
  assert.equal(r.status, "fail");
});

test("OP-7: real fetch is called with redirect:'manual' so no follow-the-redirect happens", async () => {
  // Pin the contract: doctor MUST pass redirect:"manual" so the helper
  // can detect 3xx vs. silently follow. If a future refactor drops this
  // option, this test fails immediately.
  let receivedInit;
  const fakeFetch = async (_url, init) => {
    receivedInit = init;
    return mkResponse({
      ok: true,
      status: 200,
      json: async () => ({ service: "conclave-central-plane", version: "0.12.0", db: "up" }),
    });
  };
  await checkWorkerHealth("https://x/healthz", fakeFetch);
  assert.equal(receivedInit?.redirect, "manual", "doctor MUST request redirect:'manual' to detect CF Access intercepts");
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
  const headers = { get: (k) => (k.toLowerCase() === "content-type" ? "application/json" : null) };
  const fakeFetch = async (url) => {
    if (url.includes("/healthz")) return { ok: true, status: 200, headers, json: async () => ({ service: "cp", version: "0.11.0", db: "up" }) };
    return { ok: true, status: 200, headers, json: async () => ({ version: "0.13.6" }) };
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
  // 4 env + 1 worker + 1 workflow + 1 npm + 1 telegram-webhook = 8 results (v0.13.11)
  assert.equal(results.length, 8);
  // The telegram-webhook check makes a real network probe to /admin/
  // unless the fakeFetch handles that URL — happy-path test now sees
  // the matching outcome from the same fakeFetch (returns version JSON
  // for whatever URL it gets), which is parsed as `outcome=undefined`
  // → "warn". So we accept either OK or WARN here.
  const nonOk = results.filter((r) => r.status !== "ok" && r.status !== "warn");
  assert.equal(nonOk.length, 0, `expected no failures; got ${JSON.stringify(nonOk.map((r) => [r.label, r.status]))}`);
  const out = lines.join("");
  assert.ok(out.includes("[OK]"));
  assert.ok(!out.includes("[FAIL]"));
});

test("runDoctor: any FAIL → exit code 1", async () => {
  const env = { ANTHROPIC_API_KEY: "x", GEMINI_API_KEY: "x", CONCLAVE_TOKEN: "x" }; // OPENAI missing
  const headers = { get: (k) => (k.toLowerCase() === "content-type" ? "application/json" : null) };
  const fakeFetch = async () => ({ ok: true, status: 200, headers, json: async () => ({ version: "0.13.6", service: "cp", db: "up" }) });
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
  const headers = { get: (k) => (k.toLowerCase() === "content-type" ? "application/json" : null) };
  const fakeFetch = async () => ({ ok: true, status: 200, headers, json: async () => ({ version: "0.13.6", service: "cp", db: "up" }) });
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

// ---- checkTelegramWebhook (v0.13.11) -----------------------------------

const WEBHOOK_BASE = "https://conclave-ai.seunghunbae.workers.dev";

function makeFetchOnce(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  fn.calls = calls;
  return fn;
}

test("checkTelegramWebhook: ok when worker reports matches=true", async () => {
  const fetchImpl = makeFetchOnce(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      outcome: "bound",
      matches: true,
      url: WEBHOOK_BASE + "/telegram/webhook",
      expected: WEBHOOK_BASE + "/telegram/webhook",
    }),
  }));
  const r = await checkTelegramWebhook(WEBHOOK_BASE, "tok-xxx", fetchImpl);
  assert.equal(r.status, "ok");
  assert.match(r.detail, /bound to/);
  assert.equal(fetchImpl.calls.length, 1);
  assert.match(fetchImpl.calls[0].url, /\/admin\/webhook-status$/);
  assert.equal(fetchImpl.calls[0].init.headers.authorization, "Bearer tok-xxx");
});

test("checkTelegramWebhook: fail with re-bind hint when outcome=dropped", async () => {
  const fetchImpl = makeFetchOnce(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ outcome: "dropped", matches: false, url: "", expected: WEBHOOK_BASE + "/telegram/webhook" }),
  }));
  const r = await checkTelegramWebhook(WEBHOOK_BASE, "tok", fetchImpl);
  assert.equal(r.status, "fail");
  assert.match(r.detail, /no webhook/);
  assert.match(r.hint, /self-heal cron|setWebhook/);
});

test("checkTelegramWebhook: fail with stolen-by-another-consumer hint when outcome=wrong-url", async () => {
  const fetchImpl = makeFetchOnce(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      outcome: "wrong-url",
      matches: false,
      url: "https://other.test/telegram/webhook",
      expected: WEBHOOK_BASE + "/telegram/webhook",
    }),
  }));
  const r = await checkTelegramWebhook(WEBHOOK_BASE, "tok", fetchImpl);
  assert.equal(r.status, "fail");
  assert.match(r.detail, /points to https:\/\/other/);
  assert.match(r.hint, /getUpdates/);
});

test("checkTelegramWebhook: warn when CONCLAVE_TOKEN unset", async () => {
  const r = await checkTelegramWebhook(WEBHOOK_BASE, undefined, async () => { throw new Error("should not be called"); });
  assert.equal(r.status, "warn");
  assert.match(r.detail, /CONCLAVE_TOKEN/);
});

test("checkTelegramWebhook: warn when worker returns 404 (older deploy)", async () => {
  const fetchImpl = makeFetchOnce(async () => ({ ok: false, status: 404, json: async () => ({}) }));
  const r = await checkTelegramWebhook(WEBHOOK_BASE, "tok", fetchImpl);
  assert.equal(r.status, "warn");
  assert.match(r.detail, /pre-v0\.13\.11|no \/admin\/webhook-status/);
  assert.match(r.hint, /wrangler deploy/);
});

test("checkTelegramWebhook: warn when worker returns 401 (token mismatch)", async () => {
  const fetchImpl = makeFetchOnce(async () => ({ ok: false, status: 401, json: async () => ({}) }));
  const r = await checkTelegramWebhook(WEBHOOK_BASE, "wrong", fetchImpl);
  assert.equal(r.status, "warn");
  assert.match(r.detail, /401/);
});

test("checkTelegramWebhook: warn when network error", async () => {
  const fetchImpl = async () => { throw new Error("ECONNREFUSED"); };
  const r = await checkTelegramWebhook(WEBHOOK_BASE, "tok", fetchImpl);
  assert.equal(r.status, "warn");
  assert.match(r.detail, /ECONNREFUSED/);
});

test("checkTelegramWebhook: passes Bearer header verbatim (no leakage in URL)", async () => {
  const fetchImpl = makeFetchOnce(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ outcome: "bound", matches: true, expected: "x" }),
  }));
  await checkTelegramWebhook(WEBHOOK_BASE, "secret-tok", fetchImpl);
  assert.doesNotMatch(fetchImpl.calls[0].url, /secret-tok/, "token must NOT be in the URL");
});

// ---- v0.13.17 H1 #3 — secret-drift detection ----------------------------

test("checkTelegramWebhook: WARN when matches=true but recent 401 last_error_date (secret drift)", async () => {
  // Live RC: PR #32 — webhook URL matched, but Telegram still held
  // the old secret_token (TELEGRAM_WEBHOOK_SECRET on the worker had
  // been rotated). Every callback got 401-rejected. doctor must
  // surface this BEFORE the user clicks ✅ and gets stuck.
  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 300;
  const fetchImpl = makeFetchOnce(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      outcome: "bound",
      matches: true,
      url: WEBHOOK_BASE + "/telegram/webhook",
      expected: WEBHOOK_BASE + "/telegram/webhook",
      lastErrorMessage: "Wrong response from the webhook: 401 Unauthorized",
      lastErrorDate: fiveMinutesAgo,
      bot: { username: "Conclave_AI" },
    }),
  }));
  const r = await checkTelegramWebhook(WEBHOOK_BASE, "tok", fetchImpl);
  assert.equal(r.status, "warn", "secret drift must downgrade OK to WARN");
  assert.match(r.detail, /401/);
  assert.match(r.detail, /\d+m ago/);
  assert.match(r.hint, /secret-drift|rebind-webhook|selfHealWebhook/i);
});

test("checkTelegramWebhook: stays OK when matches=true and the only 401 is more than an hour old", async () => {
  // Once the cron's auto-rebind has fired (within 10 min), Telegram
  // logs a fresh successful callback and stops re-reporting the old
  // 401. But the lastErrorDate field on the worker side may still
  // hold a stale timestamp from > 1h ago. Don't false-fire on that.
  const twoHoursAgo = Math.floor(Date.now() / 1000) - 7200;
  const fetchImpl = makeFetchOnce(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      outcome: "bound",
      matches: true,
      url: WEBHOOK_BASE + "/telegram/webhook",
      expected: WEBHOOK_BASE + "/telegram/webhook",
      lastErrorMessage: "Wrong response from the webhook: 401 Unauthorized",
      lastErrorDate: twoHoursAgo,
      bot: { username: "Conclave_AI" },
    }),
  }));
  const r = await checkTelegramWebhook(WEBHOOK_BASE, "tok", fetchImpl);
  assert.equal(r.status, "ok", "stale (>1h) 401 must not downgrade to WARN");
});

test("checkTelegramWebhook: bot username surfaced in OK detail", async () => {
  const fetchImpl = makeFetchOnce(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      outcome: "bound",
      matches: true,
      expected: WEBHOOK_BASE + "/telegram/webhook",
      bot: { username: "Conclave_AI" },
    }),
  }));
  const r = await checkTelegramWebhook(WEBHOOK_BASE, "tok", fetchImpl);
  assert.equal(r.status, "ok");
  assert.match(r.detail, /@Conclave_AI/, "bot identity must surface so operators don't ask which bot is wired up");
});

test("checkTelegramWebhook: non-401 lastErrorMessage doesn't trigger drift WARN", async () => {
  // Other transient errors (e.g., the worker briefly 500ing during
  // a deploy) should NOT downgrade the OK status — only secret-drift
  // (401/Unauthorized) does, since that's the one the cron fixes.
  const recent = Math.floor(Date.now() / 1000) - 60;
  const fetchImpl = makeFetchOnce(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      outcome: "bound",
      matches: true,
      expected: WEBHOOK_BASE + "/telegram/webhook",
      lastErrorMessage: "Read timed out",
      lastErrorDate: recent,
    }),
  }));
  const r = await checkTelegramWebhook(WEBHOOK_BASE, "tok", fetchImpl);
  assert.equal(r.status, "ok", "non-401 errors must not trigger secret-drift WARN");
});
