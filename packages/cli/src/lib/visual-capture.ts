/**
 * v0.9.0 — multi-modal visual review orchestrator.
 *
 * Bridges `conclave review` and `@conclave-ai/visual-review` so the
 * DesignAgent's Mode A (vision) path actually receives screenshots.
 *
 * Lives in the CLI, not visual-review, because:
 *   1. Platform resolution (Vercel / Netlify / deploy-status) and
 *      route-detection both depend on CLI-side context (config, gh CLI,
 *      filesystem crawl).
 *   2. Keeps visual-review publishable as a thin library with no CLI
 *      assumptions — anyone embedding visual-review in their own tool
 *      still gets `captureRoutes()` and `runVisualReview()` unchanged.
 *
 * Contract:
 *   - Never throws on partial failure. Returns `{ artifacts: [], ... }`
 *     with warnings/skipped populated so the CLI can log and proceed to
 *     text-only DesignAgent (Mode B).
 *   - Hard caps: `maxRoutes` routes × viewports, `maxTotalMs` wall-clock.
 *   - Only runs if `deployStatus === "success"` unless `skipDeployWait`.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { Platform, PreviewResolution } from "@conclave-ai/core";
import { resolveFirstPreview } from "@conclave-ai/core";
import type {
  CaptureRoutesInput,
  CaptureRoutesResult,
  RouteCapture,
  ViewportSpec,
  ScreenshotCapture,
} from "@conclave-ai/visual-review";

export interface VisualCaptureInput {
  repo: string;
  beforeSha: string;
  afterSha: string;
  platforms: readonly Platform[];
  /**
   * Routes to capture. When empty, the orchestrator auto-detects from
   * (in order): `.conclave/visual-routes.json`, sitemap.xml, robots.txt,
   * top-level nav, JSX page filename heuristic. Final fallback: ["/"].
   */
  routes?: readonly string[];
  /** Viewport list. Default: [desktop 1280x800, mobile 375x667]. */
  viewports?: readonly ViewportSpec[];
  /** Config root (configDir). Used to read `.conclave/visual-routes.json`. */
  configDir: string;
  /** Hard cap on captures (route × viewport). Default 8. */
  maxRoutes?: number;
  /** Total wall-clock budget. Default 8 min. */
  maxTotalMs?: number;
  /** Per-route capture timeout. Default 60 s. */
  perRouteTimeoutMs?: number;
  /** Poll preview URL resolution up to N seconds per SHA. Default 60. */
  waitSeconds?: number;
  /**
   * When true, proceed with capture even if deploy status isn't "success".
   * Default false — we skip (not fail) on non-success to avoid paying
   * vision-API cost on broken UI.
   */
  skipDeployWait?: boolean;
  /** Deploy status of the HEAD sha, as fetched by review.ts. */
  deployStatus: "success" | "failure" | "pending" | "unknown";
  /**
   * Override the capture engine (tests). When undefined, `captureRoutes`
   * creates one PlaywrightCapture per SHA (so browser state doesn't
   * leak between before/after runs).
   */
  capture?: ScreenshotCapture;
  /**
   * Override the route-detector / filesystem reader (tests). When
   * undefined, the orchestrator reads from `configDir`.
   */
  routeDetector?: (configDir: string) => Promise<string[] | null>;
  /** Override the capture impl (tests). Defaults to the real `captureRoutes`. */
  captureRoutesImpl?: (input: CaptureRoutesInput) => Promise<CaptureRoutesResult>;
}

/**
 * Visual artifact emitted into `ReviewContext.visualArtifacts[]`.
 *
 * Route string is `"/path"` or `"/path@viewportLabel"` when more than
 * one viewport is captured — lets DesignAgent attribute blockers to
 * the right rendering without needing a separate field.
 */
export interface VisualArtifact {
  route: string;
  before: Buffer;
  after: Buffer;
}

export interface VisualCaptureResult {
  artifacts: VisualArtifact[];
  /** Why we ran (for stderr logging). */
  reason: string;
  /** Combos we couldn't capture — same shape as captureRoutes. */
  skipped: Array<{ route: string; viewport: string; reason: string }>;
  /** Non-fatal warnings across detection + capture. */
  warnings: string[];
  /** Wall-clock ms of the whole run (capture + detection). */
  totalMs: number;
  /** URLs + providers we resolved. Absent when we couldn't resolve. */
  before?: PreviewResolution;
  after?: PreviewResolution;
}

export const DEFAULT_DESKTOP_VIEWPORT: ViewportSpec = {
  label: "desktop",
  width: 1280,
  height: 800,
};
export const DEFAULT_MOBILE_VIEWPORT: ViewportSpec = {
  label: "mobile",
  width: 375,
  height: 667,
};

const DEFAULT_MAX_ROUTES = 8;
const DEFAULT_MAX_TOTAL_MS = 8 * 60_000;
const DEFAULT_PER_ROUTE_TIMEOUT_MS = 60_000;

/**
 * Entrypoint. Resolves preview URLs for both SHAs, detects routes,
 * captures each (route × viewport) against both, and returns artifacts
 * in the shape DesignAgent expects.
 */
export async function runVisualCapture(input: VisualCaptureInput): Promise<VisualCaptureResult> {
  const started = Date.now();
  const warnings: string[] = [];
  const skipped: VisualCaptureResult["skipped"] = [];

  // Deploy-status gate. Decision: don't pay for vision on a red build.
  // `skipDeployWait` lets users force capture during local dev when no
  // deploy system is wired up and status is "unknown".
  if (input.deployStatus === "failure") {
    return {
      artifacts: [],
      reason: "deploy-status=failure — skipping visual capture to avoid vision cost on broken UI",
      skipped,
      warnings,
      totalMs: Date.now() - started,
    };
  }
  if (
    !input.skipDeployWait &&
    input.deployStatus !== "success"
  ) {
    return {
      artifacts: [],
      reason: `deploy-status=${input.deployStatus} — skipping visual capture (pass --skip-deploy-wait to override)`,
      skipped,
      warnings,
      totalMs: Date.now() - started,
    };
  }

  // Resolve preview URLs for both SHAs. First non-null platform wins.
  const beforeRes = await resolveFirstPreview(input.platforms, {
    repo: input.repo,
    sha: input.beforeSha,
    waitSeconds: input.waitSeconds ?? 60,
  }).catch(() => null);
  const afterRes = await resolveFirstPreview(input.platforms, {
    repo: input.repo,
    sha: input.afterSha,
    waitSeconds: input.waitSeconds ?? 60,
  }).catch(() => null);

  if (!beforeRes) {
    return {
      artifacts: [],
      reason: `no preview URL found for beforeSha=${input.beforeSha} — falling back to text-UI mode`,
      skipped,
      warnings,
      totalMs: Date.now() - started,
    };
  }
  if (!afterRes) {
    return {
      artifacts: [],
      reason: `no preview URL found for afterSha=${input.afterSha} — falling back to text-UI mode`,
      skipped,
      warnings,
      totalMs: Date.now() - started,
    };
  }

  // Routes: explicit > detected > fallback.
  let routes: string[];
  if (input.routes && input.routes.length > 0) {
    routes = [...input.routes];
  } else {
    const detector = input.routeDetector ?? detectRoutes;
    const detected = await detector(input.configDir).catch(() => null);
    if (detected && detected.length > 0) {
      routes = detected;
    } else {
      routes = ["/"];
      warnings.push("no routes detected — falling back to '/'");
    }
  }

  const viewports = input.viewports ?? [DEFAULT_DESKTOP_VIEWPORT, DEFAULT_MOBILE_VIEWPORT];
  const maxRoutes = input.maxRoutes ?? DEFAULT_MAX_ROUTES;
  const maxTotalMs = input.maxTotalMs ?? DEFAULT_MAX_TOTAL_MS;
  const perRouteTimeoutMs = input.perRouteTimeoutMs ?? DEFAULT_PER_ROUTE_TIMEOUT_MS;

  // Lazy-load the capture impl — visual-review is an optional surface so
  // users who disable visual never pay the import cost.
  const captureImpl =
    input.captureRoutesImpl ??
    (await (async () => {
      const mod = await import("@conclave-ai/visual-review");
      return mod.captureRoutes;
    })());

  // Split the remaining budget roughly in half for the two phases — the
  // second capture pass should not starve if the first was slow.
  const halfBudget = Math.floor(maxTotalMs / 2);

  const beforeResult = await captureImpl({
    baseUrl: beforeRes.url,
    routes,
    viewports,
    maxCaptures: maxRoutes,
    totalBudgetMs: halfBudget,
    perRouteTimeoutMs,
    ...(input.capture ? { capture: input.capture } : {}),
  });
  warnings.push(...beforeResult.warnings.map((w) => `[before] ${w}`));
  skipped.push(...beforeResult.skipped);

  // Use the same set of successful routes for `after` so we compare
  // like-for-like. Drop routes we failed to capture on `before` to keep
  // pairing sane.
  const beforeByKey = new Map<string, RouteCapture>();
  for (const c of beforeResult.captures) {
    beforeByKey.set(artifactKey(c), c);
  }
  if (beforeByKey.size === 0) {
    return {
      artifacts: [],
      reason: `no before captures succeeded (${beforeResult.skipped.length} skipped) — falling back to text-UI mode`,
      skipped,
      warnings,
      totalMs: Date.now() - started,
      before: beforeRes,
      after: afterRes,
    };
  }

  // Only ask `after` to capture routes we successfully captured on `before`
  // — matches the pairing contract in DesignAgent and saves budget.
  const afterRoutesToTry = Array.from(new Set(beforeResult.captures.map((c) => c.route)));
  const afterViewportsToTry = dedupeViewports(
    beforeResult.captures.map((c) => c.viewport),
  );

  const afterResult = await captureImpl({
    baseUrl: afterRes.url,
    routes: afterRoutesToTry,
    viewports: afterViewportsToTry,
    maxCaptures: maxRoutes,
    totalBudgetMs: Math.max(60_000, maxTotalMs - (Date.now() - started)),
    perRouteTimeoutMs,
    ...(input.capture ? { capture: input.capture } : {}),
  });
  warnings.push(...afterResult.warnings.map((w) => `[after] ${w}`));
  skipped.push(...afterResult.skipped);

  const afterByKey = new Map<string, RouteCapture>();
  for (const c of afterResult.captures) {
    afterByKey.set(artifactKey(c), c);
  }

  const artifacts: VisualArtifact[] = [];
  for (const [key, beforeCap] of beforeByKey) {
    const afterCap = afterByKey.get(key);
    if (!afterCap) {
      skipped.push({
        route: beforeCap.route,
        viewport: beforeCap.viewport.label,
        reason: "after capture missing — pair dropped",
      });
      continue;
    }
    artifacts.push({
      route:
        viewports.length > 1
          ? `${beforeCap.route}@${beforeCap.viewport.label}`
          : beforeCap.route,
      before: Buffer.from(beforeCap.result.png),
      after: Buffer.from(afterCap.result.png),
    });
  }

  return {
    artifacts,
    reason:
      artifacts.length > 0
        ? `captured ${artifacts.length} before/after pair(s) across ${new Set(artifacts.map((a) => a.route.split("@")[0])).size} route(s)`
        : "no pairs captured — visualArtifacts empty",
    skipped,
    warnings,
    totalMs: Date.now() - started,
    before: beforeRes,
    after: afterRes,
  };
}

function artifactKey(cap: RouteCapture): string {
  return `${cap.route}::${cap.viewport.label}`;
}

function dedupeViewports(vs: readonly ViewportSpec[]): ViewportSpec[] {
  const seen = new Set<string>();
  const out: ViewportSpec[] = [];
  for (const v of vs) {
    if (seen.has(v.label)) continue;
    seen.add(v.label);
    out.push(v);
  }
  return out;
}

/**
 * v0.9.0 route auto-detection. Returns null when we can't find any
 * route hints — caller falls back to ["/"]. Never throws.
 *
 * Order of precedence:
 *   1. `.conclave/visual-routes.json` in configDir (explicit curation)
 *   2. Filesystem heuristic: scan `pages/`, `app/`, `src/pages/`,
 *      `src/app/` for likely-page files; "/login" from "login/page.tsx"
 *      etc. Capped at 8 matches.
 *
 * sitemap.xml / robots.txt parsing is deliberately out of scope for
 * v0.9.0 — they require the preview URL (which is where we haven't
 * even routed yet) and they're rare on fresh projects. Revisit if
 * users ask for it.
 */
export async function detectRoutes(configDir: string): Promise<string[] | null> {
  // 1. Explicit curation.
  const explicit = await readVisualRoutesJson(configDir);
  if (explicit && explicit.length > 0) return explicit;

  // 2. Filesystem heuristic.
  const fsRoutes = await detectRoutesFromFs(configDir).catch(() => [] as string[]);
  if (fsRoutes.length > 0) return fsRoutes;

  return null;
}

async function readVisualRoutesJson(configDir: string): Promise<string[] | null> {
  const p = path.join(configDir, ".conclave", "visual-routes.json");
  try {
    const raw = await fs.readFile(p, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((r): r is string => typeof r === "string" && r.startsWith("/"));
    }
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as { routes?: unknown }).routes)) {
      return (parsed as { routes: unknown[] }).routes.filter(
        (r): r is string => typeof r === "string" && r.startsWith("/"),
      );
    }
    return null;
  } catch {
    return null;
  }
}

const PAGE_FILE_PATTERNS = [
  /^page\.(tsx|ts|jsx|js)$/,
  /^index\.(tsx|ts|jsx|js)$/,
  /^\+page\.(svelte|tsx|ts|jsx|js)$/, // SvelteKit
];

const PAGE_ROOTS = ["pages", "app", "src/pages", "src/app"];

async function detectRoutesFromFs(configDir: string): Promise<string[]> {
  const found = new Set<string>();
  for (const root of PAGE_ROOTS) {
    const abs = path.join(configDir, root);
    await walkPages(abs, abs, found, 0).catch(() => {});
  }
  const list = [...found].sort();
  // Cap at 8 per the budget — the orchestrator will cap again but we
  // want to shrink the list before routes × viewports explodes.
  return list.slice(0, 8);
}

async function walkPages(
  root: string,
  current: string,
  found: Set<string>,
  depth: number,
): Promise<void> {
  if (depth > 6) return; // guard against symlink loops / deep pnpm stores
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) {
      // Route directory — its `page.tsx` (Next app router) or the dir
      // itself (pages router) denotes the route path.
      await walkPages(root, full, found, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!PAGE_FILE_PATTERNS.some((re) => re.test(entry.name))) continue;

    const rel = path.relative(root, full).replace(/\\/g, "/");
    // Strip the filename to get the route dir.
    const dir = path.dirname(rel);
    const route = dir === "." ? "/" : "/" + dir.replace(/^\/+/, "");
    // Skip "_"-prefixed and grouped routes — those aren't user-facing.
    if (/\/_|\(/.test(route)) continue;
    found.add(route);
    if (found.size >= 16) return;
  }
}
