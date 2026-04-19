import type { Platform, PreviewResolution, ResolvePreviewInput } from "@ai-conclave/core";

export interface HttpFetch {
  (url: string, init: { method: string; headers: Record<string, string> }): Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
    text: () => Promise<string>;
  }>;
}

export interface NetlifyAdapterOptions {
  token?: string;
  /** Netlify site id — required. */
  siteId?: string;
  baseUrl?: string;
  waitSeconds?: number;
  fetch?: HttpFetch;
}

interface NetlifyDeploy {
  id?: string;
  deploy_ssl_url?: string;
  ssl_url?: string;
  deploy_url?: string;
  state?: string;
  commit_ref?: string;
  created_at?: string;
}

/**
 * NetlifyPlatform — resolves preview URL for a (repo, sha) via
 * Netlify's `/api/v1/sites/{siteId}/deploys` endpoint filtered by
 * `commit_ref`. Returns the newest `ready`-state deploy.
 *
 * Env:
 *   NETLIFY_TOKEN   — required
 *   NETLIFY_SITE_ID — required
 */
export class NetlifyPlatform implements Platform {
  readonly id = "netlify";
  readonly displayName = "Netlify";

  private readonly token: string;
  private readonly siteId: string;
  private readonly baseUrl: string;
  private readonly waitSeconds: number;
  private readonly fetchFn: HttpFetch;

  constructor(opts: NetlifyAdapterOptions = {}) {
    const token = opts.token ?? process.env["NETLIFY_TOKEN"] ?? "";
    const siteId = opts.siteId ?? process.env["NETLIFY_SITE_ID"] ?? "";
    if (!token) throw new Error("NetlifyPlatform: NETLIFY_TOKEN not set");
    if (!siteId) throw new Error("NetlifyPlatform: NETLIFY_SITE_ID not set");
    this.token = token;
    this.siteId = siteId;
    this.baseUrl = opts.baseUrl ?? "https://api.netlify.com";
    this.waitSeconds = opts.waitSeconds ?? 0;
    this.fetchFn = opts.fetch ?? ((...args) => fetch(...(args as Parameters<typeof fetch>)) as ReturnType<HttpFetch>);
  }

  async resolve(input: ResolvePreviewInput): Promise<PreviewResolution | null> {
    const wait = input.waitSeconds ?? this.waitSeconds;
    const deadline = Date.now() + wait * 1_000;
    while (true) {
      const match = await this.pollOnce(input.sha);
      if (match) return match;
      if (Date.now() >= deadline) return null;
      await sleep(Math.min(3_000, Math.max(500, deadline - Date.now())));
    }
  }

  private async pollOnce(sha: string): Promise<PreviewResolution | null> {
    const params = new URLSearchParams({ per_page: "20" });
    const url = `${this.baseUrl}/api/v1/sites/${this.siteId}/deploys?${params.toString()}`;
    const res = await this.fetchFn(url, {
      method: "GET",
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new Error(`NetlifyPlatform: auth failed (status ${res.status})`);
      }
      if (res.status >= 500) {
        const text = await res.text();
        throw new Error(`NetlifyPlatform: server error ${res.status}: ${text.slice(0, 200)}`);
      }
      return null;
    }
    const data = (await res.json()) as NetlifyDeploy[];
    const matching = data
      .filter((d) => d.commit_ref === sha && (d.state ?? "").toLowerCase() === "ready")
      .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
    const best = matching[0];
    if (!best) return null;
    const url2 = best.deploy_ssl_url ?? best.ssl_url ?? best.deploy_url;
    if (!url2) return null;
    const out: PreviewResolution = {
      url: url2.startsWith("http") ? url2 : `https://${url2}`,
      provider: "netlify",
      sha,
    };
    if (best.id) out.deploymentId = best.id;
    if (best.created_at) out.createdAt = best.created_at;
    return out;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
