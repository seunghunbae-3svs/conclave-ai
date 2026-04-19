import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { runVisualReview } from "../dist/index.js";

function solidPng(w, h, c = [200, 200, 200, 255]) {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = c[0];
    png.data[i + 1] = c[1];
    png.data[i + 2] = c[2];
    png.data[i + 3] = c[3];
  }
  return new Uint8Array(PNG.sync.write(png));
}

function fixedPlatform(id, result) {
  return { id, displayName: id, resolve: async () => result };
}

function stubCapture(screenshots) {
  let i = 0;
  return {
    id: "stub",
    capture: async (url) => ({
      png: screenshots[Math.min(i++, screenshots.length - 1)],
      finalUrl: url,
      viewport: { width: 40, height: 40, deviceScaleFactor: 1 },
    }),
    close: async () => {},
  };
}

const before = solidPng(40, 40, [255, 255, 255, 255]);
const after = solidPng(40, 40, [0, 0, 0, 255]);

function freshOut() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aic-vr-"));
}
function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test("runVisualReview: happy path writes 3 PNGs + returns severity", async () => {
  const outDir = freshOut();
  try {
    const result = await runVisualReview({
      repo: "acme/app",
      beforeSha: "sha-before",
      afterSha: "sha-after",
      platforms: [
        fixedPlatform("vercel", { url: "https://before.preview", provider: "vercel", sha: "sha-before" }),
        fixedPlatform("vercel", { url: "https://after.preview", provider: "vercel", sha: "sha-after" }),
      ],
      outputDir: outDir,
      capture: stubCapture([before, after]),
    });
    assert.equal(result.severity, "total-rewrite"); // 100% different
    assert.ok(fs.existsSync(result.paths.before));
    assert.ok(fs.existsSync(result.paths.after));
    assert.ok(fs.existsSync(result.paths.diff));
    assert.equal(result.diff.diffRatio, 1);
  } finally {
    cleanup(outDir);
  }
});

test("runVisualReview: identical captures → severity = identical", async () => {
  const outDir = freshOut();
  try {
    const result = await runVisualReview({
      repo: "acme/app",
      beforeSha: "s1",
      afterSha: "s2",
      platforms: [
        fixedPlatform("vercel", { url: "https://x", provider: "vercel", sha: "s1" }),
        fixedPlatform("vercel", { url: "https://y", provider: "vercel", sha: "s2" }),
      ],
      outputDir: outDir,
      capture: stubCapture([before, before]),
    });
    assert.equal(result.severity, "identical");
    assert.equal(result.diff.diffRatio, 0);
  } finally {
    cleanup(outDir);
  }
});

test("runVisualReview: before URL not found throws with before-sha message", async () => {
  // Platform resolves per-call sha; the walker calls resolve() for each sha.
  // First call (before) returns null, second would return a URL but we never get there.
  const firstNull = fixedPlatform("noop", null);
  await assert.rejects(
    () =>
      runVisualReview({
        repo: "acme/app",
        beforeSha: "missing-before",
        afterSha: "sha-after",
        platforms: [firstNull],
        capture: stubCapture([before, after]),
      }),
    /beforeSha=missing-before/,
  );
});

test("runVisualReview: after URL not found throws with after-sha message", async () => {
  let call = 0;
  const platform = {
    id: "partial",
    displayName: "partial",
    resolve: async (input) => {
      call += 1;
      if (input.sha === "missing-after") return null;
      return { url: "https://before.preview", provider: "partial", sha: input.sha };
    },
  };
  await assert.rejects(
    () =>
      runVisualReview({
        repo: "acme/app",
        beforeSha: "sha-before",
        afterSha: "missing-after",
        platforms: [platform],
        capture: stubCapture([before, after]),
      }),
    /afterSha=missing-after/,
  );
  assert.ok(call >= 2);
});

test("runVisualReview: writes to default outputDir .conclave/visual/<afterSha>", async () => {
  const cwdBefore = process.cwd();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aic-vr-cwd-"));
  process.chdir(tmp);
  try {
    const result = await runVisualReview({
      repo: "acme/app",
      beforeSha: "b",
      afterSha: "mysha",
      platforms: [
        fixedPlatform("p", { url: "https://b", provider: "p", sha: "b" }),
        fixedPlatform("p", { url: "https://a", provider: "p", sha: "mysha" }),
      ],
      capture: stubCapture([before, before]),
    });
    assert.match(result.paths.diff, /\.conclave[\\/]+visual[\\/]+mysha[\\/]+diff\.png$/);
  } finally {
    process.chdir(cwdBefore);
    cleanup(tmp);
  }
});

test("runVisualReview: user-supplied capture is NOT closed by orchestrator", async () => {
  const outDir = freshOut();
  try {
    let closed = 0;
    const capture = {
      id: "stub",
      capture: async (url) => ({
        png: before,
        finalUrl: url,
        viewport: { width: 40, height: 40, deviceScaleFactor: 1 },
      }),
      close: async () => {
        closed += 1;
      },
    };
    await runVisualReview({
      repo: "acme/app",
      beforeSha: "a",
      afterSha: "b",
      platforms: [
        fixedPlatform("p", { url: "https://a", provider: "p", sha: "a" }),
        fixedPlatform("p", { url: "https://b", provider: "p", sha: "b" }),
      ],
      outputDir: outDir,
      capture,
    });
    assert.equal(closed, 0, "user-supplied capture should be closed by the user, not the orchestrator");
  } finally {
    cleanup(outDir);
  }
});

test("runVisualReview: result surfaces resolved preview metadata", async () => {
  const outDir = freshOut();
  try {
    const result = await runVisualReview({
      repo: "acme/app",
      beforeSha: "b-sha",
      afterSha: "a-sha",
      platforms: [
        fixedPlatform("vercel", { url: "https://b-preview", provider: "vercel", sha: "b-sha", deploymentId: "dep-b" }),
        fixedPlatform("vercel", { url: "https://a-preview", provider: "vercel", sha: "a-sha", deploymentId: "dep-a" }),
      ],
      outputDir: outDir,
      capture: stubCapture([before, after]),
    });
    assert.equal(result.before.url, "https://b-preview");
    assert.equal(result.before.deploymentId, "dep-b");
    assert.equal(result.after.url, "https://a-preview");
    assert.equal(result.after.deploymentId, "dep-a");
  } finally {
    cleanup(outDir);
  }
});
