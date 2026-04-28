import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileSystemCalibrationStore } from "../dist/index.js";

function freshStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aic-cal-"));
  return { store: new FileSystemCalibrationStore({ root }), root };
}
function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

test("calibration: load returns empty Map when file missing", async () => {
  const { store, root } = freshStore();
  try {
    const map = await store.load("acme/app", "code");
    assert.equal(map.size, 0);
  } finally {
    cleanup(root);
  }
});

test("calibration: recordOverride creates and increments", async () => {
  const { store, root } = freshStore();
  try {
    const a = await store.recordOverride({ repo: "acme/app", domain: "code", category: "debug-noise" });
    assert.equal(a.overrideCount, 1);
    const b = await store.recordOverride({ repo: "acme/app", domain: "code", category: "debug-noise" });
    assert.equal(b.overrideCount, 2);
    const c = await store.recordOverride({ repo: "acme/app", domain: "code", category: "debug-noise" });
    assert.equal(c.overrideCount, 3);
  } finally {
    cleanup(root);
  }
});

test("calibration: separate categories tracked independently", async () => {
  const { store, root } = freshStore();
  try {
    await store.recordOverride({ repo: "acme/app", domain: "code", category: "debug-noise" });
    await store.recordOverride({ repo: "acme/app", domain: "code", category: "missing-test" });
    const map = await store.load("acme/app", "code");
    assert.equal(map.get("debug-noise").overrideCount, 1);
    assert.equal(map.get("missing-test").overrideCount, 1);
  } finally {
    cleanup(root);
  }
});

test("calibration: separate repos tracked independently", async () => {
  const { store, root } = freshStore();
  try {
    await store.recordOverride({ repo: "acme/app", domain: "code", category: "x" });
    await store.recordOverride({ repo: "other/y", domain: "code", category: "x" });
    const acme = await store.load("acme/app", "code");
    const other = await store.load("other/y", "code");
    assert.equal(acme.get("x").overrideCount, 1);
    assert.equal(other.get("x").overrideCount, 1);
  } finally {
    cleanup(root);
  }
});

test("calibration: domain isolation (code vs design)", async () => {
  const { store, root } = freshStore();
  try {
    await store.recordOverride({ repo: "acme/app", domain: "code", category: "x" });
    const codeMap = await store.load("acme/app", "code");
    const designMap = await store.load("acme/app", "design");
    assert.equal(codeMap.get("x").overrideCount, 1);
    assert.equal(designMap.size, 0);
  } finally {
    cleanup(root);
  }
});

test("calibration: episodicId is captured on each override", async () => {
  const { store, root } = freshStore();
  try {
    const e = await store.recordOverride({
      repo: "acme/app",
      domain: "code",
      category: "x",
      episodicId: "ep-123",
    });
    assert.equal(e.lastSampleEpisodicId, "ep-123");
  } finally {
    cleanup(root);
  }
});

test("calibration: malformed file → fresh load returns empty", async () => {
  const { store, root } = freshStore();
  try {
    const filePath = path.join(root, "calibration", "code", "acme__app.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "this is not json", "utf8");
    const map = await store.load("acme/app", "code");
    assert.equal(map.size, 0);
  } finally {
    cleanup(root);
  }
});

test("calibration: listAll returns full snapshot", async () => {
  const { store, root } = freshStore();
  try {
    await store.recordOverride({ repo: "acme/app", domain: "code", category: "a" });
    await store.recordOverride({ repo: "acme/app", domain: "code", category: "b" });
    await store.recordOverride({ repo: "acme/app", domain: "code", category: "b" });
    const all = await store.listAll("acme/app", "code");
    const counts = Object.fromEntries(all.map((e) => [e.category, e.overrideCount]));
    assert.deepEqual(counts, { a: 1, b: 2 });
  } finally {
    cleanup(root);
  }
});
