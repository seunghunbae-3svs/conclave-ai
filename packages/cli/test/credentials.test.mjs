/**
 * credentials.test.mjs — covers loadCredentials, saveCredentials,
 * resolveKey, maskKey, migrateFromEnv, unsetKey, setKey,
 * hydrateEnvFromStorage (v0.7.4).
 *
 * We override HOME / USERPROFILE / XDG_CONFIG_HOME to point at a tmpdir
 * so tests never touch the real user profile. Each test resets these
 * before running.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Import AFTER we set env so credentialsDir() picks the override.
const mod = await import("../dist/lib/credentials.js");
const {
  ALL_KEY_NAMES,
  credentialsPath,
  credentialsDir,
  hydrateEnvFromStorage,
  loadCredentials,
  maskKey,
  migrateFromEnv,
  primaryEnvVar,
  resolveKey,
  saveCredentials,
  setKey,
  unsetKey,
} = mod;

function mkSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aic-creds-"));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  delete process.env.XDG_CONFIG_HOME;
  return {
    dir,
    restore() {
      if (prevHome !== undefined) process.env.HOME = prevHome;
      else delete process.env.HOME;
      if (prevUserProfile !== undefined) process.env.USERPROFILE = prevUserProfile;
      else delete process.env.USERPROFILE;
      if (prevXdg !== undefined) process.env.XDG_CONFIG_HOME = prevXdg;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("loadCredentials: returns empty object when no file exists", () => {
  const sb = mkSandbox();
  try {
    const creds = loadCredentials();
    assert.deepEqual(creds, {});
  } finally {
    sb.restore();
  }
});

test("saveCredentials + loadCredentials round-trip", () => {
  const sb = mkSandbox();
  try {
    saveCredentials({
      anthropic: "sk-ant-api03-abcdef",
      openai: "sk-proj-ghijkl",
    });
    const round = loadCredentials();
    assert.equal(round.anthropic, "sk-ant-api03-abcdef");
    assert.equal(round.openai, "sk-proj-ghijkl");
    assert.equal(round.gemini, undefined);
  } finally {
    sb.restore();
  }
});

test("resolveKey: env var wins over stored value", () => {
  const sb = mkSandbox();
  try {
    saveCredentials({ anthropic: "stored-value" });
    const fakeEnv = { ANTHROPIC_API_KEY: "env-value" };
    assert.equal(resolveKey("anthropic", { env: fakeEnv }), "env-value");
  } finally {
    sb.restore();
  }
});

test("resolveKey: falls back to stored when env is empty", () => {
  const sb = mkSandbox();
  try {
    saveCredentials({ anthropic: "stored-value" });
    const fakeEnv = {};
    assert.equal(resolveKey("anthropic", { env: fakeEnv }), "stored-value");
  } finally {
    sb.restore();
  }
});

test("resolveKey: returns undefined when neither env nor stored is set", () => {
  const sb = mkSandbox();
  try {
    const fakeEnv = {};
    assert.equal(resolveKey("anthropic", { env: fakeEnv }), undefined);
    assert.equal(resolveKey("openai", { env: fakeEnv }), undefined);
  } finally {
    sb.restore();
  }
});

test("saveCredentials: creates parent dir if missing", () => {
  const sb = mkSandbox();
  try {
    // credentialsDir resolves under sandbox HOME / USERPROFILE which we
    // just created empty — no .conclave / .config sub-tree yet.
    const dir = credentialsDir();
    assert.equal(fs.existsSync(dir), false);
    saveCredentials({ anthropic: "sk-test" });
    assert.equal(fs.existsSync(dir), true);
    assert.equal(fs.existsSync(credentialsPath()), true);
  } finally {
    sb.restore();
  }
});

test("saveCredentials: file mode is 0600 on Unix", { skip: process.platform === "win32" }, () => {
  const sb = mkSandbox();
  try {
    saveCredentials({ anthropic: "sk-test" });
    const stat = fs.statSync(credentialsPath());
    // Mask to permission bits only (strip file-type).
    const mode = stat.mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
  } finally {
    sb.restore();
  }
});

test("saveCredentials: Windows storage lands under USERPROFILE\\.conclave", { skip: process.platform !== "win32" }, () => {
  const sb = mkSandbox();
  try {
    saveCredentials({ anthropic: "sk-test" });
    const cpath = credentialsPath();
    // The file must be a descendant of USERPROFILE.
    assert.ok(
      cpath.toLowerCase().startsWith(String(process.env.USERPROFILE).toLowerCase()),
      `expected ${cpath} under ${process.env.USERPROFILE}`,
    );
    // Windows Explorer ACLs are tested via integration (icacls) — here we
    // just confirm the file exists and is readable by the current user.
    const raw = fs.readFileSync(cpath, "utf8");
    assert.ok(raw.includes("sk-test"));
  } finally {
    sb.restore();
  }
});

test("loadCredentials: malformed JSON throws clear error and doesn't wipe the file", () => {
  const sb = mkSandbox();
  try {
    const dir = credentialsDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(credentialsPath(), "{not valid json", "utf8");
    assert.throws(
      () => loadCredentials(),
      /malformed JSON/,
    );
    // File must still exist (unchanged) — critical so users can edit/fix.
    assert.equal(fs.existsSync(credentialsPath()), true);
    const raw = fs.readFileSync(credentialsPath(), "utf8");
    assert.equal(raw, "{not valid json");
  } finally {
    sb.restore();
  }
});

test("migrateFromEnv: imports set env vars into storage", () => {
  const sb = mkSandbox();
  try {
    const { imported } = migrateFromEnv({
      ANTHROPIC_API_KEY: "sk-env-a",
      OPENAI_API_KEY: "sk-env-o",
      GEMINI_API_KEY: "ai-env-g",
      CONCLAVE_TOKEN: "c_env_t",
      XAI_API_KEY: "sk-xai-x",
    });
    assert.deepEqual(
      imported.sort(),
      ["anthropic", "conclave-token", "gemini", "openai", "xai"].sort(),
    );
    const stored = loadCredentials();
    assert.equal(stored.anthropic, "sk-env-a");
    assert.equal(stored.openai, "sk-env-o");
    assert.equal(stored.gemini, "ai-env-g");
    assert.equal(stored["conclave-token"], "c_env_t");
    assert.equal(stored.xai, "sk-xai-x");
  } finally {
    sb.restore();
  }
});

test("migrateFromEnv: does not overwrite with empty env", () => {
  const sb = mkSandbox();
  try {
    saveCredentials({ anthropic: "pre-existing" });
    const { imported } = migrateFromEnv({});
    assert.deepEqual(imported, []);
    const stored = loadCredentials();
    assert.equal(stored.anthropic, "pre-existing");
  } finally {
    sb.restore();
  }
});

test("maskKey: shows length and last 4 chars", () => {
  assert.equal(maskKey("sk-ant-api03-abcd1234"), "len=21 ...1234");
  assert.equal(maskKey("abc"), "len=3 ***");
  assert.equal(maskKey(""), "(empty)");
});

test("conclave-token key maps to CONCLAVE_TOKEN env var", () => {
  const sb = mkSandbox();
  try {
    assert.equal(primaryEnvVar("conclave-token"), "CONCLAVE_TOKEN");
    saveCredentials({ "conclave-token": "c_stored" });
    assert.equal(resolveKey("conclave-token", { env: {} }), "c_stored");
    assert.equal(
      resolveKey("conclave-token", { env: { CONCLAVE_TOKEN: "c_env" } }),
      "c_env",
    );
  } finally {
    sb.restore();
  }
});

test("ALL_KEY_NAMES covers every supported key", () => {
  assert.deepEqual(
    [...ALL_KEY_NAMES].sort(),
    ["anthropic", "conclave-token", "gemini", "openai", "xai"].sort(),
  );
});

test("setKey: refuses empty value", () => {
  const sb = mkSandbox();
  try {
    assert.throws(() => setKey("anthropic", ""), /empty/i);
    assert.throws(() => setKey("anthropic", "   "), /empty/i);
  } finally {
    sb.restore();
  }
});

test("unsetKey: removes stored key and returns true", () => {
  const sb = mkSandbox();
  try {
    saveCredentials({ anthropic: "sk-a", openai: "sk-o" });
    const removed = unsetKey("anthropic");
    assert.equal(removed, true);
    const stored = loadCredentials();
    assert.equal(stored.anthropic, undefined);
    assert.equal(stored.openai, "sk-o");
    // Second call returns false (nothing left to remove).
    assert.equal(unsetKey("anthropic"), false);
  } finally {
    sb.restore();
  }
});

test("hydrateEnvFromStorage: fills missing env from storage", () => {
  const sb = mkSandbox();
  try {
    saveCredentials({ anthropic: "stored-a", openai: "stored-o" });
    const env = {};
    const populated = hydrateEnvFromStorage(env);
    assert.deepEqual(populated.sort(), ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
    assert.equal(env.ANTHROPIC_API_KEY, "stored-a");
    assert.equal(env.OPENAI_API_KEY, "stored-o");
  } finally {
    sb.restore();
  }
});

test("hydrateEnvFromStorage: does not overwrite already-set env", () => {
  const sb = mkSandbox();
  try {
    saveCredentials({ anthropic: "stored-a" });
    const env = { ANTHROPIC_API_KEY: "user-set" };
    const populated = hydrateEnvFromStorage(env);
    assert.deepEqual(populated, []);
    assert.equal(env.ANTHROPIC_API_KEY, "user-set");
  } finally {
    sb.restore();
  }
});

test("saveCredentials: preserves createdAt across updates", () => {
  const sb = mkSandbox();
  try {
    saveCredentials({ anthropic: "first" });
    const raw1 = JSON.parse(fs.readFileSync(credentialsPath(), "utf8"));
    const firstCreated = raw1.createdAt;
    // Sleep isn't needed — updatedAt still moves forward on the second write.
    saveCredentials({ anthropic: "second" });
    const raw2 = JSON.parse(fs.readFileSync(credentialsPath(), "utf8"));
    assert.equal(raw2.createdAt, firstCreated);
    assert.ok(raw2.updatedAt >= firstCreated);
    assert.equal(raw2.keys.anthropic, "second");
  } finally {
    sb.restore();
  }
});

test("resolveKey: trims whitespace from env values", () => {
  // v0.11 — explicitly inject `stored: {}` so the test stays
  // hermetic on dev machines that have ~/.conclave/credentials.json
  // populated. Without this, safeLoad() reads the local store and the
  // 'whitespace-only env is absent' branch leaks the stored value.
  assert.equal(
    resolveKey("anthropic", { env: { ANTHROPIC_API_KEY: "  sk-x  " }, stored: {} }),
    "sk-x",
  );
  // Whitespace-only env is treated as absent.
  assert.equal(
    resolveKey("anthropic", { env: { ANTHROPIC_API_KEY: "   " }, stored: {} }),
    undefined,
  );
});

test("resolveKey: GOOGLE_API_KEY works as gemini alias", () => {
  const sb = mkSandbox();
  try {
    assert.equal(
      resolveKey("gemini", { env: { GOOGLE_API_KEY: "g-x" } }),
      "g-x",
    );
    // Primary wins when both present.
    assert.equal(
      resolveKey("gemini", {
        env: { GEMINI_API_KEY: "g-primary", GOOGLE_API_KEY: "g-alias" },
      }),
      "g-primary",
    );
  } finally {
    sb.restore();
  }
});
