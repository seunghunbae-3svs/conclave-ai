import type { Platform, PreviewResolution, ResolvePreviewInput } from "@ai-conclave/core";

export interface HttpFetch {
  (url: string, init: { method: string; headers: Record<string, string> }): Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
    text: () => Promise<string>;
  }>;
}

export interface VercelAdapterOptions {
  token?: string;
  /** Vercel team id (required for team projects). */
  teamId?: string;
  /** Project id or name filter — when set, only deployments for this project are considered. */
  projectId?: string;
  /** Override base URL for tests. */
  baseUrl?: string;
  /** Default wait seconds when caller doesn't specify. Default 0 (no wait — return null if not ready). */
  waitSeconds?: number;
  fetch?: HttpFetch;
}

interface VercelDeployment {
  uid?: string;
  url?: string;
  state?: string;
  readyState?: string;
  created?: number;
  meta?: { githubCommitSha?: string; githubOrg?: string; githubRepo?: string };
}

/**
 * VercelPlatform — resolves the preview URL for a given (repo, sha).
 *
 * Uses the Vercel REST API `/v6/deployments` endpoint filtered by
 * `meta-githubCommitSha`. Returns the newest READY deployment whose
 * commit SHA matches; otherwise null.
 *
 * Env:
 *   VERCEL_TOKEN      — required
 *   VERCEL_TEAM_ID    — optional (for team-scoped projects)
 *   VERCEL_PROJECT_ID — optional (filter to a specific project)
 */
export class VercelPlatform implements Platform {
  readonly id = "vercel";
  readonly displayName = "Vercel";

  private readonly token: string;
  private readonly teamId: string | undefined;
  private readonly projectId: string | undefined;
  private readonly baseUrl: string;
  private readonly waitSeconds: number;
  private readonly fetchFn: HttpFetch;

  constructor(opts: VercelAdapterOptions = {}) {
    const token = opts.token ?? process.env["VERCEL_TOKEN"] ?? "";
    if (!token) {
      throw new Error("VercelPlatform: VERCEL_TOKEN not set");
    }
    this.token = token;
    this.teamId = opts.teamId ?? process.env["VERCEL_TEAM_ID"] ?? undefined;
    this.projectId = opts.projectId ?? process.env["VERCEL_PROJECT_ID"] ?? undefined;
    this.baseUrl = opts.baseUrl ?? "https://api.vercel.com";
    this.waitSeconds = opts.waitSeconds ?? 0;
    this.fetchFn = opts.fetch ?? ((...args) => fetch(...(args as Parameters<typeof fetch>)) as ReturnType<HttpFetch>);
  }

  async resolve(input: ResolvePreviewInput): Promise<PreviewResolution | null> {
    const wait = input.waitSeconds ?? this.waitSeconds;
    const deadline = Date.now() + wait * 1_000;

    // Retry loop: on the first pass Vercel may still be BUILDING.
    // Poll every ~3s until wait expires or we get a READY match.
    while (true) {
      const match = await this.pollOnce(input);
      if (match) return match;
      if (Date.now() >= deadline) return null;
      await sleep(Math.min(3_000, Math.max(500, deadline - Date.now())));
    }
  }

  private async pollOnce(input: ResolvePreviewInput): Promise<PreviewResolution | null> {
    const params = new URLSearchParams();
    params.set("limit", "20");
    params.set("meta-githubCommitSha", input.sha);
    if (this.teamId) params.set("teamId", this.teamId);
    if (this.projectId) params.set("projectId", this.projectId);

    const url = `${this.baseUrl}/v6/deployments?${params.toString()}`;
    const res = await this.fetchFn(url, {
      method: "GET",
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new Error(`VercelPlatform: auth failed (status ${res.status})`);
      }
      if (res.status >= 500) {
        const text = await res.text();
        throw new Error(`VercelPlatform: server error ${res.status}: ${text.slice(0, 200)}`);
      }
      return null;
    }
    const data = (await res.json()) as { deployments?: VercelDeployment[] };
    const deployments = data.deployments ?? [];

    // Filter to matching SHA + READY state; pick newest by `created`.
    const matching = deployments
      .filter((d) => {
        const metaSha = d.meta?.githubCommitSha ?? "";
        return metaSha === input.sha && readyStateMatches(d);
      })
      .sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
    const best = matching[0];
    if (!best || !best.url) return null;
    const out: PreviewResolution = {
      url: best.url.startsWith("http") ? best.url : `https://${best.url}`,
      provider: "vercel",
      sha: input.sha,
    };
    if (best.uid) out.deploymentId = best.uid;
    if (typeof best.created === "number") out.createdAt = new Date(best.created).toISOString();
    return out;
  }
}

function readyStateMatches(d: VercelDeployment): boolean {
  const s = (d.readyState ?? d.state ?? "").toUpperCase();
  return s === "READY";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
