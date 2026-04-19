import { test } from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { PixelmatchDiff, classifyDiffRatio } from "../dist/index.js";

function solidPng(width, height, [r, g, b, a]) {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
    png.data[i + 3] = a;
  }
  return new Uint8Array(PNG.sync.write(png));
}

function halfHalfPng(width, height, colorA, colorB) {
  const png = new PNG({ width, height });
  const split = Math.floor(width / 2);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const c = x < split ? colorA : colorB;
      png.data[i] = c[0];
      png.data[i + 1] = c[1];
      png.data[i + 2] = c[2];
      png.data[i + 3] = c[3];
    }
  }
  return new Uint8Array(PNG.sync.write(png));
}

test("PixelmatchDiff: identical images → diffRatio = 0", async () => {
  const a = solidPng(40, 40, [255, 255, 255, 255]);
  const b = solidPng(40, 40, [255, 255, 255, 255]);
  const d = new PixelmatchDiff();
  const out = await d.diff(a, b);
  assert.equal(out.diffPixels, 0);
  assert.equal(out.diffRatio, 0);
  assert.equal(out.width, 40);
  assert.equal(out.height, 40);
});

test("PixelmatchDiff: completely different → diffRatio = 1", async () => {
  const a = solidPng(20, 20, [0, 0, 0, 255]);
  const b = solidPng(20, 20, [255, 255, 255, 255]);
  const d = new PixelmatchDiff();
  const out = await d.diff(a, b);
  assert.equal(out.diffRatio, 1);
});

test("PixelmatchDiff: half-half → diffRatio ≈ 0.5", async () => {
  const white = [255, 255, 255, 255];
  const black = [0, 0, 0, 255];
  const a = halfHalfPng(40, 40, white, white);
  const b = halfHalfPng(40, 40, white, black);
  const d = new PixelmatchDiff();
  const out = await d.diff(a, b);
  assert.ok(out.diffRatio > 0.45 && out.diffRatio < 0.55, `expected ~0.5, got ${out.diffRatio}`);
});

test("PixelmatchDiff: size-mismatched images pad to max dims instead of throwing", async () => {
  const small = solidPng(10, 10, [255, 255, 255, 255]);
  const big = solidPng(40, 40, [255, 255, 255, 255]);
  const d = new PixelmatchDiff();
  const out = await d.diff(small, big);
  assert.equal(out.width, 40);
  assert.equal(out.height, 40);
  // Inner 10x10 matches, outer ring (padded transparent vs white) differs
  const inner = 10 * 10;
  const total = 40 * 40;
  assert.ok(out.diffPixels >= total - inner - 1); // allow 1 px antialiasing slack
});

test("PixelmatchDiff: diff image has same dimensions as inputs", async () => {
  const a = solidPng(50, 30, [0, 0, 0, 255]);
  const b = solidPng(50, 30, [255, 255, 255, 255]);
  const d = new PixelmatchDiff();
  const out = await d.diff(a, b);
  const diffPng = PNG.sync.read(Buffer.from(out.diffPng));
  assert.equal(diffPng.width, 50);
  assert.equal(diffPng.height, 30);
});

test("PixelmatchDiff: threshold controls sensitivity", async () => {
  // Two near-identical colors: #fefefe vs #ffffff
  const a = solidPng(30, 30, [254, 254, 254, 255]);
  const b = solidPng(30, 30, [255, 255, 255, 255]);
  const d = new PixelmatchDiff();
  const strict = await d.diff(a, b, { threshold: 0.0 });
  const lenient = await d.diff(a, b, { threshold: 0.3 });
  assert.ok(strict.diffPixels >= lenient.diffPixels);
});

test("classifyDiffRatio: bands", () => {
  assert.equal(classifyDiffRatio(0), "identical");
  assert.equal(classifyDiffRatio(0.0001), "identical");
  assert.equal(classifyDiffRatio(0.005), "minor");
  assert.equal(classifyDiffRatio(0.05), "significant");
  assert.equal(classifyDiffRatio(0.25), "major");
  assert.equal(classifyDiffRatio(0.8), "total-rewrite");
});

test("classifyDiffRatio: boundary exactness", () => {
  assert.equal(classifyDiffRatio(0.0005), "minor"); // boundary of identical/minor
  assert.equal(classifyDiffRatio(0.01), "significant");
  assert.equal(classifyDiffRatio(0.10), "major");
  assert.equal(classifyDiffRatio(0.50), "total-rewrite");
});
