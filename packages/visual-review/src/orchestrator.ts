import { promises as fs } from "node:fs";
import path from "node:path";
import type { Platform, PreviewResolution } from "@ai-conclave/core";
import { resolveFirstPreview } from "@ai-conclave/core";
import {
  PlaywrightCapture,
  type CaptureOptions,
  type CaptureResult,
  type ScreenshotCapture,
} from "./capture.js";
import { PixelmatchDiff, classifyDiffRatio, type DiffOptions, type DiffResult, type VisualDiff } from "./diff.js";

export interface VisualReviewInput {
  repo: string;
  beforeSha: string;
  afterSha: string;
  /** Ordered platforms to try for URL resolution. First non-null wins. */
  platforms: readonly Platform[];
  /** Directory to write PNGs under. Defaults to `.conclave/visual/<afterSha>/`. */
  outputDir?: string;
  /** Override capture + diff engines. */
  capture?: ScreenshotCapture;
  diff?: VisualDiff;
  /** Capture options (viewport / timeouts / etc.). */
  captureOptions?: CaptureOptions;
  /** Diff options (threshold / anti-alias handling). */
  diffOptions?: DiffOptions;
  /** Poll preview URL resolution up to N seconds. Default 0 (single try per platform). */
  waitSeconds?: number;
}

export interface VisualReviewResult {
  /** Resolved preview URLs + provider metadata. */
  before: PreviewResolution;
  after: PreviewResolution;
  /** Local paths (absolute) to the saved PNGs. */
  paths: { before: string; after: string; diff: string };
  /** Captured viewport + final URLs after redirect. */
  captures: { before: CaptureResult; after: CaptureResult };
  /** Raw diff metrics. */
  diff: DiffResult;
  /** Coarse severity label. */
  severity: ReturnType<typeof classifyDiffRatio>;
}

/**
 * Run a full visual review — resolve URLs for both SHAs, capture both,
 * diff them, write PNGs to disk. Returns structured result for the
 * caller (CLI review command, Telegram/Discord notifier, etc.).
 *
 * Design:
 *   - Platform resolution is best-effort. If EITHER before or after URL
 *     can't be resolved, the whole review throws a specific error —
 *     the caller is expected to log + skip, not propagate blame onto
 *     the code review.
 *   - Captures are sequential (single browser instance, two pages).
 *     Fresh context per capture for isolation.
 *   - Diff runs after both captures land. Size-mismatched images pad to
 *     the larger dimensions (see `diff.ts`) — no throw.
 *   - PNGs written to `<outputDir>/(before|after|diff).png`.
 */
export async function runVisualReview(input: VisualReviewInput): Promise<VisualReviewResult> {
  const beforeRes = await resolveFirstPreview(input.platforms, {
    repo: input.repo,
    sha: input.beforeSha,
    waitSeconds: input.waitSeconds ?? 0,
  });
  if (!beforeRes) {
    throw new Error(
      `visual-review: no preview URL found for beforeSha=${input.beforeSha} across ${input.platforms.length} platform(s)`,
    );
  }
  const afterRes = await resolveFirstPreview(input.platforms, {
    repo: input.repo,
    sha: input.afterSha,
    waitSeconds: input.waitSeconds ?? 0,
  });
  if (!afterRes) {
    throw new Error(
      `visual-review: no preview URL found for afterSha=${input.afterSha} across ${input.platforms.length} platform(s)`,
    );
  }

  const capture = input.capture ?? new PlaywrightCapture();
  try {
    const beforeCap = await capture.capture(beforeRes.url, input.captureOptions);
    const afterCap = await capture.capture(afterRes.url, input.captureOptions);

    const diff = input.diff ?? new PixelmatchDiff();
    const diffResult = await diff.diff(beforeCap.png, afterCap.png, input.diffOptions);

    const outDir = path.resolve(input.outputDir ?? path.join(".conclave", "visual", input.afterSha));
    await fs.mkdir(outDir, { recursive: true });
    const beforePath = path.join(outDir, "before.png");
    const afterPath = path.join(outDir, "after.png");
    const diffPath = path.join(outDir, "diff.png");
    await fs.writeFile(beforePath, beforeCap.png);
    await fs.writeFile(afterPath, afterCap.png);
    await fs.writeFile(diffPath, diffResult.diffPng);

    return {
      before: beforeRes,
      after: afterRes,
      paths: { before: beforePath, after: afterPath, diff: diffPath },
      captures: { before: beforeCap, after: afterCap },
      diff: diffResult,
      severity: classifyDiffRatio(diffResult.diffRatio),
    };
  } finally {
    // Close only if WE created the capture; user-supplied instances are their responsibility.
    if (!input.capture) await capture.close();
  }
}
