export interface PreviewResolution {
  url: string;
  provider: string;
  /** SHA the preview corresponds to. Not always == input (platform rounding / redirects). */
  sha: string;
  /** Platform-specific deployment id, when available. */
  deploymentId?: string;
  /** UTC ISO timestamp of deployment creation. */
  createdAt?: string;
}

export interface ResolvePreviewInput {
  /** owner/repo slug. */
  repo: string;
  sha: string;
  /** Optional platform hint — adapters can use it to filter by project name. */
  projectHint?: string;
  /** Max seconds to wait for a ready deployment. Default varies per adapter. */
  waitSeconds?: number;
}

/**
 * Platform — pluggable adapter for resolving a PR's preview URL from
 * its commit SHA.
 *
 * Decision #31 locks the v2.0 platform set at Vercel / Netlify /
 * Railway / Cloudflare Pages / `deployment-status` (generic GitHub
 * event). v2.1 adds Render / Fly / Replit / Vertex / Docker-local.
 *
 * Contract:
 *   - `id`: stable string used for config routing + metrics tagging.
 *   - `resolve(...)`: returns a single best-match preview; null when
 *     no preview exists OR auth is missing (do NOT throw — return
 *     null so the caller can fall back cleanly to the next adapter).
 *   - Throws only on HARD errors: invalid auth, network 5xx after
 *     retries. 404s and missing-deployment return null.
 *   - Implementations MUST NOT call LLM APIs.
 */
export interface Platform {
  readonly id: string;
  readonly displayName: string;
  resolve(input: ResolvePreviewInput): Promise<PreviewResolution | null>;
}

/**
 * Walk an ordered list of platform adapters until one resolves a preview
 * URL. First non-null wins. Useful when a repo ships to multiple hosts
 * simultaneously (staging on Vercel + prod on Cloudflare, etc.).
 */
export async function resolveFirstPreview(
  platforms: readonly Platform[],
  input: ResolvePreviewInput,
): Promise<PreviewResolution | null> {
  for (const p of platforms) {
    try {
      const out = await p.resolve(input);
      if (out) return out;
    } catch (err) {
      // Hard error on one platform is not fatal if another might succeed.
      // Surface it via stderr so the caller knows, but continue.
      process.stderr.write(
        `[platform:${p.id}] resolve failed — ${(err as Error).message}\n`,
      );
    }
  }
  return null;
}
