import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { Platform, PreviewResolution, ResolvePreviewInput } from "@conclave-ai/core";

const execFile = promisify(execFileCallback);

export interface GhRunner {
  (bin: string, args: readonly string[]): Promise<{ stdout: string; stderr?: string }>;
}

export interface DeploymentStatusAdapterOptions {
  /** Filter to deployments in a specific environment. e.g. "preview" or "production". */
  environment?: string;
  /** Require the deployment status state to be one of these. Default ["success"]. */
  acceptedStates?: readonly string[];
  waitSeconds?: number;
  run?: GhRunner;
}

interface GhDeployment {
  id?: number;
  sha?: string;
  environment?: string;
  statuses_url?: string;
  created_at?: string;
}

interface GhDeploymentStatus {
  state?: string;
  environment_url?: string;
  target_url?: string;
  created_at?: string;
}

/**
 * DeploymentStatusPlatform — generic GitHub-based adapter. Works with
 * ANY host that reports deployments back to GitHub via the
 * Deployments API (Vercel / Netlify / Render / Fly / Railway / Docker
 * + custom CI workflows — if they post a `deployment_status` event
 * with an environment_url, we can resolve it).
 *
 * Uses `gh api` — same dependency as @conclave-ai/scm-github. No
 * separate token setup; `gh auth login` is the single credential.
 *
 * Why this exists:
 *   - One adapter handles the long tail of hosts (Render / Fly /
 *     Railway / Replit / self-hosted Docker) without a dedicated
 *     package per host.
 *   - Reads GitHub as the source of truth — matches how humans already
 *     audit deploys (PR view → "Deployments" tab).
 *   - Only requires the hosting platform to follow GitHub's standard
 *     deployment-status protocol. Any modern host does.
 */
export class DeploymentStatusPlatform implements Platform {
  readonly id = "deployment-status";
  readonly displayName = "GitHub Deployment Status";

  private readonly environment: string | undefined;
  private readonly acceptedStates: readonly string[];
  private readonly waitSeconds: number;
  private readonly run: GhRunner;

  constructor(opts: DeploymentStatusAdapterOptions = {}) {
    this.environment = opts.environment;
    this.acceptedStates = opts.acceptedStates ?? ["success"];
    this.waitSeconds = opts.waitSeconds ?? 0;
    this.run =
      opts.run ??
      (async (bin, args) => {
        const { stdout, stderr } = await execFile(bin, args as string[], {
          maxBuffer: 10 * 1024 * 1024,
        });
        return { stdout, stderr };
      });
  }

  async resolve(input: ResolvePreviewInput): Promise<PreviewResolution | null> {
    const wait = input.waitSeconds ?? this.waitSeconds;
    const deadline = Date.now() + wait * 1_000;
    while (true) {
      const match = await this.pollOnce(input);
      if (match) return match;
      if (Date.now() >= deadline) return null;
      await sleep(Math.min(3_000, Math.max(500, deadline - Date.now())));
    }
  }

  private async pollOnce(input: ResolvePreviewInput): Promise<PreviewResolution | null> {
    const query = `/repos/${input.repo}/deployments?sha=${encodeURIComponent(input.sha)}&per_page=20`;
    let deployments: GhDeployment[] = [];
    try {
      const { stdout } = await this.run("gh", ["api", query]);
      deployments = JSON.parse(stdout) as GhDeployment[];
    } catch (err) {
      const msg = (err as Error).message;
      if (/authentication|401|403/i.test(msg)) {
        throw new Error(`DeploymentStatusPlatform: gh auth failed — ${msg}`);
      }
      if (/404|not found/i.test(msg)) return null;
      throw err;
    }

    const candidateDeployments = deployments
      .filter((d) => !this.environment || d.environment === this.environment)
      .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));

    for (const dep of candidateDeployments) {
      if (!dep.id) continue;
      const status = await this.resolveBestStatus(input.repo, dep.id);
      if (!status) continue;
      if (!this.acceptedStates.includes((status.state ?? "").toLowerCase())) continue;
      const url = status.environment_url ?? status.target_url;
      if (!url) continue;
      const out: PreviewResolution = {
        url: url.startsWith("http") ? url : `https://${url}`,
        provider: "deployment-status",
        sha: input.sha,
      };
      if (dep.id !== undefined) out.deploymentId = String(dep.id);
      if (status.created_at) out.createdAt = status.created_at;
      return out;
    }
    return null;
  }

  private async resolveBestStatus(repo: string, deploymentId: number): Promise<GhDeploymentStatus | null> {
    const query = `/repos/${repo}/deployments/${deploymentId}/statuses?per_page=20`;
    const { stdout } = await this.run("gh", ["api", query]);
    const statuses = JSON.parse(stdout) as GhDeploymentStatus[];
    if (statuses.length === 0) return null;
    return statuses.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))[0] ?? null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
