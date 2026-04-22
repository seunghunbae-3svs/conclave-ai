import {
  PlaywrightCapture,
  type CaptureOptions,
  type CaptureResult,
  type ScreenshotCapture,
} from "./capture.js";

/**
 * v0.9.0 — multi-route capture helper for `conclave review --visual`.
 *
 * Shape: given a base preview URL, an ordered route list, and a viewport
 * spec, produce one capture per (route, viewport). The returned array
 * preserves input order so the orchestrator can pair BEFORE + AFTER
 * captures route-by-route without re-matching paths.
 *
 * Why a helper, not inline in the review command:
 *   - Unit-testable without dragging the CLI command into the test path.
 *   - Hard time + route caps enforced here, not scattered across callers.
 *   - Capture instance reused across routes (one Chromium launch per run).
 *
 * Caller contract:
 *   - `baseUrl` MUST NOT have a trailing slash; routes MUST start with "/"
 *     (we throw on either — cheaper than silently producing double-slashes).
 *   - `maxRoutes` is a hard cap; extra routes are dropped with a warning
 *     in `warnings[]` but the call still succeeds.
 *   - `perRouteTimeoutMs` bounds a single capture; `totalBudgetMs` bounds
 *     the WHOLE run (we abort remaining routes if we blow the budget and
 *     report the skipped routes in `skipped[]`).
 */

export interface ViewportSpec {
  /** Short label — shows up in artifact route names like "/login@mobile". */
  label: string;
  width: number;
  height: number;
  deviceScaleFactor?: number;
}

export interface RouteCapture {
  /** Original input route, e.g. "/login". */
  route: string;
  /** Viewport label. Blended with route as `${route}@${label}` in callers. */
  viewport: ViewportSpec;
  /** The full URL hit (baseUrl + route). */
  url: string;
  result: CaptureResult;
  /** Wall-clock ms the capture took. */
  durationMs: number;
}

export interface CaptureRoutesInput {
  /** Preview base URL. Example: "https://pr-21-acme.vercel.app". NO trailing slash. */
  baseUrl: string;
  /** Ordered route list. Must start with "/". Duplicates deduped in insertion order. */
  routes: readonly string[];
  /** One or more viewport specs. Each route is captured once per viewport. */
  viewports: readonly ViewportSpec[];
  /** Capture engine. Defaults to a fresh `PlaywrightCapture`. */
  capture?: ScreenshotCapture;
  /** Per-route capture options (forwarded to `capture.capture()`). */
  captureOptions?: Omit<CaptureOptions, "width" | "height" | "deviceScaleFactor">;
  /**
   * Hard cap on number of (route × viewport) combinations attempted.
   * Default 8, per v0.9.0 cost budget decision.
   */
  maxCaptures?: number;
  /**
   * Total wall-clock budget across all captures. When exceeded, remaining
   * combos are skipped (not failed). Default 8 minutes.
   */
  totalBudgetMs?: number;
  /** Per-capture timeout. Default 60_000 (see task spec). */
  perRouteTimeoutMs?: number;
}

export interface CaptureRoutesResult {
  /** Successful captures, in input order. */
  captures: RouteCapture[];
  /** Combos we couldn't run (timeout / budget / error). Never throws. */
  skipped: Array<{ route: string; viewport: string; reason: string }>;
  /** Non-fatal warnings (route-list truncation, URL-normalization hints, etc.). */
  warnings: string[];
  /** Total elapsed ms across the whole call. */
  totalMs: number;
}

const DEFAULT_MAX_CAPTURES = 8;
const DEFAULT_TOTAL_BUDGET_MS = 8 * 60_000; // 8 minutes
const DEFAULT_PER_ROUTE_TIMEOUT_MS = 60_000;

export function normalizeBaseUrl(baseUrl: string): string {
  if (!baseUrl) throw new Error("captureRoutes: baseUrl is required");
  // Strip trailing slashes aggressively — callers sometimes pass "https://x/"
  // from env vars. We don't throw; we just normalize and warn via return.
  return baseUrl.replace(/\/+$/u, "");
}

export function normalizeRoute(route: string): string {
  if (!route) throw new Error("captureRoutes: route is empty");
  if (!route.startsWith("/")) throw new Error(`captureRoutes: route must start with "/": got ${route}`);
  return route;
}

/**
 * Deduplicate preserving insertion order. We use this over `[...new Set(...)]`
 * because the set semantic depends on the JS engine's insertion-order
 * guarantee — explicit is clearer for reviewers.
 */
function dedupe(input: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of input) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/**
 * Capture `routes` × `viewports` against `baseUrl`, returning each
 * capture alongside its input route label. Never throws on individual
 * capture failure — the failure is recorded in `skipped[]` and the run
 * continues. Throws only on up-front contract violations (empty routes,
 * missing baseUrl, etc.).
 */
export async function captureRoutes(input: CaptureRoutesInput): Promise<CaptureRoutesResult> {
  const base = normalizeBaseUrl(input.baseUrl);
  if (!input.routes.length) throw new Error("captureRoutes: routes list is empty");
  if (!input.viewports.length) throw new Error("captureRoutes: viewports list is empty");

  const maxCaptures = input.maxCaptures ?? DEFAULT_MAX_CAPTURES;
  const totalBudgetMs = input.totalBudgetMs ?? DEFAULT_TOTAL_BUDGET_MS;
  const perRouteTimeoutMs = input.perRouteTimeoutMs ?? DEFAULT_PER_ROUTE_TIMEOUT_MS;

  const warnings: string[] = [];
  const dedupedRoutes = dedupe(input.routes.map((r) => normalizeRoute(r)));
  if (dedupedRoutes.length !== input.routes.length) {
    warnings.push(
      `captureRoutes: ${input.routes.length - dedupedRoutes.length} duplicate route(s) dropped`,
    );
  }

  // Build the combo list (route × viewport) in input order — row-major:
  // route[0] × viewports, then route[1] × viewports, etc. This keeps related
  // viewport captures adjacent in the output for easier downstream grouping.
  const combos: Array<{ route: string; viewport: ViewportSpec }> = [];
  for (const route of dedupedRoutes) {
    for (const viewport of input.viewports) combos.push({ route, viewport });
  }

  const truncated = combos.length > maxCaptures;
  const activeCombos = combos.slice(0, maxCaptures);
  if (truncated) {
    warnings.push(
      `captureRoutes: ${combos.length} combos requested, capped at maxCaptures=${maxCaptures} (dropped ${combos.length - maxCaptures})`,
    );
  }

  const capture = input.capture ?? new PlaywrightCapture();
  const ownedCapture = !input.capture;

  const startedAt = Date.now();
  const captures: RouteCapture[] = [];
  const skipped: CaptureRoutesResult["skipped"] = [];

  // Record combos we skipped due to truncation as budget-skips so the
  // caller can see what was left out.
  if (truncated) {
    for (const combo of combos.slice(maxCaptures)) {
      skipped.push({
        route: combo.route,
        viewport: combo.viewport.label,
        reason: `max-captures cap (${maxCaptures}) exceeded`,
      });
    }
  }

  try {
    for (const combo of activeCombos) {
      const elapsed = Date.now() - startedAt;
      if (elapsed >= totalBudgetMs) {
        skipped.push({
          route: combo.route,
          viewport: combo.viewport.label,
          reason: `total budget ${totalBudgetMs}ms exhausted after ${captures.length} capture(s)`,
        });
        continue;
      }
      const url = `${base}${combo.route}`;
      const captureOpts: CaptureOptions = {
        ...(input.captureOptions ?? {}),
        width: combo.viewport.width,
        height: combo.viewport.height,
        timeoutMs: perRouteTimeoutMs,
      };
      if (combo.viewport.deviceScaleFactor !== undefined) {
        captureOpts.deviceScaleFactor = combo.viewport.deviceScaleFactor;
      }
      const routeStart = Date.now();
      try {
        const result = await capture.capture(url, captureOpts);
        captures.push({
          route: combo.route,
          viewport: combo.viewport,
          url,
          result,
          durationMs: Date.now() - routeStart,
        });
      } catch (err) {
        skipped.push({
          route: combo.route,
          viewport: combo.viewport.label,
          reason: `capture failed: ${(err as Error).message}`,
        });
      }
    }
  } finally {
    if (ownedCapture) {
      await capture.close().catch(() => {
        /* swallow — close() failures must never hide capture results */
      });
    }
  }

  return {
    captures,
    skipped,
    warnings,
    totalMs: Date.now() - startedAt,
  };
}
