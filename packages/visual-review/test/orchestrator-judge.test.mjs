import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { runVisualReview } from "../dist/index.js";

function solidPng(w = 40, h = 40, c = [200, 200, 200, 255]) {
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

function tmpOut() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aic-oj-"));
}
function cleanup(d) {
  fs.rmSync(d, { recursive: true, force: true });
}

const before = solidPng(40, 40, [255, 255, 255, 255]);
const after = solidPng(40, 40, [0, 0, 0, 255]);

test("runVisualReview: judge supplied → result includes judgment", async () => {
  const outDir = tmpOut();
  try {
    const judge = {
      id: "stub-judge",
      judge: async () => ({
        category: "regression",
        confidence: 0.9,
        summary: "footer vanished",
        concerns: [{ kind: "missing-content", severity: "blocker", message: "footer gone" }],
      }),
    };
    const result = await runVisualReview({
      repo: "acme/app",
      beforeSha: "b",
      afterSha: "a",
      platforms: [
        fixedPlatform("p", { url: "https://b", provider: "p", sha: "b" }),
        fixedPlatform("p", { url: "https://a", provider: "p", sha: "a" }),
      ],
      outputDir: outDir,
      capture: stubCapture([before, after]),
      judge,
    });
    assert.ok(result.judgment);
    assert.equal(result.judgment.category, "regression");
    assert.equal(result.judgment.concerns.length, 1);
  } finally {
    cleanup(outDir);
  }
});

test("runVisualReview: no judge supplied → result has no judgment field", async () => {
  const outDir = tmpOut();
  try {
    const result = await runVisualReview({
      repo: "acme/app",
      beforeSha: "b",
      afterSha: "a",
      platforms: [
        fixedPlatform("p", { url: "https://b", provider: "p", sha: "b" }),
        fixedPlatform("p", { url: "https://a", provider: "p", sha: "a" }),
      ],
      outputDir: outDir,
      capture: stubCapture([before, after]),
    });
    assert.equal(result.judgment, undefined);
  } finally {
    cleanup(outDir);
  }
});

test("runVisualReview: judge throwing is caught; rest of result is intact", async () => {
  const outDir = tmpOut();
  const origStderr = process.stderr.write.bind(process.stderr);
  const chunks = [];
  process.stderr.write = (c) => {
    chunks.push(String(c));
    return true;
  };
  try {
    const judge = {
      id: "bad-judge",
      judge: async () => {
        throw new Error("vision api down");
      },
    };
    const result = await runVisualReview({
      repo: "acme/app",
      beforeSha: "b",
      afterSha: "a",
      platforms: [
        fixedPlatform("p", { url: "https://b", provider: "p", sha: "b" }),
        fixedPlatform("p", { url: "https://a", provider: "p", sha: "a" }),
      ],
      outputDir: outDir,
      capture: stubCapture([before, after]),
      judge,
    });
    // Judgment missing because judge threw, but severity + paths still present.
    assert.equal(result.judgment, undefined);
    assert.equal(result.severity, "total-rewrite");
    assert.ok(fs.existsSync(result.paths.diff));
  } finally {
    process.stderr.write = origStderr;
    cleanup(outDir);
  }
  assert.match(chunks.join(""), /vision api down/);
});

test("runVisualReview: judgeContext propagates to judge", async () => {
  const outDir = tmpOut();
  try {
    let capturedCtx = null;
    const judge = {
      id: "cap-judge",
      judge: async (_a, _b, ctx) => {
        capturedCtx = ctx;
        return { category: "intentional", confidence: 0.9, summary: "", concerns: [] };
      },
    };
    await runVisualReview({
      repo: "acme/app",
      beforeSha: "b",
      afterSha: "a",
      platforms: [
        fixedPlatform("p", { url: "https://b", provider: "p", sha: "b" }),
        fixedPlatform("p", { url: "https://a", provider: "p", sha: "a" }),
      ],
      outputDir: outDir,
      capture: stubCapture([before, after]),
      judge,
      judgeContext: {
        changeHint: "header redesign",
        codeReviewContext: { repo: "acme/app", pullNumber: 42, diff: "..." },
      },
    });
    assert.equal(capturedCtx.changeHint, "header redesign");
    assert.equal(capturedCtx.codeReviewContext.pullNumber, 42);
  } finally {
    cleanup(outDir);
  }
});
