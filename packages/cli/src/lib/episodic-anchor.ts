import type { EpisodicEntry } from "@conclave-ai/core";

/**
 * v0.12.x — anchor an episodic in central plane so CI rework can fetch
 * it when the local store doesn't have it.
 *
 * Closes Bug A from v0.11: local-run `conclave review` writes the
 * episodic to `.conclave/episodic/...` on the developer's machine
 * only. The autonomy loop then dispatches `conclave-rework` on the
 * consumer repo, where the CI runner has no idea about the local
 * file. The dispatched workflow exits 1 with `episodic ... not found
 * in store`.
 *
 * The fix is split across two seams:
 *   1. `pushEpisodicAnchor` — called from `conclave review` after
 *      `OutcomeWriter.writeReview` succeeds. Best-effort: a failure
 *      here logs to stderr and returns; we never want a sync hiccup
 *      to fail an otherwise-successful review.
 *   2. `fetchEpisodicAnchor` — called from `conclave rework` ONLY
 *      when the local `store.findEpisodic` lookup misses. Returns
 *      the episodic JSON if anchored; null otherwise (so rework
 *      surfaces the original "not found" error if the anchor service
 *      also doesn't have it).
 *
 * Auth: same Bearer install-token (`CONCLAVE_TOKEN`) that
 * `/review/notify` uses. When the env var isn't set, both functions
 * silently no-op + return null — the v0.3-compat direct path doesn't
 * have a central plane to push to, and that's fine.
 */

const DEFAULT_CENTRAL_URL = "https://conclave-ai.seunghunbae.workers.dev";

export interface AnchorPushDeps {
  /** Test seam — production uses globalThis.fetch. */
  fetch?: typeof fetch;
  /** Override central URL (tests + self-hosted plane). */
  centralUrl?: string;
  /** Logger sink — defaults to stderr. */
  log?: (msg: string) => void;
}

function resolveCentralUrl(opts: AnchorPushDeps | undefined): string | null {
  const raw = opts?.centralUrl ?? process.env["CONCLAVE_CENTRAL_URL"] ?? "";
  const trimmed = raw.trim();
  if (trimmed.length > 0) return trimmed.replace(/\/$/, "");
  return DEFAULT_CENTRAL_URL.replace(/\/$/, "");
}

function resolveToken(): string | null {
  // Read process.env directly — the CLI's hydrateEnvFromStorage runs at
  // startup and fills env from `~/.conclave/credentials.json` when the
  // env var isn't already set, so by the time this helper runs, env IS
  // the source of truth. Going through resolveKey() here would re-load
  // the storage in tests that explicitly want CONCLAVE_TOKEN absent.
  const t = (process.env["CONCLAVE_TOKEN"] ?? "").trim();
  return t.length > 0 ? t : null;
}

/**
 * Push the full episodic JSON to central plane. Best-effort — failures
 * log + return false so callers can keep going.
 */
export async function pushEpisodicAnchor(
  episodic: EpisodicEntry,
  deps: AnchorPushDeps = {},
): Promise<{ ok: boolean; reason?: string }> {
  const log = deps.log ?? ((m: string) => process.stderr.write(m + "\n"));
  const token = resolveToken();
  if (!token) {
    return { ok: false, reason: "CONCLAVE_TOKEN not set — skipping anchor (v0.3-compat direct mode)" };
  }
  const url = resolveCentralUrl(deps);
  if (!url) {
    return { ok: false, reason: "no central URL resolvable" };
  }
  const fetchFn = deps.fetch ?? (globalThis.fetch as typeof fetch);
  const body = JSON.stringify({
    episodic_id: episodic.id,
    repo_slug: episodic.repo,
    pr_number: episodic.pullNumber ?? null,
    payload: episodic,
  });
  try {
    const resp = await fetchFn(`${url}/episodic/anchor`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      log(
        `conclave review: episodic anchor push failed — HTTP ${resp.status}: ${text.slice(0, 300)}`,
      );
      return { ok: false, reason: `HTTP ${resp.status}` };
    }
    return { ok: true };
  } catch (err) {
    log(`conclave review: episodic anchor push errored — ${(err as Error).message}`);
    return { ok: false, reason: (err as Error).message };
  }
}

/**
 * Fetch a previously-anchored episodic from central plane. Returns the
 * payload object on hit, null on any miss (404, no token, network error
 * — the rework caller falls back to the original local-store error
 * message).
 */
export async function fetchEpisodicAnchor(
  episodicId: string,
  deps: AnchorPushDeps = {},
): Promise<EpisodicEntry | null> {
  const log = deps.log ?? ((m: string) => process.stderr.write(m + "\n"));
  const token = resolveToken();
  if (!token) return null;
  const url = resolveCentralUrl(deps);
  if (!url) return null;
  const fetchFn = deps.fetch ?? (globalThis.fetch as typeof fetch);
  try {
    const resp = await fetchFn(
      `${url}/episodic/anchor/${encodeURIComponent(episodicId)}`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
      },
    );
    if (resp.status === 404) return null;
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      log(
        `conclave rework: episodic anchor fetch failed — HTTP ${resp.status}: ${text.slice(0, 300)}`,
      );
      return null;
    }
    const json = (await resp.json().catch(() => null)) as
      | { payload?: unknown; payload_raw?: string }
      | null;
    if (!json) return null;
    if (json.payload && typeof json.payload === "object") {
      return json.payload as EpisodicEntry;
    }
    if (typeof json.payload_raw === "string") {
      try {
        return JSON.parse(json.payload_raw) as EpisodicEntry;
      } catch {
        return null;
      }
    }
    return null;
  } catch (err) {
    log(`conclave rework: episodic anchor fetch errored — ${(err as Error).message}`);
    return null;
  }
}
