import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaywrightCapture } from "../dist/capture.js";

/**
 * v0.13 — Playwright auto-install fallback tests.
 *
 * The default constructor wraps `import("playwright")` with a try/catch
 * that, on failure (browser binary missing OR SDK absent), runs
 * `npx playwright install chromium --with-deps` and retries the import.
 * Air-gapped CI opts out via `autoInstall: false`.
 *
 * These tests assert OPTION PLUMBING — that the new fields are wired
 * onto the instance so the production codepath has them. The wrapped
 * default factory itself is harder to test in isolation because it
 * does a real dynamic import of `playwright`; we cover the contract
 * via integration in `runVisualCapture` end-to-end smoke runs.
 */

test("PlaywrightCapture: autoInstall defaults to true", () => {
  const cap = new PlaywrightCapture();
  assert.equal(cap["autoInstall"], true);
});

test("PlaywrightCapture: autoInstall=false flag is plumbed (air-gapped CI mode)", () => {
  const cap = new PlaywrightCapture({ autoInstall: false });
  assert.equal(cap["autoInstall"], false);
});

test("PlaywrightCapture: installRunner is invoked + returns expected shape", async () => {
  let calls = 0;
  const cap = new PlaywrightCapture({
    autoInstall: true,
    log: () => {},
    installRunner: async () => {
      calls += 1;
      return { ok: false, reason: "exit code 1" };
    },
  });
  const r = await cap["installRunner"].call(cap);
  assert.equal(r.ok, false);
  assert.match(r.reason, /exit code 1/);
  assert.equal(calls, 1);
});

test("PlaywrightCapture: log sink receives stderr writes via wrapper", () => {
  let logged = "";
  const cap = new PlaywrightCapture({
    log: (m) => {
      logged += m;
    },
  });
  cap["log"]("test message");
  assert.equal(logged, "test message");
});

test("PlaywrightCapture: injected playwrightFactory bypasses the auto-install branch", async () => {
  // When the user explicitly supplies a factory, the constructor's
  // default-factory + auto-install wrapper isn't used — the supplied
  // one is invoked verbatim. Verify by counting calls.
  let factoryCalls = 0;
  const fakePlaywright = {
    chromium: { launch: async () => ({ /* fake browser */ }) },
  };
  const cap = new PlaywrightCapture({
    playwrightFactory: async () => {
      factoryCalls += 1;
      return fakePlaywright;
    },
    installRunner: async () => {
      throw new Error("install runner should NOT fire when playwrightFactory is supplied");
    },
  });
  const pw = await cap["factory"].call(cap);
  assert.equal(factoryCalls, 1);
  assert.equal(pw, fakePlaywright);
});
