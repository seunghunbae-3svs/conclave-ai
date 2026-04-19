import type { Platform } from "@ai-conclave/core";

export type PlatformId = "vercel" | "netlify" | "cloudflare" | "railway" | "deployment-status";

export interface PlatformFactoryResult {
  platforms: Platform[];
  skipped: Array<{ id: PlatformId; reason: string }>;
}

/**
 * Instantiate platform adapters in the order given, skipping any whose
 * credentials are missing rather than throwing. Returns the live
 * platforms + a list of skipped ones for caller-side reporting.
 *
 * Isolated in its own module so review.ts can import + test it without
 * dragging the whole review command into the unit tests.
 */
export async function buildPlatforms(
  ids: readonly PlatformId[],
): Promise<PlatformFactoryResult> {
  const platforms: Platform[] = [];
  const skipped: PlatformFactoryResult["skipped"] = [];

  for (const id of ids) {
    switch (id) {
      case "vercel": {
        if (!process.env["VERCEL_TOKEN"]) {
          skipped.push({ id, reason: "VERCEL_TOKEN not set" });
          continue;
        }
        const mod = await import("@ai-conclave/platform-vercel");
        try {
          platforms.push(new mod.VercelPlatform());
        } catch (err) {
          skipped.push({ id, reason: (err as Error).message });
        }
        break;
      }
      case "netlify": {
        if (!process.env["NETLIFY_TOKEN"] || !process.env["NETLIFY_SITE_ID"]) {
          skipped.push({ id, reason: "NETLIFY_TOKEN or NETLIFY_SITE_ID not set" });
          continue;
        }
        const mod = await import("@ai-conclave/platform-netlify");
        try {
          platforms.push(new mod.NetlifyPlatform());
        } catch (err) {
          skipped.push({ id, reason: (err as Error).message });
        }
        break;
      }
      case "cloudflare": {
        if (
          !process.env["CLOUDFLARE_API_TOKEN"] ||
          !process.env["CLOUDFLARE_ACCOUNT_ID"] ||
          !process.env["CLOUDFLARE_PROJECT_NAME"]
        ) {
          skipped.push({ id, reason: "CLOUDFLARE_API_TOKEN / ACCOUNT_ID / PROJECT_NAME not set" });
          continue;
        }
        const mod = await import("@ai-conclave/platform-cloudflare");
        try {
          platforms.push(new mod.CloudflarePlatform());
        } catch (err) {
          skipped.push({ id, reason: (err as Error).message });
        }
        break;
      }
      case "railway": {
        if (!process.env["RAILWAY_API_TOKEN"] || !process.env["RAILWAY_PROJECT_ID"]) {
          skipped.push({ id, reason: "RAILWAY_API_TOKEN or RAILWAY_PROJECT_ID not set" });
          continue;
        }
        const mod = await import("@ai-conclave/platform-railway");
        try {
          platforms.push(new mod.RailwayPlatform());
        } catch (err) {
          skipped.push({ id, reason: (err as Error).message });
        }
        break;
      }
      case "deployment-status": {
        // No env vars — uses gh CLI auth. Always try to add.
        const mod = await import("@ai-conclave/platform-deployment-status");
        try {
          platforms.push(new mod.DeploymentStatusPlatform());
        } catch (err) {
          skipped.push({ id, reason: (err as Error).message });
        }
        break;
      }
    }
  }

  return { platforms, skipped };
}
