/**
 * Design system baseline — load, save, and match stored screenshots
 * for `conclave review --visual --capture-baseline`.
 *
 * Baselines live in `<configDir>/.conclave/design/baseline/` as PNG files
 * named after the route they represent. When a review runs with visual
 * capture, after-screenshots are paired with stored baselines to produce
 * `ReviewContext.designBaselineDrift` pairs that DesignAgent uses to
 * surface color-token mismatch, layout regression, contrast changes, and
 * cropped text relative to the golden design system state.
 *
 * Naming convention:
 *   route "/"              → "root.png"
 *   route "/login"         → "login.png"
 *   route "/login@mobile"  → "login@mobile.png"
 *   route "/a/b"           → "a_b.png"
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { VisualArtifact } from "./visual-capture.js";

const BASELINE_SUBDIR = path.join(".conclave", "design", "baseline");

export interface BaselineMatch {
  route: string;
  baseline: Buffer;
  after: Buffer;
}

/**
 * Convert a route string to a safe PNG filename.
 *   "/"           → "root.png"
 *   "/login"      → "login.png"
 *   "/login@mobile" → "login@mobile.png"
 *   "/a/b"        → "a_b.png"
 */
export function routeToFilename(route: string): string {
  const trimmed = route.startsWith("/") ? route.slice(1) : route;
  const safe = trimmed.replace(/\//g, "_");
  return `${safe || "root"}.png`;
}

/**
 * Save the current "after" captures as the new design system baseline.
 * Writes one PNG per artifact to `<configDir>/.conclave/design/baseline/`.
 * Silently overwrites existing files — the caller is responsible for
 * confirming intent (e.g. `--capture-baseline` flag was explicitly passed).
 */
export async function saveDesignBaseline(
  configDir: string,
  artifacts: VisualArtifact[],
): Promise<{ saved: string[] }> {
  const baselineDir = path.join(configDir, BASELINE_SUBDIR);
  await fs.mkdir(baselineDir, { recursive: true });
  const saved: string[] = [];
  for (const art of artifacts) {
    const filename = routeToFilename(art.route);
    const bytes = Buffer.isBuffer(art.after) ? art.after : Buffer.from(art.after);
    await fs.writeFile(path.join(baselineDir, filename), bytes);
    saved.push(filename);
  }
  return { saved };
}

/**
 * For each artifact, check if a baseline PNG exists for its route.
 * Returns matched (baseline, after) pairs for routes that have a stored
 * baseline; routes with no baseline are silently skipped so the caller
 * never needs to handle a "partial" error.
 *
 * Errors other than ENOENT (e.g. read permission failure) propagate.
 */
export async function matchBaselinesToArtifacts(
  configDir: string,
  artifacts: VisualArtifact[],
): Promise<BaselineMatch[]> {
  const baselineDir = path.join(configDir, BASELINE_SUBDIR);
  const matches: BaselineMatch[] = [];
  for (const art of artifacts) {
    const filepath = path.join(baselineDir, routeToFilename(art.route));
    try {
      const baseline = await fs.readFile(filepath);
      const after = Buffer.isBuffer(art.after) ? art.after : Buffer.from(art.after);
      matches.push({ route: art.route, baseline, after });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return matches;
}
