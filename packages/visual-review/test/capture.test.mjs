import { test } from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { PlaywrightCapture } from "../dist/index.js";

function solidPng(width, height) {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 180;
    png.data[i + 1] = 180;
    png.data[i + 2] = 180;
    png.data[i + 3] = 255;
  }
  return new Uint8Array(PNG.sync.write(png));
}

function mockPlaywright({ navigations = [], screenshots = [] } = {}) {
  const calls = {
    launch: 0,
    newContext: [],
    goto: [],
    waitForSelector: [],
    waitForTimeout: [],
    screenshot: [],
  };
  let navI = 0;
  let shotI = 0;

  const makePage = () => ({
    goto: async (url, opts) => {
      calls.goto.push({ url, opts });
      const nav = navigations[Math.min(navI, Math.max(0, navigations.length - 1))];
      navI += 1;
      return nav ? { url: () => nav } : null;
    },
    url: () => {
      const nav = navigations[Math.max(0, navI - 1)];
      return nav ?? "";
    },
    waitForSelector: async (selector, opts) => {
      calls.waitForSelector.push({ selector, opts });
    },
    waitForTimeout: async (ms) => {
      calls.waitForTimeout.push(ms);
    },
    screenshot: async (opts) => {
      calls.screenshot.push(opts);
      const buf = screenshots[Math.min(shotI, Math.max(0, screenshots.length - 1))] ?? solidPng(40, 40);
      shotI += 1;
      return buf;
    },
    close: async () => {},
  });

  const browser = {
    newContext: async (opts) => {
      calls.newContext.push(opts);
      return {
        newPage: async () => makePage(),
        close: async () => {},
      };
    },
    close: async () => {},
  };

  const pw = {
    chromium: {
      launch: async () => {
        calls.launch += 1;
        return browser;
      },
    },
    _calls: calls,
  };
  return pw;
}

test("PlaywrightCapture: launches chromium once across multiple captures", async () => {
  const pw = mockPlaywright({ navigations: ["https://a", "https://b"] });
  const c = new PlaywrightCapture({ playwright: pw });
  await c.capture("https://a");
  await c.capture("https://b");
  assert.equal(pw._calls.launch, 1);
  await c.close();
});

test("PlaywrightCapture: viewport + deviceScaleFactor wired to context", async () => {
  const pw = mockPlaywright({ navigations: ["https://a"] });
  const c = new PlaywrightCapture({ playwright: pw });
  await c.capture("https://a", { width: 1600, height: 1000, deviceScaleFactor: 2 });
  const ctx = pw._calls.newContext[0];
  assert.deepEqual(ctx.viewport, { width: 1600, height: 1000 });
  assert.equal(ctx.deviceScaleFactor, 2);
  await c.close();
});

test("PlaywrightCapture: extraHTTPHeaders propagate", async () => {
  const pw = mockPlaywright({ navigations: ["https://a"] });
  const c = new PlaywrightCapture({ playwright: pw });
  await c.capture("https://a", { extraHTTPHeaders: { "x-secret": "token" } });
  assert.deepEqual(pw._calls.newContext[0].extraHTTPHeaders, { "x-secret": "token" });
  await c.close();
});

test("PlaywrightCapture: fullPage default true", async () => {
  const pw = mockPlaywright({ navigations: ["https://a"] });
  const c = new PlaywrightCapture({ playwright: pw });
  await c.capture("https://a");
  assert.equal(pw._calls.screenshot[0].fullPage, true);
  await c.close();
});

test("PlaywrightCapture: fullPage: false honored", async () => {
  const pw = mockPlaywright({ navigations: ["https://a"] });
  const c = new PlaywrightCapture({ playwright: pw });
  await c.capture("https://a", { fullPage: false });
  assert.equal(pw._calls.screenshot[0].fullPage, false);
  await c.close();
});

test("PlaywrightCapture: waitForSelector called when option set", async () => {
  const pw = mockPlaywright({ navigations: ["https://a"] });
  const c = new PlaywrightCapture({ playwright: pw });
  await c.capture("https://a", { waitForSelector: ".ready" });
  assert.equal(pw._calls.waitForSelector.length, 1);
  assert.equal(pw._calls.waitForSelector[0].selector, ".ready");
  await c.close();
});

test("PlaywrightCapture: postLoadDelayMs = 0 skips waitForTimeout", async () => {
  const pw = mockPlaywright({ navigations: ["https://a"] });
  const c = new PlaywrightCapture({ playwright: pw });
  await c.capture("https://a", { postLoadDelayMs: 0 });
  assert.equal(pw._calls.waitForTimeout.length, 0);
  await c.close();
});

test("PlaywrightCapture: postLoadDelayMs > 0 invokes waitForTimeout", async () => {
  const pw = mockPlaywright({ navigations: ["https://a"] });
  const c = new PlaywrightCapture({ playwright: pw });
  await c.capture("https://a", { postLoadDelayMs: 1500 });
  assert.deepEqual(pw._calls.waitForTimeout, [1500]);
  await c.close();
});

test("PlaywrightCapture: CaptureResult surfaces final URL + viewport", async () => {
  const pw = mockPlaywright({ navigations: ["https://a-final"] });
  const c = new PlaywrightCapture({ playwright: pw });
  const out = await c.capture("https://a-requested", { width: 800, height: 600 });
  assert.equal(out.finalUrl, "https://a-final");
  assert.equal(out.viewport.width, 800);
  assert.equal(out.viewport.height, 600);
  assert.ok(out.png instanceof Uint8Array);
  await c.close();
});

test("PlaywrightCapture: close() releases browser + subsequent capture relaunches", async () => {
  const pw = mockPlaywright({ navigations: ["https://a", "https://b"] });
  const c = new PlaywrightCapture({ playwright: pw });
  await c.capture("https://a");
  await c.close();
  await c.capture("https://b");
  assert.equal(pw._calls.launch, 2);
  await c.close();
});
