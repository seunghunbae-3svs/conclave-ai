/**
 * config-command.test.mjs — CLI-level behavior of `conclave config`
 * (v0.7.4). Exercises set/get/list/unset/path/migrate plus the TUI
 * round-trip via injected prompter.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const cred = await import("../dist/lib/credentials.js");
const { config } = await import("../dist/commands/config.js");

function mkSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aic-cfgcmd-"));
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

function captureStdout(fn) {
  const chunks = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const errChunks = [];
  process.stdout.write = (c) => {
    chunks.push(String(c));
    return true;
  };
  process.stderr.write = (c) => {
    errChunks.push(String(c));
    return true;
  };
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    })
    .then(() => ({ stdout: chunks.join(""), stderr: errChunks.join("") }));
}

test("config list: empty storage shows all keys as not set", async () => {
  const sb = mkSandbox();
  const savedEnv = {};
  for (const name of [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "CONCLAVE_TOKEN",
    "XAI_API_KEY",
  ]) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
  try {
    const { stdout } = await captureStdout(() => config(["list"]));
    assert.match(stdout, /anthropic.*not set/);
    assert.match(stdout, /openai.*not set/);
    assert.match(stdout, /gemini.*not set/);
    assert.match(stdout, /conclave-token.*not set/);
    assert.match(stdout, /xai.*not set/);
  } finally {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v !== undefined) process.env[k] = v;
    }
    sb.restore();
  }
});

test("config list: stored values are masked (length + last 4)", async () => {
  const sb = mkSandbox();
  const savedEnv = {};
  for (const name of [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "CONCLAVE_TOKEN",
    "XAI_API_KEY",
  ]) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
  try {
    cred.saveCredentials({
      anthropic: "sk-ant-api03-LONGCAFE",
      openai: "sk-proj-LONGBEEF",
      gemini: "AIzaLONGDEAD",
      "conclave-token": "c_LONGFEED",
      xai: "xai-LONGFACE",
    });
    const { stdout } = await captureStdout(() => config(["list"]));
    // Ensure no full secret ever hits stdout.
    assert.ok(!stdout.includes("sk-ant-api03-LONGCAFE"));
    assert.ok(!stdout.includes("sk-proj-LONGBEEF"));
    // All five keys should show with their len= prefix + last 4.
    assert.match(stdout, /anthropic.*len=21 \.\.\.CAFE/);
    assert.match(stdout, /openai.*len=16 \.\.\.BEEF/);
    assert.match(stdout, /gemini.*len=12 \.\.\.DEAD/);
    assert.match(stdout, /conclave-token.*len=10 \.\.\.FEED/);
    assert.match(stdout, /xai.*len=12 \.\.\.FACE/);
  } finally {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v !== undefined) process.env[k] = v;
    }
    sb.restore();
  }
});

test("config set <key> <value>: programmatic set", async () => {
  const sb = mkSandbox();
  try {
    const { stdout } = await captureStdout(() =>
      config(["set", "anthropic", "sk-ant-api03-DEADBEEF"]),
    );
    assert.match(stdout, /stored/);
    // Stored value must NOT appear raw.
    assert.ok(!stdout.includes("sk-ant-api03-DEADBEEF"));
    const loaded = cred.loadCredentials();
    assert.equal(loaded.anthropic, "sk-ant-api03-DEADBEEF");
  } finally {
    sb.restore();
  }
});

test("config set <key> -: reads value from stdin", async () => {
  const sb = mkSandbox();
  try {
    const { stdout } = await captureStdout(() =>
      config(["set", "openai", "-"], {
        readStdin: async () => "sk-proj-STDINVALUE\n",
      }),
    );
    assert.match(stdout, /stored/);
    const loaded = cred.loadCredentials();
    assert.equal(loaded.openai, "sk-proj-STDINVALUE");
  } finally {
    sb.restore();
  }
});

test("config set <key> -: empty stdin throws", async () => {
  const sb = mkSandbox();
  try {
    await assert.rejects(
      () =>
        captureStdout(() =>
          config(["set", "anthropic", "-"], {
            readStdin: async () => "   \n",
          }),
        ),
      /stdin was empty/,
    );
  } finally {
    sb.restore();
  }
});

test("config get <key>: masked by default, --show-raw prints full", async () => {
  const sb = mkSandbox();
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    cred.saveCredentials({ anthropic: "sk-ant-api03-SECRETVAL" });
    const masked = await captureStdout(() => config(["get", "anthropic"]));
    assert.match(masked.stdout, /len=\d+ \.\.\.TVAL/);
    assert.ok(!masked.stdout.includes("sk-ant-api03-SECRETVAL"));
    const raw = await captureStdout(() =>
      config(["get", "anthropic", "--show-raw"]),
    );
    assert.match(raw.stdout, /sk-ant-api03-SECRETVAL/);
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    sb.restore();
  }
});

test("config unset <key>: removes stored key", async () => {
  const sb = mkSandbox();
  try {
    cred.saveCredentials({ anthropic: "sk-abc", openai: "sk-def" });
    const { stdout } = await captureStdout(() =>
      config(["unset", "anthropic"]),
    );
    assert.match(stdout, /removed/);
    const loaded = cred.loadCredentials();
    assert.equal(loaded.anthropic, undefined);
    assert.equal(loaded.openai, "sk-def");
  } finally {
    sb.restore();
  }
});

test("config path: prints storage path", async () => {
  const sb = mkSandbox();
  try {
    const { stdout } = await captureStdout(() => config(["path"]));
    const expected = cred.credentialsPath();
    assert.equal(stdout.trim(), expected);
  } finally {
    sb.restore();
  }
});

test("config migrate: imports env vars into storage", async () => {
  const sb = mkSandbox();
  try {
    const { stdout } = await captureStdout(() =>
      config(["migrate"], {
        env: {
          ANTHROPIC_API_KEY: "sk-migrated-a",
          CONCLAVE_TOKEN: "c_migrated_t",
        },
      }),
    );
    assert.match(stdout, /imported 2 key\(s\)/);
    assert.match(stdout, /anthropic \(ANTHROPIC_API_KEY\)/);
    assert.match(stdout, /conclave-token \(CONCLAVE_TOKEN\)/);
    const loaded = cred.loadCredentials();
    assert.equal(loaded.anthropic, "sk-migrated-a");
    assert.equal(loaded["conclave-token"], "c_migrated_t");
  } finally {
    sb.restore();
  }
});

test("config: unknown subcommand throws helpful error", async () => {
  const sb = mkSandbox();
  try {
    await assert.rejects(
      () => captureStdout(() => config(["bogus"])),
      /unknown subcommand/,
    );
  } finally {
    sb.restore();
  }
});

test("config (no args): interactive TUI via injected prompter", async () => {
  const sb = mkSandbox();
  try {
    // Fake prompter returns a new value for anthropic, skips everything else.
    const answers = {
      anthropic: "sk-ant-api03-FROMTUI",
      openai: "",
      gemini: "",
      "conclave-token": "",
      xai: "",
    };
    const prompterFactory = () => ({
      async ask() {
        return "";
      },
      async askSecret() {
        // Each call maps to the next key in order.
        const keys = ["anthropic", "openai", "gemini", "conclave-token", "xai"];
        const nextKey = keys[callIndex++];
        return answers[nextKey] ?? "";
      },
      async confirm() {
        return true;
      },
      close() {
        /* no-op */
      },
    });
    let callIndex = 0;
    const { stdout } = await captureStdout(() =>
      config([], { prompterFactory }),
    );
    assert.match(stdout, /1 key\(s\) stored/);
    const loaded = cred.loadCredentials();
    assert.equal(loaded.anthropic, "sk-ant-api03-FROMTUI");
    assert.equal(loaded.openai, undefined);
  } finally {
    sb.restore();
  }
});

test("config get: falls back to env var when not stored", async () => {
  const sb = mkSandbox();
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-ant-ENVFALLBACK";
  try {
    const { stdout } = await captureStdout(() =>
      config(["get", "anthropic", "--show-raw"]),
    );
    assert.match(stdout, /sk-ant-ENVFALLBACK \(from env: ANTHROPIC_API_KEY\)/);
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    else delete process.env.ANTHROPIC_API_KEY;
    sb.restore();
  }
});
