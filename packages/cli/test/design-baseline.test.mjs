import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  routeToFilename,
  saveDesignBaseline,
  matchBaselinesToArtifacts,
} from "../dist/lib/design-baseline.js";

// Minimal valid PNG bytes for test fixtures.
const tinyPng = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const tinyPng2 = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0e, 0x49, 0x48, 0x44, 0x52,
]);

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "conclave-baseline-"));
}
function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- routeToFilename ---------------------------------------------------------

test("routeToFilename: '/' maps to 'root.png'", () => {
  assert.equal(routeToFilename("/"), "root.png");
});

test("routeToFilename: '/login' maps to 'login.png'", () => {
  assert.equal(routeToFilename("/login"), "login.png");
});

test("routeToFilename: '/login@mobile' preserves viewport suffix", () => {
  assert.equal(routeToFilename("/login@mobile"), "login@mobile.png");
});

test("routeToFilename: '/dashboard@desktop' preserves viewport suffix", () => {
  assert.equal(routeToFilename("/dashboard@desktop"), "dashboard@desktop.png");
});

test("routeToFilename: nested route '/a/b' uses underscore separator", () => {
  assert.equal(routeToFilename("/a/b"), "a_b.png");
});

test("routeToFilename: route without leading slash still works", () => {
  assert.equal(routeToFilename("login"), "login.png");
});

test("routeToFilename: empty string maps to 'root.png'", () => {
  assert.equal(routeToFilename(""), "root.png");
});

// ---- saveDesignBaseline ------------------------------------------------------

test("saveDesignBaseline: writes one PNG per artifact to .conclave/design/baseline/", async () => {
  const dir = freshDir();
  try {
    const artifacts = [
      { route: "/", before: tinyPng, after: tinyPng },
      { route: "/login", before: tinyPng, after: tinyPng2 },
    ];
    const { saved } = await saveDesignBaseline(dir, artifacts);
    assert.equal(saved.length, 2);
    assert.ok(saved.includes("root.png"), "root.png saved");
    assert.ok(saved.includes("login.png"), "login.png saved");

    const baselineDir = path.join(dir, ".conclave", "design", "baseline");
    const files = fs.readdirSync(baselineDir);
    assert.ok(files.includes("root.png"), "root.png exists on disk");
    assert.ok(files.includes("login.png"), "login.png exists on disk");
    // Writes the "after" buffer, not "before"
    const loginContents = fs.readFileSync(path.join(baselineDir, "login.png"));
    assert.deepEqual(loginContents, tinyPng2);
  } finally {
    cleanup(dir);
  }
});

test("saveDesignBaseline: creates baseline dir when missing", async () => {
  const dir = freshDir();
  try {
    await saveDesignBaseline(dir, [{ route: "/", before: tinyPng, after: tinyPng }]);
    const baselineDir = path.join(dir, ".conclave", "design", "baseline");
    assert.ok(fs.existsSync(baselineDir));
  } finally {
    cleanup(dir);
  }
});

test("saveDesignBaseline: overwrites existing PNG without error", async () => {
  const dir = freshDir();
  try {
    const artifacts = [{ route: "/", before: tinyPng, after: tinyPng }];
    await saveDesignBaseline(dir, artifacts);
    const artifacts2 = [{ route: "/", before: tinyPng, after: tinyPng2 }];
    await saveDesignBaseline(dir, artifacts2);
    const rootFile = path.join(dir, ".conclave", "design", "baseline", "root.png");
    const contents = fs.readFileSync(rootFile);
    assert.deepEqual(contents, tinyPng2, "second save overwrote the first");
  } finally {
    cleanup(dir);
  }
});

test("saveDesignBaseline: route with viewport suffix saved correctly", async () => {
  const dir = freshDir();
  try {
    await saveDesignBaseline(dir, [{ route: "/login@mobile", before: tinyPng, after: tinyPng2 }]);
    const baselineDir = path.join(dir, ".conclave", "design", "baseline");
    assert.ok(fs.existsSync(path.join(baselineDir, "login@mobile.png")));
  } finally {
    cleanup(dir);
  }
});

test("saveDesignBaseline: empty artifacts list → no files written, saved=[]", async () => {
  const dir = freshDir();
  try {
    const { saved } = await saveDesignBaseline(dir, []);
    assert.equal(saved.length, 0);
    // Dir may or may not be created — we only check no files
    const baselineDir = path.join(dir, ".conclave", "design", "baseline");
    if (fs.existsSync(baselineDir)) {
      assert.equal(fs.readdirSync(baselineDir).length, 0);
    }
  } finally {
    cleanup(dir);
  }
});

// ---- matchBaselinesToArtifacts -----------------------------------------------

test("matchBaselinesToArtifacts: matches route when baseline PNG exists", async () => {
  const dir = freshDir();
  try {
    // Save a baseline for "/"
    await saveDesignBaseline(dir, [{ route: "/", before: tinyPng, after: tinyPng }]);
    // Artifacts now represent a new PR review
    const artifacts = [{ route: "/", before: tinyPng2, after: tinyPng2 }];
    const matches = await matchBaselinesToArtifacts(dir, artifacts);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].route, "/");
    assert.deepEqual(matches[0].baseline, tinyPng, "baseline is the stored golden");
    assert.deepEqual(matches[0].after, tinyPng2, "after is the current PR screenshot");
  } finally {
    cleanup(dir);
  }
});

test("matchBaselinesToArtifacts: skips routes with no stored baseline (no throw)", async () => {
  const dir = freshDir();
  try {
    // Baseline only for "/login"
    await saveDesignBaseline(dir, [{ route: "/login", before: tinyPng, after: tinyPng }]);
    const artifacts = [
      { route: "/", before: tinyPng2, after: tinyPng2 },
      { route: "/login", before: tinyPng, after: tinyPng2 },
    ];
    const matches = await matchBaselinesToArtifacts(dir, artifacts);
    assert.equal(matches.length, 1, "only /login matched");
    assert.equal(matches[0].route, "/login");
  } finally {
    cleanup(dir);
  }
});

test("matchBaselinesToArtifacts: empty result when baseline dir missing", async () => {
  const dir = freshDir();
  try {
    const artifacts = [{ route: "/", before: tinyPng, after: tinyPng }];
    const matches = await matchBaselinesToArtifacts(dir, artifacts);
    assert.equal(matches.length, 0);
  } finally {
    cleanup(dir);
  }
});

test("matchBaselinesToArtifacts: multi-viewport routes matched correctly", async () => {
  const dir = freshDir();
  try {
    await saveDesignBaseline(dir, [
      { route: "/login@desktop", before: tinyPng, after: tinyPng },
      { route: "/login@mobile", before: tinyPng, after: tinyPng2 },
    ]);
    const artifacts = [
      { route: "/login@desktop", before: tinyPng2, after: tinyPng2 },
      { route: "/login@mobile", before: tinyPng2, after: tinyPng },
    ];
    const matches = await matchBaselinesToArtifacts(dir, artifacts);
    assert.equal(matches.length, 2);
    const desktopMatch = matches.find((m) => m.route === "/login@desktop");
    const mobileMatch = matches.find((m) => m.route === "/login@mobile");
    assert.ok(desktopMatch, "desktop match found");
    assert.ok(mobileMatch, "mobile match found");
    // Baseline bytes are the stored golden (tinyPng), not the current artifact
    assert.deepEqual(desktopMatch.baseline, tinyPng);
    assert.deepEqual(mobileMatch.baseline, tinyPng2);
  } finally {
    cleanup(dir);
  }
});

test("matchBaselinesToArtifacts: empty artifacts → empty matches", async () => {
  const dir = freshDir();
  try {
    await saveDesignBaseline(dir, [{ route: "/", before: tinyPng, after: tinyPng }]);
    const matches = await matchBaselinesToArtifacts(dir, []);
    assert.equal(matches.length, 0);
  } finally {
    cleanup(dir);
  }
});
