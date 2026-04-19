export { PlaywrightCapture } from "./capture.js";
export type {
  CaptureOptions,
  CaptureResult,
  ScreenshotCapture,
  PlaywrightLike,
  PlaywrightBrowser,
  PlaywrightContext,
  PlaywrightPage,
  PlaywrightCaptureOptions,
} from "./capture.js";

export { PixelmatchDiff, classifyDiffRatio } from "./diff.js";
export type { DiffOptions, DiffResult, VisualDiff } from "./diff.js";

export { runVisualReview } from "./orchestrator.js";
export type { VisualReviewInput, VisualReviewResult } from "./orchestrator.js";
