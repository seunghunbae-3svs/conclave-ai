export interface CaptureOptions {
  /** Viewport width. Default 1280. */
  width?: number;
  /** Viewport height. Default 800. */
  height?: number;
  /** Device scale factor for retina-like output. Default 1. */
  deviceScaleFactor?: number;
  /** Full-page screenshot (scroll + stitch) vs viewport only. Default true. */
  fullPage?: boolean;
  /** Navigation timeout (ms). Default 30_000. */
  timeoutMs?: number;
  /** Wait-for selector before screenshotting. */
  waitForSelector?: string;
  /** Extra delay after page load (ms). Default 500 for network settle. */
  postLoadDelayMs?: number;
  /** HTTP headers (e.g. auth) forwarded to the request. */
  extraHTTPHeaders?: Record<string, string>;
}

export interface CaptureResult {
  /** PNG image bytes. */
  png: Uint8Array;
  /** Final URL after redirects. */
  finalUrl: string;
  /** Viewport used. */
  viewport: { width: number; height: number; deviceScaleFactor: number };
}

/**
 * ScreenshotCapture — pluggable capture interface. Default impl below
 * uses Playwright; users who already have Puppeteer / browser-instance
 * of their choice can swap via `opts.capture` on the orchestrator.
 */
export interface ScreenshotCapture {
  readonly id: string;
  capture(url: string, opts?: CaptureOptions): Promise<CaptureResult>;
  close(): Promise<void>;
}

/** Minimal Playwright subset we rely on — typed narrowly for test mocking. */
export interface PlaywrightLike {
  chromium: {
    launch(opts?: { headless?: boolean }): Promise<PlaywrightBrowser>;
  };
}

export interface PlaywrightBrowser {
  newContext(opts?: {
    viewport?: { width: number; height: number };
    deviceScaleFactor?: number;
    extraHTTPHeaders?: Record<string, string>;
  }): Promise<PlaywrightContext>;
  close(): Promise<void>;
}

export interface PlaywrightContext {
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
}

export interface PlaywrightPage {
  goto(url: string, opts?: { timeout?: number; waitUntil?: string }): Promise<{ url: () => string } | null>;
  url(): string;
  waitForSelector(selector: string, opts?: { timeout?: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  screenshot(opts?: { fullPage?: boolean }): Promise<Uint8Array | Buffer>;
  close(): Promise<void>;
}

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;
const DEFAULT_DELAY = 500;
const DEFAULT_TIMEOUT = 30_000;

export interface PlaywrightCaptureOptions {
  /** Pre-launched Playwright module (tests). */
  playwright?: PlaywrightLike;
  /** Factory invoked when `playwright` is not supplied. Defaults to dynamic `import("playwright")`. */
  playwrightFactory?: () => Promise<PlaywrightLike>;
  /** Run browser with visible UI (debugging). Default headless. */
  headless?: boolean;
  /** v0.13 — when import("playwright") fails on first capture, run
   * `npx playwright install chromium` once and retry. Defaults true.
   * Set false in air-gapped CI where the install would hang. */
  autoInstall?: boolean;
  /** v0.13 — test seam for the auto-install runner. Production calls
   * `npx playwright install chromium --with-deps`. */
  installRunner?: () => Promise<{ ok: boolean; reason?: string }>;
  /** v0.13 — log sink (defaults to stderr). Used to surface the
   * install-in-progress message so the user knows why a first-run
   * is slower. */
  log?: (msg: string) => void;
}

/**
 * v0.13 — default auto-install runner. Spawns
 * `npx playwright install chromium --with-deps`. Returns a structured
 * result so the caller can fold `reason` into the user-facing error
 * when install fails.
 */
async function defaultInstallRunner(): Promise<{ ok: boolean; reason?: string }> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const child = spawn("npx", ["-y", "playwright", "install", "chromium", "--with-deps"], {
      stdio: ["ignore", "inherit", "inherit"],
      shell: process.platform === "win32",
    });
    child.on("error", (err) => {
      resolve({ ok: false, reason: err.message });
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve({ ok: true });
      } else {
        resolve({ ok: false, reason: `exit code ${code}` });
      }
    });
  });
}

/**
 * PlaywrightCapture — launches one Chromium, reuses context across
 * captures in the same process, closes on explicit `close()`.
 *
 * Playwright is declared as an optional peer dependency so installers
 * that never run visual review don't pay the ~300MB Chromium cost.
 * `opts.playwright` injection lets tests avoid the real SDK entirely.
 */
export class PlaywrightCapture implements ScreenshotCapture {
  readonly id = "playwright";

  private readonly factory: () => Promise<PlaywrightLike>;
  private readonly headless: boolean;
  private readonly autoInstall: boolean;
  private readonly installRunner: () => Promise<{ ok: boolean; reason?: string }>;
  private readonly log: (msg: string) => void;
  private browserPromise: Promise<PlaywrightBrowser> | null = null;

  constructor(opts: PlaywrightCaptureOptions = {}) {
    this.headless = opts.headless ?? true;
    this.autoInstall = opts.autoInstall ?? true;
    this.installRunner = opts.installRunner ?? defaultInstallRunner;
    this.log = opts.log ?? ((m) => process.stderr.write(m + "\n"));
    this.factory =
      opts.playwrightFactory ??
      (async () => {
        if (opts.playwright) return opts.playwright;
        try {
          return (await import("playwright")) as unknown as PlaywrightLike;
        } catch (err) {
          // v0.13 — auto-install fallback. The Node-side `playwright`
          // npm package is a workspace dep, so the SDK itself loads
          // fine; the missing piece on a fresh machine is the
          // BROWSER BINARY (chromium ~150MB). We try to fetch it once
          // when capture is first requested, then re-import. Opt out
          // via `autoInstall: false` for air-gapped CI.
          if (!this.autoInstall) {
            throw new Error(
              "PlaywrightCapture: playwright not installed. Run `pnpm add playwright && npx playwright install chromium`. (autoInstall disabled)",
            );
          }
          this.log(
            "conclave visual: playwright SDK or browser missing — attempting one-time `npx playwright install chromium` (this can take ~30-60s)...",
          );
          const installed = await this.installRunner();
          if (!installed.ok) {
            throw new Error(
              `PlaywrightCapture: auto-install failed — ${installed.reason}. Run \`pnpm add playwright && npx playwright install chromium\` manually, or pass --no-visual.`,
            );
          }
          // Retry the import after install succeeds.
          try {
            return (await import("playwright")) as unknown as PlaywrightLike;
          } catch (retryErr) {
            throw new Error(
              `PlaywrightCapture: install reported ok but re-import still failed — ${(retryErr as Error).message}`,
            );
          }
        }
      });
  }

  private async getBrowser(): Promise<PlaywrightBrowser> {
    if (!this.browserPromise) {
      this.browserPromise = (async () => {
        const pw = await this.factory();
        return pw.chromium.launch({ headless: this.headless });
      })();
    }
    return this.browserPromise;
  }

  async capture(url: string, opts: CaptureOptions = {}): Promise<CaptureResult> {
    const width = opts.width ?? DEFAULT_WIDTH;
    const height = opts.height ?? DEFAULT_HEIGHT;
    const deviceScaleFactor = opts.deviceScaleFactor ?? 1;
    const fullPage = opts.fullPage ?? true;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
    const postLoadDelayMs = opts.postLoadDelayMs ?? DEFAULT_DELAY;

    const browser = await this.getBrowser();
    const contextOpts: Parameters<PlaywrightBrowser["newContext"]>[0] = {
      viewport: { width, height },
      deviceScaleFactor,
    };
    if (opts.extraHTTPHeaders) contextOpts.extraHTTPHeaders = opts.extraHTTPHeaders;
    const context = await browser.newContext(contextOpts);
    try {
      const page = await context.newPage();
      await page.goto(url, { timeout: timeoutMs, waitUntil: "networkidle" });
      if (opts.waitForSelector) {
        await page.waitForSelector(opts.waitForSelector, { timeout: timeoutMs });
      }
      if (postLoadDelayMs > 0) await page.waitForTimeout(postLoadDelayMs);
      const raw = await page.screenshot({ fullPage });
      const png = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer);
      const finalUrl = page.url();
      await page.close();
      return { png, finalUrl, viewport: { width, height, deviceScaleFactor } };
    } finally {
      await context.close();
    }
  }

  async close(): Promise<void> {
    if (!this.browserPromise) return;
    const browser = await this.browserPromise;
    await browser.close();
    this.browserPromise = null;
  }
}
