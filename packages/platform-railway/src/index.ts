import type { Platform, PreviewResolution, ResolvePreviewInput } from "@ai-conclave/core";

export interface HttpFetch {
  (url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
    text: () => Promise<string>;
  }>;
}

export interface RailwayAdapterOptions {
  apiToken?: string;
  projectId?: string;
  environmentId?: string;
  baseUrl?: string;
  waitSeconds?: number;
  fetch?: HttpFetch;
}

interface RwDeploymentNode {
  id?: string;
  status?: string;
  staticUrl?: string | null;
  url?: string | null;
  createdAt?: string;
  meta?: { commitHash?: string } | null;
}

interface RwDeploymentsResponse {
  data?: {
    deployments?: {
      edges?: Array<{ node?: RwDeploymentNode }>;
    };
  };
  errors?: Array<{ message?: string }>;
}

const DEPLOYMENTS_QUERY = `
query Deployments($projectId: String!, $environmentId: String) {
  deployments(first: 20, input: { projectId: $projectId, environmentId: $environmentId }) {
    edges {
      node {
        id
        status
        staticUrl
        url
        createdAt
        meta { commitHash }
      }
    }
  }
}
`.trim();

/**
 * RailwayPlatform — resolves preview URL for (repo, sha) via Railway's
 * GraphQL API at `POST https://backboard.railway.com/graphql/v2`.
 *
 * Railway does not filter server-side by commit; we fetch the latest
 * deployments for a project (optionally narrowed to an environment) and
 * pick the newest one whose `meta.commitHash` matches `sha` AND whose
 * `status` is SUCCESS.
 *
 * `staticUrl` (the `*.up.railway.app` hostname) is preferred when
 * present; falls back to `url`.
 *
 * Env:
 *   RAILWAY_API_TOKEN       — required (project or team token)
 *   RAILWAY_PROJECT_ID      — required
 *   RAILWAY_ENVIRONMENT_ID  — optional (narrow results to one env)
 */
export class RailwayPlatform implements Platform {
  readonly id = "railway";
  readonly displayName = "Railway";

  private readonly apiToken: string;
  private readonly projectId: string;
  private readonly environmentId: string | undefined;
  private readonly baseUrl: string;
  private readonly waitSeconds: number;
  private readonly fetchFn: HttpFetch;

  constructor(opts: RailwayAdapterOptions = {}) {
    const token = opts.apiToken ?? process.env["RAILWAY_API_TOKEN"] ?? "";
    const project = opts.projectId ?? process.env["RAILWAY_PROJECT_ID"] ?? "";
    const env = opts.environmentId ?? process.env["RAILWAY_ENVIRONMENT_ID"] ?? "";
    if (!token) throw new Error("RailwayPlatform: RAILWAY_API_TOKEN not set");
    if (!project) throw new Error("RailwayPlatform: RAILWAY_PROJECT_ID not set");
    this.apiToken = token;
    this.projectId = project;
    this.environmentId = env || undefined;
    this.baseUrl = opts.baseUrl ?? "https://backboard.railway.com/graphql/v2";
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
    const body = JSON.stringify({
      query: DEPLOYMENTS_QUERY,
      variables: {
        projectId: this.projectId,
        environmentId: this.environmentId ?? null,
      },
    });
    const res = await this.fetchFn(this.baseUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiToken}`,
        "content-type": "application/json",
      },
      body,
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new Error(`RailwayPlatform: auth failed (status ${res.status})`);
      }
      if (res.status >= 500) {
        const text = await res.text();
        throw new Error(`RailwayPlatform: server error ${res.status}: ${text.slice(0, 200)}`);
      }
      return null;
    }
    const data = (await res.json()) as RwDeploymentsResponse;
    if (data.errors && data.errors.length > 0) {
      const msg = data.errors[0]?.message ?? "unknown";
      throw new Error(`RailwayPlatform: GraphQL errors — ${msg}`);
    }
    const nodes = (data.data?.deployments?.edges ?? [])
      .map((e) => e?.node)
      .filter((n): n is RwDeploymentNode => !!n);
    const matching = nodes
      .filter(
        (n) =>
          n.meta?.commitHash === sha &&
          (n.status ?? "").toUpperCase() === "SUCCESS",
      )
      .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
    const best = matching[0];
    if (!best) return null;
    const hostname = best.staticUrl ?? best.url ?? null;
    if (!hostname) return null;
    const out: PreviewResolution = {
      url: hostname.startsWith("http") ? hostname : `https://${hostname}`,
      provider: "railway",
      sha,
    };
    if (best.id) out.deploymentId = best.id;
    if (best.createdAt) out.createdAt = best.createdAt;
    return out;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
