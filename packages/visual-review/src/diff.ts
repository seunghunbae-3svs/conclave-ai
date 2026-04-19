import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

export interface DiffOptions {
  /** Pixelmatch threshold (0..1). Lower = stricter. Default 0.1. */
  threshold?: number;
  /** If true, anti-aliased pixels are ignored. Default true. */
  ignoreAntialiasing?: boolean;
  /** Alpha for unchanged pixels in diff image (0..1). Default 0.3. */
  alpha?: number;
  /** Color of different pixels in diff image [R, G, B]. Default [255, 0, 0]. */
  diffColor?: [number, number, number];
}

export interface DiffResult {
  /** Diff PNG image bytes (same dimensions as inputs). */
  diffPng: Uint8Array;
  /** Number of pixels that differ. */
  diffPixels: number;
  /** Total pixels (width × height). */
  totalPixels: number;
  /** diffPixels / totalPixels, 0..1. */
  diffRatio: number;
  /** Resolved dimensions. */
  width: number;
  height: number;
}

export interface VisualDiff {
  readonly id: string;
  diff(before: Uint8Array, after: Uint8Array, opts?: DiffOptions): Promise<DiffResult>;
}

/**
 * PixelmatchDiff — pure-JS pixel comparison using `pixelmatch` + `pngjs`.
 *
 * Handles size mismatch gracefully: canvas padded to the larger of the
 * two with transparent pixels so the diff is computable instead of
 * throwing. Callers inspect `diffRatio` to classify "identical / minor /
 * significant / total rewrite".
 *
 * For Zig/SIMD speed (~6-8×) swap in an `odiff` impl behind this
 * interface — the `VisualDiff` contract stays the same.
 */
export class PixelmatchDiff implements VisualDiff {
  readonly id = "pixelmatch";

  async diff(before: Uint8Array, after: Uint8Array, opts: DiffOptions = {}): Promise<DiffResult> {
    const beforePng = PNG.sync.read(Buffer.from(before));
    const afterPng = PNG.sync.read(Buffer.from(after));

    const width = Math.max(beforePng.width, afterPng.width);
    const height = Math.max(beforePng.height, afterPng.height);

    const beforeCanvas = padToSize(beforePng, width, height);
    const afterCanvas = padToSize(afterPng, width, height);
    const diffCanvas = new PNG({ width, height });

    const threshold = opts.threshold ?? 0.1;
    const ignoreAntialiasing = opts.ignoreAntialiasing ?? true;
    const alpha = opts.alpha ?? 0.3;
    const diffColor = opts.diffColor ?? [255, 0, 0];

    const diffPixels = pixelmatch(
      beforeCanvas.data,
      afterCanvas.data,
      diffCanvas.data,
      width,
      height,
      {
        threshold,
        includeAA: !ignoreAntialiasing,
        alpha,
        diffColor,
      },
    );

    const diffPngBuf = PNG.sync.write(diffCanvas);
    const totalPixels = width * height;
    return {
      diffPng: new Uint8Array(diffPngBuf),
      diffPixels,
      totalPixels,
      diffRatio: totalPixels === 0 ? 0 : diffPixels / totalPixels,
      width,
      height,
    };
  }
}

function padToSize(source: PNG, targetWidth: number, targetHeight: number): PNG {
  if (source.width === targetWidth && source.height === targetHeight) return source;
  const padded = new PNG({ width: targetWidth, height: targetHeight });
  // Opaque magenta (255,0,255,255) — pixelmatch blends transparent pixels with a
  // white background, so `fill(0)` would read as white and collapse to zero diff.
  // Opaque magenta is unlikely to appear in real UI and registers as a real diff.
  for (let i = 0; i < padded.data.length; i += 4) {
    padded.data[i] = 255;
    padded.data[i + 1] = 0;
    padded.data[i + 2] = 255;
    padded.data[i + 3] = 255;
  }
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const sIdx = (source.width * y + x) << 2;
      const dIdx = (targetWidth * y + x) << 2;
      padded.data[dIdx] = source.data[sIdx] ?? 0;
      padded.data[dIdx + 1] = source.data[sIdx + 1] ?? 0;
      padded.data[dIdx + 2] = source.data[sIdx + 2] ?? 0;
      padded.data[dIdx + 3] = source.data[sIdx + 3] ?? 0;
    }
  }
  return padded;
}

/**
 * Classify a diff ratio into a coarse severity label — used by the
 * orchestrator to decide whether to surface the visual change in the
 * review output or ignore it.
 */
export function classifyDiffRatio(ratio: number): "identical" | "minor" | "significant" | "major" | "total-rewrite" {
  if (ratio < 0.0005) return "identical";       // <0.05% changed
  if (ratio < 0.01) return "minor";              // <1%
  if (ratio < 0.10) return "significant";        // <10%
  if (ratio < 0.50) return "major";              // <50%
  return "total-rewrite";
}
