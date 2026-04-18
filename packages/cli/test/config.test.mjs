import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_CONFIG,
  CONFIG_FILENAME,
  loadConfig,
  resolveMemoryRoot,
} from "../dist/lib/config.js";

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

test("loadConfig: returns DEFAULT_CONFIG when no file is found", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aic-cli-cfg-"));
  try {
    const { config, found } = await loadConfig(dir);
    assert.equal(found, false);
    assert.deepEqual(config, DEFAULT_CONFIG);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig: reads + validates a real config file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aic-cli-cfg-"));
  try {
    fs.writeFileSync(
      path.join(dir, CONFIG_FILENAME),
      JSON.stringify({
        version: 1,
        agents: ["claude"],
        budget: { perPrUsd: 0.25 },
        efficiency: { cacheEnabled: true, compactEnabled: true },
        memory: { answerKeysDir: "a", failureCatalogDir: "b" },
      }),
    );
    const { config, configDir, found } = await loadConfig(dir);
    assert.equal(found, true);
    assert.equal(configDir, dir);
    assert.equal(config.budget.perPrUsd, 0.25);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig: walks up to ancestor directory", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aic-cli-cfg-"));
  try {
    fs.writeFileSync(
      path.join(root, CONFIG_FILENAME),
      JSON.stringify({ version: 1 }),
    );
    const nested = path.join(root, "a", "b", "c");
    mkdirp(nested);
    const { config, configDir, found } = await loadConfig(nested);
    assert.equal(found, true);
    assert.equal(configDir, root);
    assert.equal(config.version, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig: malformed JSON throws", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aic-cli-cfg-"));
  try {
    fs.writeFileSync(path.join(dir, CONFIG_FILENAME), "not json");
    await assert.rejects(() => loadConfig(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig: schema-invalid config (negative budget) throws", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aic-cli-cfg-"));
  try {
    fs.writeFileSync(
      path.join(dir, CONFIG_FILENAME),
      JSON.stringify({ version: 1, budget: { perPrUsd: -1 } }),
    );
    await assert.rejects(() => loadConfig(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveMemoryRoot: relative path becomes absolute under configDir", () => {
  const root = resolveMemoryRoot({ ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, root: "sub/mem" } }, "/tmp/cfg");
  assert.ok(root.endsWith("sub/mem") || root.endsWith("sub\\mem"));
});

test("resolveMemoryRoot: absolute path passes through", () => {
  const abs = path.resolve("/tmp/custom-mem");
  const root = resolveMemoryRoot({ ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, root: abs } }, "/other/dir");
  assert.equal(root, abs);
});
