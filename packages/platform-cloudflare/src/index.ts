import type { Platform, PreviewResolution, ResolvePreviewInput } from "@ai-conclave/core";

export interface HttpFetch {
  (url: string, init: { method: string; headers: Record<string, string> }): Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
    text: () => Promise<string>;
  }>;
}

export interface CloudflareAdapterOptions {
  apiToken?: string;
  accountId?: string;
  projectName?: string;
  baseUrl?: string;
  waitSeconds?: number;
  fetch?: HttpFetch;
}

interface CfDeployment {
  id?: string;
  url?: string;
  latest_stage?: { status?: string };
  deployment_trigger?: { metadata?: { commit_hash?: string } };
  created_on?: string;
}

interface CfPageResponse {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: CfDeployment[];
}

/**
 * CloudflarePlatform — resolves preview URL for (repo, sha) via
 * Cloudflare Pages' REST API:
 * `GET /accounts/{account}/pages/projects/{project}/deployments`
 *
 * Cloudflare Pages does not filter server-side by commit; we fetch
 * recent deployments and filter client-side by `deployment_trigger.
 * metadata.commit_hash`. Picks the newest with `latest_stage.status:
 * "success"`.
 *
 * Env:
 *   CLOUDFLARE_API_TOKEN    — required (Pages:Edit permission)
 *   CLOUDFLARE_ACCOUNT_ID   — required
 *   CLOUDFLARE_PROJECT_NAME — required
 */
export class CloudflarePlatform implements Platform {
  readonly id = "cloudflare-pages";
  readonly displayName = "Cloudflare Pages";

  private readonly apiToken: string;
  private readonly accountId: string;
  private readonly projectName: string;
  private readonly baseUrl: string;
  private readonly waitSeconds: number;
  private readonly fetchFn: HttpFetch;

  constructor(opts: CloudflareAdapterOptions = {}) {
    const token = opts.apiToken ?? process.env["CLOUDFLARE_API_TOKEN"] ?? "";
    const account = opts.accountId ?? process.env["CLOUDFLARE_ACCOUNT_ID"] ?? "";
    const project = opts.projectName ?? process.env["CLOUDFLARE_PROJECT_NAME"] ?? "";
    if (!token) throw new Error("CloudflarePlatform: CLOUDFLARE_API_TOKEN not set");
    if (!account) throw new Error("CloudflarePlatform: CLOUDFLARE_ACCOUNT_ID not set");
    if (!project) throw new Error("CloudflarePlatform: CLOUDFLARE_PROJECT_NAME not set");
    this.apiToken = token;
    this.accountId = account;
    this.projectName = project;
    this.baseUrl = opts.baseUrl ?? "https://api.cloudflare.com/client/v4";
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
    const url = `${this.baseUrl}/accounts/${this.accountId}/pages/projects/${encodeURIComponent(this.projectName)}/deployments`;
    const res = await this.fetchFn(url, {
      method: "GET",
      headers: { authorization: `Bearer ${this.apiToken}` },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new Error(`CloudflarePlatform: auth failed (status ${res.status})`);
      }
      if (res.status >= 500) {
        const text = await res.text();
        throw new Error(`CloudflarePlatform: server error ${res.status}: ${text.slice(0, 200)}`);
      }
      return null;
    }
    const data = (await res.json()) as CfPageResponse;
    if (data.success === false) {
      const msg = data.errors?.[0]?.message ?? "unknown";
      throw new Error(`CloudflarePlatform: API returned success=false — ${msg}`);
    }
    const deployments = data.result ?? [];
    const matching = deployments
      .filter(
        (d) =>
          d.deployment_trigger?.metadata?.commit_hash === sha &&
          (d.latest_stage?.status ?? "").toLowerCase() === "success",
      )
      .sort((a, b) => (b.created_on ?? "").localeCompare(a.created_on ?? ""));
    const best = matching[0];
    if (!best || !best.url) return null;
    const out: PreviewResolution = {
      url: best.url.startsWith("http") ? best.url : `https://${best.url}`,
      provider: "cloudflare-pages",
      sha,
    };
    if (best.id) out.deploymentId = best.id;
    if (best.created_on) out.createdAt = best.created_on;
    return out;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
