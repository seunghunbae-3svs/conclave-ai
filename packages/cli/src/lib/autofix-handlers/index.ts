import type { Blocker, BlockerFix } from "@conclave-ai/core";
import type { GitLike } from "../autofix-worker.js";
import {
  tryBinaryEncodingFix,
  type BinaryEncodingHandlerDeps,
  type HandlerResult,
} from "./binary-encoding.js";
import { tryMissingImportFix } from "./missing-import.js";
import { tryContrastFix } from "./contrast.js";
import { tryInlineStyleToTailwindFix } from "./inline-style-to-tailwind.js";
import { tryDebugCodeFix } from "./debug-code.js";
import { tryFocusVisibleFix } from "./focus-visible.js";

/**
 * v0.7.3 — autofix special-handler layer.
 *
 * Runs BEFORE the standard worker + `git apply` pipeline. Each handler
 * inspects a blocker and either claims it (returning a `BlockerFix`
 * entry that counts toward the autofix tally) or declines, letting
 * the normal flow run.
 *
 * Intended for blockers that the unified-diff pipeline cannot handle
 * cleanly — e.g. binary-file encoding fixes (see binary-encoding.ts).
 */

export type { HandlerResult } from "./binary-encoding.js";

export interface HandlerDeps {
  cwd: string;
  git: GitLike;
  log?: (msg: string) => void;
  /** Test hooks. */
  readBytes?: (absPath: string) => Promise<Buffer>;
  writeBytes?: (absPath: string, data: Buffer) => Promise<void>;
}

/** A special handler takes a blocker + deps and returns `{ claimed, fix? }`. */
export type SpecialHandler = (
  agent: string,
  blocker: Blocker,
  deps: BinaryEncodingHandlerDeps,
) => Promise<HandlerResult>;

/** Ordered list — first handler to `claimed: true` wins. */
export const SPECIAL_HANDLERS: readonly SpecialHandler[] = [
  tryBinaryEncodingFix,
  // AF-4 — missing-import → no-op stub
  tryMissingImportFix,
  // AF-5 — contrast → AA-safe pair
  tryContrastFix,
  // AF-6 — inline-style drift → strip
  tryInlineStyleToTailwindFix,
  // AF-7/8 — debug-code + dead-code → strip
  tryDebugCodeFix,
  // AF-9 — focus-visible → inject classes
  tryFocusVisibleFix,
];

/**
 * Try each handler in order. Returns the first claim (success or
 * clean failure). Returns `{ claimed: false }` if no handler takes
 * the blocker.
 */
export async function runSpecialHandlers(
  agent: string,
  blocker: Blocker,
  deps: HandlerDeps,
): Promise<HandlerResult> {
  for (const h of SPECIAL_HANDLERS) {
    const deps2: BinaryEncodingHandlerDeps = {
      cwd: deps.cwd,
      git: deps.git,
      ...(deps.log ? { log: deps.log } : {}),
      ...(deps.readBytes ? { readBytes: deps.readBytes } : {}),
      ...(deps.writeBytes ? { writeBytes: deps.writeBytes } : {}),
    };
    const r = await h(agent, blocker, deps2);
    if (r.claimed) return r;
  }
  return { claimed: false };
}

export type { BlockerFix, Blocker } from "@conclave-ai/core";
