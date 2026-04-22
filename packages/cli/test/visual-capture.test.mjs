import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runVisualCapture } from "../dist/lib/visual-capture.js";
import { parseArgv, buildViewports } from "../dist/commands/review.js";

// Minimal valid PNG header — enough to convince downstream code this is a
// PNG buffer for mocking purposes. Never decoded by the tests themselves.
const tinyPngBytes = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00,
]);
function solidPng() {
  return tinyPngBytes;
}

function fixedPlatform(id, perSha) {
  return {
    id,
    displayName: id,
    resolve: async ({ sha }) => {
      const v = perSha[sha];
      return v ? { url: v, provider: id, sha } : null;
    },
  };
}

function stubCaptureRoutes({ byBaseUrl = {} } = {}) {
  const calls = [];
  return {
    calls,
    impl: async (input) => {
      calls.push(input);
      const setForBase = byBaseUrl[input.baseUrl] ?? {
        successes: input.routes.map((r) => ({ route: r, viewport: input.viewports[0] })),
        failures: [],
      };
      const captures = setForBase.successes.map(({ route, viewport }) => ({
        route,
        viewport,
        url: `${input.baseUrl}${route}`,
        result: {
          png: solidPng(20, 20),
          finalUrl: `${input.baseUrl}${route}`,
          viewport: { width: viewport.width, height: viewport.height, deviceScaleFactor: 1 },
        },
        durationMs: 10,
      }));
      return {
        captures,
        skipped: setForBase.failures.map((f) => ({
          route: f.route,
          viewport: f.viewport.label,
          reason: f.reason ?? "stub-skip",
        })),
        warnings: [],
        totalMs: 20,
      };
    },
  };
}

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aic-vc-"));
}
function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

const DESKTOP = { label: "desktop", width: 1280, height: 800 };
const MOBILE = { label: "mobile", width: 375, height: 667 };

// ---- parseArgv flags -----------------------------------------------------

test("parseArgv: --visual toggles visual capture on", () => {
  const a = parseArgv(["--visual"]);
  assert.equal(a.visual, true);
  assert.equal(a.noVisual, false);
});

test("parseArgv: --no-visual beats config (recorded in args)", () => {
  const a = parseArgv(["--no-visual"]);
  assert.equal(a.noVisual, true);
});

test("parseArgv: --visual-routes splits and trims CSV", () => {
  const a = parseArgv(["--visual-routes", "/, /login,  /dashboard "]);
  assert.deepEqual(a.visualRoutes, ["/", "/login", "/dashboard"]);
});

test("parseArgv: --skip-deploy-wait recorded", () => {
  const a = parseArgv(["--visual", "--skip-deploy-wait"]);
  assert.equal(a.skipDeployWait, true);
});

// ---- buildViewports ------------------------------------------------------

test("buildViewports: config desktop+mobile expands to two specs", () => {
  const vps = buildViewports({ desktop: [1440, 900], mobile: [390, 844] });
  assert.equal(vps.length, 2);
  assert.deepEqual(vps[0], { label: "desktop", width: 1440, height: 900 });
  assert.deepEqual(vps[1], { label: "mobile", width: 390, height: 844 });
});

test("buildViewports: empty config falls back to desktop 1280x800", () => {
  const vps = buildViewports(undefined);
  assert.equal(vps.length, 1);
  assert.deepEqual(vps[0], { label: "desktop", width: 1280, height: 800 });
});

test("buildViewports: only desktop specified → no mobile added", () => {
  const vps = buildViewports({ desktop: [1280, 720] });
  assert.equal(vps.length, 1);
  assert.equal(vps[0].label, "desktop");
});

// ---- runVisualCapture ----------------------------------------------------

const baseInput = {
  repo: "acme/ui",
  beforeSha: "a111",
  afterSha: "b222",
  platforms: [
    fixedPlatform("vercel", {
      a111: "https://pr-before.acme.app",
      b222: "https://pr-after.acme.app",
    }),
  ],
  deployStatus: "success",
  routes: ["/"],
  viewports: [DESKTOP],
};

test("runVisualCapture: deploy=failure → skips with explicit reason", async () => {
  const dir = freshDir();
  try {
    const cap = stubCaptureRoutes();
    const r = await runVisualCapture({
      ...baseInput,
      configDir: dir,
      deployStatus: "failure",
      captureRoutesImpl: cap.impl,
    });
    assert.equal(r.artifacts.length, 0);
    assert.match(r.reason, /deploy-status=failure/);
    assert.equal(cap.calls.length, 0, "no capture attempted");
  } finally {
    cleanup(dir);
  }
});

test("runVisualCapture: deploy=pending + no skipDeployWait → skips", async () => {
  const dir = freshDir();
  try {
    const cap = stubCaptureRoutes();
    const r = await runVisualCapture({
      ...baseInput,
      configDir: dir,
      deployStatus: "pending",
      captureRoutesImpl: cap.impl,
    });
    assert.equal(r.artifacts.length, 0);
    assert.match(r.reason, /deploy-status=pending/);
  } finally {
    cleanup(dir);
  }
});

test("runVisualCapture: deploy=pending + skipDeployWait=true → proceeds", async () => {
  const dir = freshDir();
  try {
    const cap = stubCaptureRoutes();
    const r = await runVisualCapture({
      ...baseInput,
      configDir: dir,
      deployStatus: "pending",
      skipDeployWait: true,
      captureRoutesImpl: cap.impl,
    });
    assert.equal(r.artifacts.length, 1);
    assert.equal(cap.calls.length, 2, "before + after capture both attempted");
  } finally {
    cleanup(dir);
  }
});

test("runVisualCapture: preview URL missing for before → empty artifacts, reason, no throw", async () => {
  const dir = freshDir();
  try {
    const cap = stubCaptureRoutes();
    const r = await runVisualCapture({
      ...baseInput,
      platforms: [
        fixedPlatform("vercel", { b222: "https://after.acme.app" }), // no before
      ],
      configDir: dir,
      captureRoutesImpl: cap.impl,
    });
    assert.equal(r.artifacts.length, 0);
    assert.match(r.reason, /no preview URL found for beforeSha/);
  } finally {
    cleanup(dir);
  }
});

test("runVisualCapture: explicit routes override detection", async () => {
  const dir = freshDir();
  try {
    // Also drop a visual-routes.json that would conflict to prove explicit wins.
    fs.mkdirSync(path.join(dir, ".conclave"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".conclave", "visual-routes.json"),
      JSON.stringify({ routes: ["/unexpected"] }),
    );
    const cap = stubCaptureRoutes();
    const r = await runVisualCapture({
      ...baseInput,
      configDir: dir,
      routes: ["/a", "/b"],
      captureRoutesImpl: cap.impl,
    });
    assert.equal(r.artifacts.length, 2);
    assert.deepEqual(
      r.artifacts.map((a) => a.route),
      ["/a", "/b"],
    );
    // The first call (before SHA) sees exactly the explicit route list.
    assert.deepEqual(cap.calls[0].routes, ["/a", "/b"]);
  } finally {
    cleanup(dir);
  }
});

test("runVisualCapture: route detection reads .conclave/visual-routes.json", async () => {
  const dir = freshDir();
  try {
    fs.mkdirSync(path.join(dir, ".conclave"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".conclave", "visual-routes.json"),
      JSON.stringify(["/login", "/signup"]),
    );
    const cap = stubCaptureRoutes();
    const r = await runVisualCapture({
      ...baseInput,
      configDir: dir,
      routes: undefined,
      captureRoutesImpl: cap.impl,
    });
    assert.equal(r.artifacts.length, 2);
    assert.deepEqual(
      r.artifacts.map((a) => a.route).sort(),
      ["/login", "/signup"],
    );
  } finally {
    cleanup(dir);
  }
});

test("runVisualCapture: filesystem route detection from pages dir", async () => {
  const dir = freshDir();
  try {
    fs.mkdirSync(path.join(dir, "pages", "login"), { recursive: true });
    fs.writeFileSync(path.join(dir, "pages", "login", "page.tsx"), "export default () => null;");
    fs.writeFileSync(path.join(dir, "pages", "index.tsx"), "export default () => null;");
    const cap = stubCaptureRoutes();
    const r = await runVisualCapture({
      ...baseInput,
      configDir: dir,
      routes: undefined,
      captureRoutesImpl: cap.impl,
    });
    const routes = r.artifacts.map((a) => a.route);
    assert.ok(routes.includes("/"), "index.tsx becomes /");
    assert.ok(routes.includes("/login"), "login/page.tsx becomes /login");
  } finally {
    cleanup(dir);
  }
});

test("runVisualCapture: fallback to '/' when nothing detected", async () => {
  const dir = freshDir();
  try {
    const cap = stubCaptureRoutes();
    const r = await runVisualCapture({
      ...baseInput,
      configDir: dir,
      routes: undefined,
      captureRoutesImpl: cap.impl,
    });
    assert.equal(r.artifacts.length, 1);
    assert.equal(r.artifacts[0].route, "/");
    assert.ok(r.warnings.some((w) => /falling back/.test(w)));
  } finally {
    cleanup(dir);
  }
});

test("runVisualCapture: pairs before/after by (route × viewport)", async () => {
  const dir = freshDir();
  try {
    const cap = stubCaptureRoutes({
      byBaseUrl: {
        "https://pr-before.acme.app": {
          successes: [
            { route: "/", viewport: DESKTOP },
            { route: "/", viewport: MOBILE },
          ],
          failures: [],
        },
        "https://pr-after.acme.app": {
          successes: [
            { route: "/", viewport: DESKTOP },
            { route: "/", viewport: MOBILE },
          ],
          failures: [],
        },
      },
    });
    const r = await runVisualCapture({
      ...baseInput,
      configDir: dir,
      routes: ["/"],
      viewports: [DESKTOP, MOBILE],
      captureRoutesImpl: cap.impl,
    });
    assert.equal(r.artifacts.length, 2);
    assert.deepEqual(
      r.artifacts.map((a) => a.route).sort(),
      ["/@desktop", "/@mobile"],
    );
    assert.ok(Buffer.isBuffer(r.artifacts[0].before));
    assert.ok(Buffer.isBuffer(r.artifacts[0].after));
  } finally {
    cleanup(dir);
  }
});

test("runVisualCapture: after-capture missing for a route → pair dropped (no error)", async () => {
  const dir = freshDir();
  try {
    const cap = stubCaptureRoutes({
      byBaseUrl: {
        "https://pr-before.acme.app": {
          successes: [{ route: "/", viewport: DESKTOP }, { route: "/x", viewport: DESKTOP }],
          failures: [],
        },
        "https://pr-after.acme.app": {
          successes: [{ route: "/", viewport: DESKTOP }],
          failures: [{ route: "/x", viewport: DESKTOP, reason: "stub-fail" }],
        },
      },
    });
    const r = await runVisualCapture({
      ...baseInput,
      configDir: dir,
      routes: ["/", "/x"],
      captureRoutesImpl: cap.impl,
    });
    assert.equal(r.artifacts.length, 1);
    assert.equal(r.artifacts[0].route, "/");
    assert.ok(r.skipped.some((s) => s.route === "/x"));
  } finally {
    cleanup(dir);
  }
});

test("runVisualCapture: before captures all failed → empty artifacts, explicit reason", async () => {
  const dir = freshDir();
  try {
    const cap = stubCaptureRoutes({
      byBaseUrl: {
        "https://pr-before.acme.app": {
          successes: [],
          failures: [{ route: "/", viewport: DESKTOP, reason: "oops" }],
        },
      },
    });
    const r = await runVisualCapture({
      ...baseInput,
      configDir: dir,
      routes: ["/"],
      captureRoutesImpl: cap.impl,
    });
    assert.equal(r.artifacts.length, 0);
    assert.match(r.reason, /no before captures succeeded/);
  } finally {
    cleanup(dir);
  }
});

test("runVisualCapture: maxRoutes forwarded to capture impl", async () => {
  const dir = freshDir();
  try {
    const cap = stubCaptureRoutes();
    await runVisualCapture({
      ...baseInput,
      configDir: dir,
      routes: ["/a", "/b", "/c"],
      maxRoutes: 2,
      captureRoutesImpl: cap.impl,
    });
    assert.equal(cap.calls[0].maxCaptures, 2);
  } finally {
    cleanup(dir);
  }
});
