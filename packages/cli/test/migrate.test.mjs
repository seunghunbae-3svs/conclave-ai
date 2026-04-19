import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseMigrateArgs,
  detectLegacy,
  findLegacyUpwards,
  buildPlan,
  applyPlan,
} from "../dist/commands/migrate.js";

function mkLegacyRoot({ withCatalog = true, withTiers = true, withTracked = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aic-legacy-"));
  if (withCatalog) {
    fs.writeFileSync(
      path.join(dir, "failure-catalog.json"),
      JSON.stringify({
        version: 1,
        updated_at: "2026-04-13",
        items: [
          { id: "ERR-001", category: "build", pattern: "Module not found", description: "desc", fix: "fix" },
          { id: "ERR-002", category: "runtime", pattern: "PrismaClientInitializationError", description: "db", fix: "check" },
        ],
      }),
    );
  }
  if (withTiers) {
    fs.writeFileSync(path.join(dir, "tiers.json"), JSON.stringify({ tiers: { base: {}, pro: {} } }));
  }
  if (withTracked) {
    fs.mkdirSync(path.join(dir, ".solo-cto"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".solo-cto", "tracked.json"),
      JSON.stringify({ selected: ["acme/my-app", "acme/other"] }),
    );
  }
  return dir;
}

function mkCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aic-cwd-"));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test("parseMigrateArgs: flags + --from value", () => {
  assert.deepEqual(parseMigrateArgs(["--help"]), { dryRun: false, help: true });
  assert.deepEqual(parseMigrateArgs(["--dry-run"]), { dryRun: true, help: false });
  assert.deepEqual(parseMigrateArgs(["--from", "/x/y"]), { dryRun: false, help: false, from: "/x/y" });
  assert.deepEqual(parseMigrateArgs(["--from", "/a", "--dry-run"]), { dryRun: true, help: false, from: "/a" });
});

test("detectLegacy: returns paths when catalog + tiers present", async () => {
  const root = mkLegacyRoot();
  try {
    const out = await detectLegacy(root);
    assert.ok(out);
    assert.equal(out.root, path.resolve(root));
    assert.ok(out.failureCatalogPath?.endsWith("failure-catalog.json"));
    assert.ok(out.tiersPath?.endsWith("tiers.json"));
    assert.equal(out.trackedReposPath, null);
  } finally {
    cleanup(root);
  }
});

test("detectLegacy: returns null when neither catalog nor tiers present", async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "aic-empty-"));
  try {
    const out = await detectLegacy(empty);
    assert.equal(out, null);
  } finally {
    cleanup(empty);
  }
});

test("detectLegacy: surfaces tracked.json when present", async () => {
  const root = mkLegacyRoot({ withTracked: true });
  try {
    const out = await detectLegacy(root);
    assert.ok(out.trackedReposPath);
  } finally {
    cleanup(root);
  }
});

test("findLegacyUpwards: finds sibling solo-cto-agent folder", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "aic-parent-"));
  const sibling = path.join(parent, "solo-cto-agent");
  fs.mkdirSync(sibling);
  fs.writeFileSync(
    path.join(sibling, "failure-catalog.json"),
    JSON.stringify({ version: 1, updated_at: "2026-04-13", items: [] }),
  );
  try {
    const out = await findLegacyUpwards(parent);
    assert.ok(out);
    assert.equal(path.basename(out.root), "solo-cto-agent");
  } finally {
    cleanup(parent);
  }
});

test("findLegacyUpwards: returns null when nothing in the tree", async () => {
  const iso = fs.mkdtempSync(path.join(os.tmpdir(), "aic-iso-"));
  try {
    const out = await findLegacyUpwards(iso);
    assert.equal(out, null);
  } finally {
    cleanup(iso);
  }
});

test("buildPlan: willWriteConfig true when .conclaverc.json absent", async () => {
  const legacyDir = mkLegacyRoot();
  const cwd = mkCwd();
  try {
    const legacy = await detectLegacy(legacyDir);
    const plan = await buildPlan(legacy, cwd);
    assert.equal(plan.willWriteConfig, true);
    assert.equal(plan.willSeedFailures, true);
    assert.ok(plan.configTargetPath.endsWith(".conclaverc.json"));
  } finally {
    cleanup(legacyDir);
    cleanup(cwd);
  }
});

test("buildPlan: willWriteConfig false when .conclaverc.json already exists", async () => {
  const legacyDir = mkLegacyRoot();
  const cwd = mkCwd();
  fs.writeFileSync(path.join(cwd, ".conclaverc.json"), JSON.stringify({ version: 1 }));
  try {
    const legacy = await detectLegacy(legacyDir);
    const plan = await buildPlan(legacy, cwd);
    assert.equal(plan.willWriteConfig, false);
  } finally {
    cleanup(legacyDir);
    cleanup(cwd);
  }
});

test("buildPlan: surfaces trackedRepoNames from .solo-cto/tracked.json", async () => {
  const legacyDir = mkLegacyRoot({ withTracked: true });
  const cwd = mkCwd();
  try {
    const legacy = await detectLegacy(legacyDir);
    const plan = await buildPlan(legacy, cwd);
    assert.deepEqual(plan.trackedRepoNames, ["acme/my-app", "acme/other"]);
  } finally {
    cleanup(legacyDir);
    cleanup(cwd);
  }
});

test("applyPlan: writes .conclaverc.json + seeds failures + returns counts", async () => {
  const legacyDir = mkLegacyRoot();
  const cwd = mkCwd();
  try {
    const legacy = await detectLegacy(legacyDir);
    const plan = await buildPlan(legacy, cwd);
    const result = await applyPlan(plan, cwd);
    assert.equal(result.wroteConfig, true);
    assert.equal(result.seeded, 2); // two items in fixture catalog
    assert.ok(fs.existsSync(path.join(cwd, ".conclaverc.json")));
    // failures landed under the memory root
    const codeDir = path.join(cwd, ".conclave", "failure-catalog", "code");
    assert.ok(fs.existsSync(codeDir));
    const files = fs.readdirSync(codeDir).filter((f) => f.endsWith(".json"));
    assert.equal(files.length, 2);
  } finally {
    cleanup(legacyDir);
    cleanup(cwd);
  }
});

test("applyPlan: skips config write when one already exists", async () => {
  const legacyDir = mkLegacyRoot();
  const cwd = mkCwd();
  const existing = JSON.stringify({ version: 1, agents: ["claude"], budget: { perPrUsd: 0.25 } });
  fs.writeFileSync(path.join(cwd, ".conclaverc.json"), existing);
  try {
    const legacy = await detectLegacy(legacyDir);
    const plan = await buildPlan(legacy, cwd);
    const result = await applyPlan(plan, cwd);
    assert.equal(result.wroteConfig, false);
    // Original content should not have been overwritten
    const after = fs.readFileSync(path.join(cwd, ".conclaverc.json"), "utf8");
    assert.equal(after, existing);
  } finally {
    cleanup(legacyDir);
    cleanup(cwd);
  }
});

test("applyPlan: no failure catalog in legacy → seeded count is 0", async () => {
  const legacyDir = mkLegacyRoot({ withCatalog: false, withTiers: true });
  const cwd = mkCwd();
  try {
    const legacy = await detectLegacy(legacyDir);
    const plan = await buildPlan(legacy, cwd);
    const result = await applyPlan(plan, cwd);
    assert.equal(result.seeded, 0);
    assert.equal(plan.willSeedFailures, false);
  } finally {
    cleanup(legacyDir);
    cleanup(cwd);
  }
});
