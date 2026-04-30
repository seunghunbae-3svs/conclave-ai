/**
 * UX-10 / self-evolve — fire-and-forget autoPull of the federated
 * baseline at `conclave review` start.
 *
 * Pre-this, federated learning was opt-in AND required a manual
 * `conclave sync` to refresh — 99% of installs never ran it, so the
 * federation flywheel never spun. With autoPull on by default, every
 * install passively pulls the aggregated baseline that ALL other
 * installs have shaped, and benefits from it during retrieval rerank.
 *
 * Privacy: pull is anonymous — no user identity, no repo slug, no
 * diff content sent or returned. Wire format documented in
 * docs/federated-sync.md.
 *
 * This helper:
 *   1. checks the cache age — if fresher than maxAgeMs, skip
 *   2. constructs HttpFederatedSyncTransport
 *   3. pulls baselines, writes to FileSystemFederatedBaselineStore
 *   4. swallows ALL errors — pull failure must NOT kill review
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  FileSystemFederatedBaselineStore,
  HttpFederatedSyncTransport,
  runFederatedSync,
  FileSystemMemoryStore,
} from "@conclave-ai/core";

export interface AutoPullArgs {
  /** Repo cwd, used to resolve memoryRoot. */
  cwd: string;
  /** Central plane endpoint. Skipped (no-op) when undefined. */
  endpoint?: string;
  /** CONCLAVE_TOKEN. Skipped (no-op) when undefined. */
  token?: string;
  /**
   * Skip the pull if the cache is younger than this. Lets review
   * runs that fire frequently (e.g., a back-to-back PR push) avoid
   * hammering the central plane.
   */
  maxAgeMs: number;
  /**
   * The baseline store to write the pulled result into. Caller passes
   * its already-constructed instance so cache-read consistency is
   * obvious.
   */
  baselineStore: FileSystemFederatedBaselineStore;
  /** Path to the baselines cache file (for mtime check). */
  baselineCachePath?: string;
}

async function fileMtimeMs(filePath: string): Promise<number | null> {
  try {
    const st = await fs.stat(filePath);
    return st.mtimeMs;
  } catch {
    return null;
  }
}

export async function autoPullFederatedBaselineInBackground(args: AutoPullArgs): Promise<void> {
  try {
    if (!args.endpoint) return;
    if (!args.token) return;
    // Cache-age gate: read mtime of the cache file. If fresh, skip.
    if (args.baselineCachePath) {
      const m = await fileMtimeMs(args.baselineCachePath);
      if (m !== null && Date.now() - m < args.maxAgeMs) return;
    }
    const transport = new HttpFederatedSyncTransport({
      endpoint: args.endpoint,
      apiToken: args.token,
    });
    // Pull-only sync: pass the loaded answer-keys/failures (so push
    // path is a no-op without contributing data) but disable push
    // explicitly. We don't need the actual lists for a pull-only run,
    // but the runFederatedSync API requires them.
    const memoryStore = new FileSystemMemoryStore({
      root: path.join(args.cwd, ".conclave"),
    });
    const answerKeys = await memoryStore.listAnswerKeys().catch(() => []);
    const failures = await memoryStore.listFailures().catch(() => []);
    const result = await runFederatedSync({
      transport,
      answerKeys,
      failures,
      pushDisabled: true,
    });
    if (result.pulled.length > 0) {
      await args.baselineStore.write(result.pulled);
    }
  } catch (err) {
    process.stderr.write(
      `conclave review: federated autoPull failed (non-fatal) — ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}
