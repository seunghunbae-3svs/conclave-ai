import type { Platform, PreviewResolution, ResolvePreviewInput } from "@conclave-ai/core";

export interface HttpFetch {
  (url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
    text: () => Promise<string>;
  }>;
}

export interface RenderAdapterOptions {
  apiToken?: string;
  /** Render service id — starts with `srv-...`. Required. */
  serviceId?: string;
  baseUrl?: string;
  waitSeconds?: number;
  fetch?: HttpFetch;
}

interface RenderDeployment {
  id?: string;
  status?: string;
  commit?: { id?: string };
  createdAt?: string;
  finishedAt?: string;
}

interface RenderDeploysListItem {
  deploy?: RenderDeployment;
}

interface RenderServiceResponse {
  id?: string;
  name?: string;
  /**
   * The canonical live URL. Render doesn't emit per-deploy preview URLs for
   * regular Web Services — the service's URL is stable and serves whatever
   * deploy is current. For PR previews (Service Previews) Render creates a
   * SEPARATE service per PR whose `name` contains `-pr-<n>`; this adapter
   * resolves via the user-supplied `serviceId` pointing at either a main
   * service or a preview service.
   */
  serviceDetails?: { url?: string };
}

/**
 * RenderPlatform — resolves a Render deployment's URL for a commit SHA.
 *
 * Strategy (since Render has no server-side SHA filter):
 *   1. GET /v1/services/{serviceId} → resolve the live URL for that service
 *   2. GET /v1/services/{serviceId}/deploys?limit=20 → list recent deploys
 *   3. Filter client-side by `deploy.commit.id === sha` AND
 *      `deploy.status === "live"`; pick newest by `finishedAt ?? createdAt`.
 *   4. Return `{ url: service.serviceDetails.url, sha, deploymentId, createdAt }`.
 *      The URL comes from the service object (stable per service); the
 *      commit match is the gate that we found an actual deploy at that SHA.
 *
 * Env:
 *   RENDER_API_TOKEN  — required (User-scoped token or Service Preview PAT)
 *   RENDER_SERVICE_ID — required (srv-xxxx...)
 */
export class RenderPlatform implements Platform {
  readonly id = "render";
  readonly displayName = "Render";

  private readonly apiToken: string;
  private readonly serviceId: string;
  private readonly baseUrl: string;
  private readonly waitSeconds: number;
  private readonly fetchFn: HttpFetch;

  constructor(opts: RenderAdapterOptions = {}) {
    const token = opts.apiToken ?? process.env["RENDER_API_TOKEN"] ?? "";
    const service = opts.serviceId ?? process.env["RENDER_SERVICE_ID"] ?? "";
    if (!token) throw new Error("RenderPlatform: RENDER_API_TOKEN not set");
    if (!service) throw new Error("RenderPlatform: RENDER_SERVICE_ID not set");
    this.apiToken = token;
    this.serviceId = service;
    this.baseUrl = opts.baseUrl ?? "https://api.render.com/v1";
    this.waitSeconds = opts.waitSeconds ?? 0;
    this.fetchFn =
      opts.fetch ??
      ((...args) => fetch(...(args as Parameters<typeof fetch>)) as ReturnType<HttpFetch>);
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
    // Step 1: service details (for the canonical URL).
    const serviceRes = await this.fetchFn(`${this.baseUrl}/services/${encodeURIComponent(this.serviceId)}`, {
      method: "GET",
      headers: this.headers(),
    });
    if (serviceRes.status === 404) return null;
    if (!serviceRes.ok) {
      if (serviceRes.status === 401 || serviceRes.status === 403) {
        throw new Error(`RenderPlatform: auth failed (status ${serviceRes.status})`);
      }
      if (serviceRes.status >= 500) {
        const text = await serviceRes.text();
        throw new Error(`RenderPlatform: server error ${serviceRes.status}: ${text.slice(0, 200)}`);
      }
      return null;
    }
    const service = (await serviceRes.json()) as RenderServiceResponse;
    const serviceUrl = service.serviceDetails?.url ?? null;
    if (!serviceUrl) return null;

    // Step 2: recent deploys list.
    const deploysRes = await this.fetchFn(
      `${this.baseUrl}/services/${encodeURIComponent(this.serviceId)}/deploys?limit=20`,
      { method: "GET", headers: this.headers() },
    );
    if (!deploysRes.ok) {
      if (deploysRes.status === 401 || deploysRes.status === 403) {
        throw new Error(`RenderPlatform: auth failed (status ${deploysRes.status})`);
      }
      if (deploysRes.status >= 500) {
        const text = await deploysRes.text();
        throw new Error(`RenderPlatform: server error ${deploysRes.status}: ${text.slice(0, 200)}`);
      }
      return null;
    }
    const deploys = (await deploysRes.json()) as RenderDeploysListItem[];
    const matching = deploys
      .map((d) => d.deploy)
      .filter((d): d is RenderDeployment => !!d)
      .filter((d) => d.commit?.id === sha && (d.status ?? "").toLowerCase() === "live")
      .sort((a, b) => (b.finishedAt ?? b.createdAt ?? "").localeCompare(a.finishedAt ?? a.createdAt ?? ""));

    const best = matching[0];
    if (!best) return null;

    const out: PreviewResolution = {
      url: serviceUrl,
      provider: "render",
      sha,
    };
    if (best.id) out.deploymentId = best.id;
    if (best.createdAt) out.createdAt = best.createdAt;
    return out;
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.apiToken}`,
      accept: "application/json",
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
