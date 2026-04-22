import { test } from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { captureRoutes, normalizeBaseUrl, normalizeRoute } from "../dist/index.js";

function solidPng(w, h) {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 128;
    png.data[i + 1] = 128;
    png.data[i + 2] = 128;
    png.data[i + 3] = 255;
  }
  return new Uint8Array(PNG.sync.write(png));
}

function stubCapture({ failOn = new Set(), delayMs = 0, png = solidPng(40, 40) } = {}) {
  const calls = [];
  let closed = 0;
  return {
    id: "stub",
    calls,
    get closed() {
      return closed;
    },
    capture: async (url, opts) => {
      calls.push({ url, opts });
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      if (failOn.has(url)) throw new Error(`stub-fail for ${url}`);
      return {
        png,
        finalUrl: url,
        viewport: { width: opts.width, height: opts.height, deviceScaleFactor: opts.deviceScaleFactor ?? 1 },
      };
    },
    close: async () => {
      closed += 1;
    },
  };
}

const DESKTOP = { label: "desktop", width: 1280, height: 800 };
const MOBILE = { label: "mobile", width: 375, height: 667 };

test("normalizeBaseUrl: strips trailing slashes", () => {
  assert.equal(normalizeBaseUrl("https://x.com/"), "https://x.com");
  assert.equal(normalizeBaseUrl("https://x.com//"), "https://x.com");
  assert.equal(normalizeBaseUrl("https://x.com"), "https://x.com");
});

test("normalizeBaseUrl: throws on empty", () => {
  assert.throws(() => normalizeBaseUrl(""));
});

test("normalizeRoute: requires leading slash", () => {
  assert.throws(() => normalizeRoute("login"));
  assert.equal(normalizeRoute("/login"), "/login");
});

test("captureRoutes: captures one per (route, viewport) in row-major order", async () => {
  const cap = stubCapture();
  const result = await captureRoutes({
    baseUrl: "https://preview.acme.app",
    routes: ["/", "/login"],
    viewports: [DESKTOP, MOBILE],
    capture: cap,
  });
  assert.equal(result.captures.length, 4);
  assert.deepEqual(
    result.captures.map((c) => `${c.route}@${c.viewport.label}`),
    ["/@desktop", "/@mobile", "/login@desktop", "/login@mobile"],
  );
  // Capture not closed by helper when supplied externally.
  assert.equal(cap.closed, 0);
});

test("captureRoutes: dedupes routes, warns", async () => {
  const cap = stubCapture();
  const result = await captureRoutes({
    baseUrl: "https://x.com",
    routes: ["/", "/login", "/"],
    viewports: [DESKTOP],
    capture: cap,
  });
  assert.equal(result.captures.length, 2);
  assert.ok(result.warnings.some((w) => w.includes("duplicate")));
});

test("captureRoutes: maxCaptures caps and records skipped", async () => {
  const cap = stubCapture();
  const result = await captureRoutes({
    baseUrl: "https://x.com",
    routes: ["/a", "/b", "/c", "/d", "/e"],
    viewports: [DESKTOP, MOBILE],
    maxCaptures: 3,
    capture: cap,
  });
  assert.equal(result.captures.length, 3);
  assert.equal(result.skipped.length, 7); // 10 combos - 3 ran
  for (const sk of result.skipped) {
    assert.match(sk.reason, /max-captures/);
  }
});

test("captureRoutes: failed individual capture goes into skipped, run continues", async () => {
  const cap = stubCapture({ failOn: new Set(["https://x.com/login"]) });
  const result = await captureRoutes({
    baseUrl: "https://x.com",
    routes: ["/", "/login", "/dashboard"],
    viewports: [DESKTOP],
    capture: cap,
  });
  assert.equal(result.captures.length, 2);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /stub-fail/);
  assert.equal(result.skipped[0].route, "/login");
});

test("captureRoutes: budget exhaustion aborts remaining combos", async () => {
  // Make each capture take 20ms, set total budget to 50ms → only 2 fit.
  const cap = stubCapture({ delayMs: 20 });
  const result = await captureRoutes({
    baseUrl: "https://x.com",
    routes: ["/a", "/b", "/c", "/d"],
    viewports: [DESKTOP],
    totalBudgetMs: 50,
    capture: cap,
  });
  // At least 1 captured (the first one starts before budget check);
  // some combos should be skipped due to budget.
  assert.ok(result.captures.length >= 1, "at least one capture");
  assert.ok(result.skipped.some((s) => /budget/.test(s.reason)), "some skipped due to budget");
});

test("captureRoutes: viewport forwarded into CaptureOptions", async () => {
  const cap = stubCapture();
  await captureRoutes({
    baseUrl: "https://x.com",
    routes: ["/"],
    viewports: [{ label: "hd", width: 1920, height: 1080, deviceScaleFactor: 2 }],
    capture: cap,
  });
  assert.equal(cap.calls.length, 1);
  assert.equal(cap.calls[0].opts.width, 1920);
  assert.equal(cap.calls[0].opts.height, 1080);
  assert.equal(cap.calls[0].opts.deviceScaleFactor, 2);
});

test("captureRoutes: empty routes throws up-front", async () => {
  await assert.rejects(
    captureRoutes({
      baseUrl: "https://x.com",
      routes: [],
      viewports: [DESKTOP],
      capture: stubCapture(),
    }),
  );
});

test("captureRoutes: empty viewports throws up-front", async () => {
  await assert.rejects(
    captureRoutes({
      baseUrl: "https://x.com",
      routes: ["/"],
      viewports: [],
      capture: stubCapture(),
    }),
  );
});

test("captureRoutes: URL assembled as base + route with no double slash", async () => {
  const cap = stubCapture();
  await captureRoutes({
    baseUrl: "https://x.com/",
    routes: ["/foo"],
    viewports: [DESKTOP],
    capture: cap,
  });
  assert.equal(cap.calls[0].url, "https://x.com/foo");
});

test("captureRoutes: perRouteTimeoutMs flows into CaptureOptions.timeoutMs", async () => {
  const cap = stubCapture();
  await captureRoutes({
    baseUrl: "https://x.com",
    routes: ["/"],
    viewports: [DESKTOP],
    perRouteTimeoutMs: 12345,
    capture: cap,
  });
  assert.equal(cap.calls[0].opts.timeoutMs, 12345);
});
