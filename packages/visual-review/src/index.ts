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

export { OdiffDiff } from "./odiff-diff.js";
export type { OdiffAdapterOptions } from "./odiff-diff.js";

export { runVisualReview } from "./orchestrator.js";
export type { VisualReviewInput, VisualReviewResult } from "./orchestrator.js";

export { ClaudeVisionJudge } from "./judge.js";
export type {
  VisionJudge,
  VisualJudgment,
  VisualJudgmentCategory,
  VisualConcern,
  VisionJudgeContext,
  ClaudeVisionJudgeOptions,
  AnthropicVisionLike,
  AnthropicVisionParams,
  AnthropicVisionResponse,
} from "./judge.js";
