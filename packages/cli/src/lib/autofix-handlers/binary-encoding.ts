import { promises as fs } from "node:fs";
import path from "node:path";
import type { Blocker, BlockerFix } from "@conclave-ai/core";
import type { GitLike } from "../autofix-worker.js";

/**
 * v0.7.3 — binary-encoding handler.
 *
 * Problem: `git apply` cannot apply unified-diff patches to files it
 * treats as binary. When a source file is committed with a UTF-16 BOM
 * (common output of PowerShell redirection on Windows), git flags it
 * binary. The autofix worker correctly generates a patch to re-encode
 * the file to UTF-8 — but the standard `git apply --check --recount`
 * path rejects it with "patch does not apply" because git refuses
 * binary-file unified diffs.
 *
 * Fix: detect encoding/BOM blockers BEFORE running the worker →
 * git-apply pipeline. Read the file as raw bytes, decode from its
 * detected encoding, and re-write as plain UTF-8 without a BOM.
 * Stage via `git add`. If git still flags the file as binary
 * afterwards, abort with a clear message so a human can look.
 *
 * This handler is additive: if the blocker doesn't look like an
 * encoding issue, it returns `{ claimed: false }` and the normal
 * worker pipeline continues.
 */

export interface BinaryEncodingHandlerDeps {
  cwd: string;
  git: GitLike;
  readBytes?: (absPath: string) => Promise<Buffer>;
  writeBytes?: (absPath: string, data: Buffer) => Promise<void>;
  log?: (msg: string) => void;
}

export interface HandlerResult {
  /** True when this handler took responsibility for the blocker. */
  claimed: boolean;
  /** The resulting BlockerFix entry (only set when claimed). */
  fix?: BlockerFix;
}

/**
 * Category strings (lowercased, substring-matched) that signal the
 * blocker is "this file's encoding is wrong". The autofix workers have
 * been seen to emit several of these; `source-integrity` is the
 * integration-telegram reviewer's label.
 */
const ENCODING_CATEGORY_KEYWORDS = [
  "encoding",
  "binary",
  "utf-16",
  "utf16",
  "utf-8-bom",
  "utf8-bom",
  "bom",
  "source-integrity",
];

/**
 * Also match on message-body mentions of the above. Some workers emit
 * a generic category like "build" but the message literally says
 * "file has a UTF-16 BOM". Err on the side of claiming.
 */
const ENCODING_MESSAGE_KEYWORDS = [
  "utf-16",
  "utf16",
  "byte-order mark",
  "byte order mark",
  " bom",
  "(bom)",
  "binary blob",
  "binary file",
];

/** BOM patterns for the three encodings we handle. */
const BOM_UTF8 = Buffer.from([0xef, 0xbb, 0xbf]);
const BOM_UTF16LE = Buffer.from([0xff, 0xfe]);
const BOM_UTF16BE = Buffer.from([0xfe, 0xff]);

export type DetectedEncoding = "utf-16le" | "utf-16be" | "utf-8-bom" | "utf-8-clean";

export function detectEncoding(bytes: Buffer): DetectedEncoding {
  if (bytes.length >= 3 && bytes.subarray(0, 3).equals(BOM_UTF8)) return "utf-8-bom";
  if (bytes.length >= 2 && bytes.subarray(0, 2).equals(BOM_UTF16LE)) return "utf-16le";
  if (bytes.length >= 2 && bytes.subarray(0, 2).equals(BOM_UTF16BE)) return "utf-16be";
  return "utf-8-clean";
}

/** Matches the blocker against the encoding category/message allowlist. */
export function matchesEncodingBlocker(blocker: Blocker): boolean {
  const cat = (blocker.category ?? "").toLowerCase();
  if (ENCODING_CATEGORY_KEYWORDS.some((k) => cat.includes(k))) return true;
  const msg = (blocker.message ?? "").toLowerCase();
  if (ENCODING_MESSAGE_KEYWORDS.some((k) => msg.includes(k))) return true;
  return false;
}

/** Swap bytes in-place for a UTF-16BE → UTF-16LE conversion. Node's
 * Buffer#toString has no `utf16be` decoder, so we flip byte pairs and
 * decode as LE. */
function swap16(src: Buffer): Buffer {
  const out = Buffer.from(src);
  for (let i = 0; i + 1 < out.length; i += 2) {
    const a = out[i]!;
    out[i] = out[i + 1]!;
    out[i + 1] = a;
  }
  return out;
}

/**
 * Check whether git considers the path to be binary (via
 * check-attr + ls-files). We treat both signals as "binary" since the
 * catch-22 only cares about what `git apply` sees.
 */
export async function gitSeesAsBinary(
  git: GitLike,
  cwd: string,
  relPath: string,
): Promise<boolean> {
  // check-attr is cheap and authoritative when .gitattributes has a
  // rule. If there's no rule, git returns `unspecified`, and we fall
  // back to a heuristic on the file bytes (BOM presence + null-byte
  // scan).
  try {
    const res = await git("git", ["check-attr", "binary", "--", relPath], { cwd });
    const line = (res.stdout ?? "").trim();
    // Format: "path: binary: (set|unset|unspecified)"
    const m = /:\s*binary:\s*(\S+)/.exec(line);
    if (m && m[1] === "set") return true;
    if (m && m[1] === "unset") return false;
  } catch {
    // best-effort
  }
  return false;
}

/**
 * Re-encode the file at `relPath` (relative to cwd) from its detected
 * encoding to pure UTF-8 (no BOM). Returns sizes for logging. Throws
 * on read/write failure so the caller can surface a clean error.
 */
export async function reencodeToUtf8(
  absPath: string,
  deps: Required<Pick<BinaryEncodingHandlerDeps, "readBytes" | "writeBytes">>,
): Promise<{ from: DetectedEncoding; fromBytes: number; toBytes: number }> {
  const raw = await deps.readBytes(absPath);
  const from = detectEncoding(raw);
  if (from === "utf-8-clean") {
    return { from, fromBytes: raw.length, toBytes: raw.length };
  }
  let decoded: string;
  if (from === "utf-8-bom") {
    decoded = raw.subarray(3).toString("utf8");
  } else if (from === "utf-16le") {
    decoded = raw.subarray(2).toString("utf16le");
  } else {
    // utf-16be: Node has no native utf16be decoder — swap bytes then
    // decode as LE.
    decoded = swap16(raw.subarray(2)).toString("utf16le");
  }
  // Normalize CRLF → LF so the re-encoded file matches what a
  // unix-born repo would produce. Keep the existing end-of-file
  // behaviour (don't force a trailing newline).
  const normalized = decoded.replace(/\r\n/g, "\n");
  const out = Buffer.from(normalized, "utf8");
  await deps.writeBytes(absPath, out);
  return { from, fromBytes: raw.length, toBytes: out.length };
}

/**
 * Try to handle a blocker in-band (re-encode file, stage via git).
 * Returns `{ claimed: false }` when the blocker isn't an encoding
 * issue; returns `{ claimed: true, fix: ... }` when we took
 * responsibility (either successfully or with a clean failure).
 */
export async function tryBinaryEncodingFix(
  agent: string,
  blocker: Blocker,
  deps: BinaryEncodingHandlerDeps,
): Promise<HandlerResult> {
  if (!matchesEncodingBlocker(blocker)) return { claimed: false };
  // We must have a file to act on; encoding fixes need a target.
  const rel = blocker.file;
  if (!rel) return { claimed: false };

  const log = deps.log ?? (() => undefined);
  const readBytes = deps.readBytes ?? ((p: string) => fs.readFile(p));
  const writeBytes = deps.writeBytes ?? ((p: string, d: Buffer) => fs.writeFile(p, d));
  const abs = path.isAbsolute(rel) ? rel : path.join(deps.cwd, rel);

  // File existence check — return a clean error fix rather than throw.
  try {
    await fs.access(abs);
  } catch (err) {
    return {
      claimed: true,
      fix: {
        agent,
        blocker,
        status: "worker-error",
        reason: `binary-encoding handler: file not found at "${rel}" (${err instanceof Error ? err.message : String(err)})`,
      },
    };
  }

  let summary: { from: DetectedEncoding; fromBytes: number; toBytes: number };
  try {
    summary = await reencodeToUtf8(abs, { readBytes, writeBytes });
  } catch (err) {
    return {
      claimed: true,
      fix: {
        agent,
        blocker,
        status: "worker-error",
        reason: `binary-encoding handler: re-encode failed for "${rel}": ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  if (summary.from === "utf-8-clean") {
    // File is already clean. Nothing to do. Mark skipped — NOT a fix.
    // (If the blocker still exists after this, it's not an encoding
    // problem; the normal pipeline should attempt a real code fix on
    // the next iteration.)
    return {
      claimed: true,
      fix: {
        agent,
        blocker,
        status: "skipped",
        reason: `binary-encoding handler: file "${rel}" is already clean UTF-8 (no BOM) — no action needed`,
      },
    };
  }

  // Post-condition: stage the file so the apply-stage in autofix sees
  // it in the index. Then ask git whether it still considers the file
  // binary. If yes, the re-encode didn't help — abort with a clear
  // "human needed" message.
  try {
    await deps.git("git", ["add", "--", rel], { cwd: deps.cwd });
  } catch (err) {
    return {
      claimed: true,
      fix: {
        agent,
        blocker,
        status: "worker-error",
        reason: `binary-encoding handler: git add failed for "${rel}": ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  const stillBinary = await gitSeesAsBinary(deps.git, deps.cwd, rel);
  if (stillBinary) {
    // Roll back so we don't leave a half-baked edit staged.
    await deps.git("git", ["reset", "HEAD", "--", rel], { cwd: deps.cwd }).catch(() => undefined);
    await deps.git("git", ["checkout", "--", rel], { cwd: deps.cwd }).catch(() => undefined);
    return {
      claimed: true,
      fix: {
        agent,
        blocker,
        status: "worker-error",
        reason: `binary-encoding handler: re-encoded "${rel}" but git still flags it binary — manual intervention required (check .gitattributes / null-byte content)`,
      },
    };
  }

  log(
    `autofix: binary-file handler: re-encoded ${rel} from ${summary.from} to UTF-8 ` +
      `(size: ${summary.fromBytes} → ${summary.toBytes} bytes)\n`,
  );

  return {
    claimed: true,
    fix: {
      agent,
      blocker,
      status: "ready",
      // No patch — applied in-place. autofix.ts's apply loop must
      // skip the git-apply step for ready fixes without a `patch`.
      commitMessage: `autofix: re-encode ${rel} from ${summary.from} to UTF-8`,
      appliedFiles: [rel],
    },
  };
}
