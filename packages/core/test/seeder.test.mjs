import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FileSystemMemoryStore,
  LegacyCatalogSchema,
  mapLegacyCategory,
  seedFromLegacyCatalog,
  toFailureEntry,
} from "../dist/index.js";

function freshStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aic-seed-"));
  return { store: new FileSystemMemoryStore({ root }), root };
}
function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

test("mapLegacyCategory: type error → type-error", () => {
  const e = {
    id: "ERR-009",
    category: "build",
    pattern: "Type error: Route does not match",
    description: "Next.js type mismatch",
    fix: "Update signature",
  };
  assert.equal(mapLegacyCategory(e), "type-error");
});

test("mapLegacyCategory: prisma / schema → schema-drift", () => {
  assert.equal(
    mapLegacyCategory({
      id: "x",
      category: "build",
      pattern: "prisma generate did not create",
      description: "Prisma client not generated",
      fix: "Run prisma generate",
    }),
    "schema-drift",
  );
});

test("mapLegacyCategory: timeout → performance", () => {
  assert.equal(
    mapLegacyCategory({
      id: "x",
      category: "deploy",
      pattern: "FUNCTION_INVOCATION_TIMEOUT",
      description: "Serverless function exceeded time limit",
      fix: "Investigate",
    }),
    "performance",
  );
});

test("mapLegacyCategory: unused import → dead-code", () => {
  assert.equal(
    mapLegacyCategory({
      id: "x",
      category: "build",
      pattern: "unused import lint",
      description: "ESLint flagged unused import",
      fix: "Remove the import",
    }),
    "dead-code",
  );
});

test("mapLegacyCategory: nextauth / secret → security", () => {
  assert.equal(
    mapLegacyCategory({
      id: "x",
      category: "runtime",
      pattern: "NEXTAUTH_URL is not set",
      description: "Auth env missing",
      fix: "Set NEXTAUTH_URL",
    }),
    "security",
  );
});

test("mapLegacyCategory: module not found → api-misuse", () => {
  assert.equal(
    mapLegacyCategory({
      id: "x",
      category: "build",
      pattern: "Cannot find module 'next/headers'",
      description: "Server-only import used in client component",
      fix: "Add 'use server' directive",
    }),
    "api-misuse",
  );
});

test("mapLegacyCategory: unknown falls back to other", () => {
  assert.equal(
    mapLegacyCategory({
      id: "x",
      category: "misc",
      pattern: "Something unusual",
      description: "No recognizable keywords at all here",
      fix: "Manual triage",
    }),
    "other",
  );
});

test("toFailureEntry: deterministic id (stable across calls)", () => {
  const legacy = {
    id: "ERR-001",
    category: "build",
    pattern: "Module not found",
    description: "x",
    fix: "y",
  };
  const a = toFailureEntry(legacy, { createdAt: "2026-04-19T00:00:00.000Z" });
  const b = toFailureEntry(legacy, { createdAt: "2026-04-19T00:00:00.000Z" });
  assert.equal(a.id, b.id);
  assert.match(a.id, /^fc-legacy-ERR-001-/);
});

test("toFailureEntry: tags merge legacy category + extras + defaults", () => {
  const entry = toFailureEntry(
    { id: "x", category: "runtime", pattern: "p", description: "d", fix: "f" },
    { extraTags: ["legacy", "solo-cto-agent"] },
  );
  assert.ok(entry.tags.includes("runtime"));
  assert.ok(entry.tags.includes("legacy"));
  assert.ok(entry.tags.includes("solo-cto-agent"));
});

test("toFailureEntry: body is description + 'Fix: ' + fix", () => {
  const entry = toFailureEntry({
    id: "x",
    category: "build",
    pattern: "p",
    description: "short desc",
    fix: "do the thing",
  });
  assert.match(entry.body, /short desc.*Fix: do the thing/);
});

test("LegacyCatalogSchema: accepts solo-cto-agent shape", () => {
  const parsed = LegacyCatalogSchema.parse({
    version: 1,
    updated_at: "2026-04-13",
    items: [
      { id: "ERR-001", category: "build", pattern: "p", description: "d", fix: "f" },
    ],
  });
  assert.equal(parsed.items.length, 1);
});

test("LegacyCatalogSchema: rejects wrong version", () => {
  assert.throws(() =>
    LegacyCatalogSchema.parse({
      version: 2,
      updated_at: "2026-04-13",
      items: [],
    }),
  );
});

test("seedFromLegacyCatalog: writes derived failures + returns byCategory", async () => {
  const { store, root } = freshStore();
  try {
    const raw = JSON.stringify({
      version: 1,
      updated_at: "2026-04-13",
      items: [
        { id: "ERR-A", category: "build", pattern: "Type error", description: "ts", fix: "fix" },
        { id: "ERR-B", category: "build", pattern: "prisma client", description: "schema", fix: "run" },
        { id: "ERR-C", category: "deploy", pattern: "timeout", description: "slow", fix: "bump" },
        { id: "ERR-D", category: "build", pattern: "Type error", description: "ts2", fix: "fix" },
      ],
    });
    const result = await seedFromLegacyCatalog(raw, store);
    assert.equal(result.entries.length, 4);
    assert.equal(result.byCategory["type-error"], 2);
    assert.equal(result.byCategory["schema-drift"], 1);
    assert.equal(result.byCategory["performance"], 1);
    const written = await store.listFailures();
    assert.equal(written.length, 4);
  } finally {
    cleanup(root);
  }
});

test("seedFromLegacyCatalog: { write: false } returns entries without touching store", async () => {
  const { store, root } = freshStore();
  try {
    const raw = JSON.stringify({
      version: 1,
      updated_at: "2026-04-13",
      items: [{ id: "ERR-A", category: "build", pattern: "Type error", description: "t", fix: "f" }],
    });
    const result = await seedFromLegacyCatalog(raw, store, { write: false });
    assert.equal(result.entries.length, 1);
    const written = await store.listFailures();
    assert.equal(written.length, 0);
  } finally {
    cleanup(root);
  }
});

test("seedFromLegacyCatalog: createdAt inherits YYYY-MM-DD with midnight UTC", async () => {
  const { store, root } = freshStore();
  try {
    const raw = JSON.stringify({
      version: 1,
      updated_at: "2026-04-13",
      items: [{ id: "x", category: "build", pattern: "p", description: "d", fix: "f" }],
    });
    const result = await seedFromLegacyCatalog(raw, store, { write: false });
    assert.match(result.entries[0].createdAt, /^2026-04-13T00:00:00/);
  } finally {
    cleanup(root);
  }
});

test("seedFromLegacyCatalog: bundled solo-cto-agent catalog writes 15 entries", async () => {
  const { store, root } = freshStore();
  try {
    const bundled = path.resolve(
      process.cwd(),
      "dist",
      "memory",
      "seeds",
      "solo-cto-agent-failure-catalog.json",
    );
    if (!fs.existsSync(bundled)) {
      // Run from monorepo root or per-package context — this test is a
      // smoke against the copied seed file. Skip if copy-seeds hasn't run
      // yet in this environment.
      console.log("  (skipped: bundled seed not found at " + bundled + ")");
      return;
    }
    const raw = fs.readFileSync(bundled, "utf8");
    const result = await seedFromLegacyCatalog(raw, store);
    assert.equal(result.entries.length, 15);
    // every derived entry tagged "solo-cto-agent"
    for (const e of result.entries) {
      assert.ok(e.tags.includes("solo-cto-agent"));
    }
  } finally {
    cleanup(root);
  }
});
