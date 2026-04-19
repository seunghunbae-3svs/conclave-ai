import { promises as fs } from "node:fs";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export interface LoadedDiff {
  diff: string;
  repo: string;
  pullNumber: number;
  newSha: string;
  prevSha?: string;
  source: "gh-pr" | "git-diff" | "file";
}

export interface DiffSourceDeps {
  execFile?: (
    bin: string,
    args: readonly string[],
    opts?: { cwd?: string; timeout?: number },
  ) => Promise<{ stdout: string; stderr?: string }>;
  readFile?: (path: string) => Promise<string>;
}

const defaultDeps: Required<DiffSourceDeps> = {
  execFile: async (bin, args, opts) => {
    const { stdout, stderr } = await execFile(bin, args as string[], { ...opts, maxBuffer: 20 * 1024 * 1024 });
    return { stdout, stderr };
  },
  readFile: (p) => fs.readFile(p, "utf8"),
};

/** Load a diff from `gh pr diff N` + `gh pr view N --json ...`. Requires `gh` + repo context. */
export async function loadPrDiff(prNumber: number, deps: DiffSourceDeps = {}): Promise<LoadedDiff> {
  const run = deps.execFile ?? defaultDeps.execFile;
  const prStr = String(prNumber);
  const [diffRes, viewRes] = await Promise.all([
    run("gh", ["pr", "diff", prStr]),
    run("gh", ["pr", "view", prStr, "--json", "headRefOid,baseRefOid,headRepository,headRepositoryOwner,number"]),
  ]);
  const view = JSON.parse(viewRes.stdout) as {
    headRefOid?: string;
    baseRefOid?: string;
    headRepository?: { name?: string };
    headRepositoryOwner?: { login?: string };
    number?: number;
  };
  const repoName = view.headRepository?.name;
  const repoOwner = view.headRepositoryOwner?.login;
  if (!repoName || !repoOwner) {
    throw new Error(`loadPrDiff: gh did not return repo owner/name for PR ${prStr}`);
  }
  const headSha = view.headRefOid;
  if (!headSha) {
    throw new Error(`loadPrDiff: gh did not return headRefOid for PR ${prStr}`);
  }
  const loaded: LoadedDiff = {
    diff: diffRes.stdout,
    repo: `${repoOwner}/${repoName}`,
    pullNumber: view.number ?? prNumber,
    newSha: headSha,
    source: "gh-pr",
  };
  if (view.baseRefOid) loaded.prevSha = view.baseRefOid;
  return loaded;
}

/** Load a diff from `git diff <base>..HEAD`. Uses `origin/main` as the default base. */
export async function loadGitDiff(base: string = "origin/main", deps: DiffSourceDeps = {}): Promise<LoadedDiff> {
  const run = deps.execFile ?? defaultDeps.execFile;
  const [diffRes, shaRes, baseRes, remoteRes] = await Promise.all([
    run("git", ["diff", `${base}..HEAD`]),
    run("git", ["rev-parse", "HEAD"]),
    run("git", ["rev-parse", base]).catch(() => ({ stdout: "" })),
    run("git", ["remote", "get-url", "origin"]).catch(() => ({ stdout: "" })),
  ]);
  const remoteUrl = remoteRes.stdout.trim();
  const repoSlug = parseRepoSlugFromRemote(remoteUrl) ?? "local/unknown";
  const loaded: LoadedDiff = {
    diff: diffRes.stdout,
    repo: repoSlug,
    pullNumber: 0,
    newSha: shaRes.stdout.trim(),
    source: "git-diff",
  };
  const baseSha = baseRes.stdout.trim();
  if (baseSha) loaded.prevSha = baseSha;
  return loaded;
}

/** Load a diff from a local unified-diff file. Useful for replaying failing reviews. */
export async function loadFileDiff(filePath: string, deps: DiffSourceDeps = {}): Promise<LoadedDiff> {
  const read = deps.readFile ?? defaultDeps.readFile;
  const diff = await read(filePath);
  return {
    diff,
    repo: "local/file",
    pullNumber: 0,
    newSha: "FILE",
    source: "file",
  };
}

/** Extract "owner/repo" slug from a git remote URL (https or ssh). Returns null if it can't parse. */
export function parseRepoSlugFromRemote(url: string): string | null {
  if (!url) return null;
  const https = url.match(/github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?(?:\/)?$/i);
  if (https) return `${https[1]}/${https[2]}`;
  const ssh = url.match(/^git@[^:]+:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  return null;
}
