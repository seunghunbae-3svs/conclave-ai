import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

export interface DetectedRepo {
  owner: string;
  name: string;
  /** Full "owner/name" slug as GitHub expects. */
  slug: string;
  /** Raw remote URL we parsed, for debug + error messages. */
  rawUrl: string;
}

export interface DetectRepoDeps {
  /** execFile-like runner — override for tests. Returns { stdout }. */
  run?: (bin: string, args: readonly string[], opts?: { cwd?: string }) => Promise<{ stdout: string }>;
  cwd?: string;
}

const defaultRun: NonNullable<DetectRepoDeps["run"]> = async (bin, args, opts) => {
  const out = await execFile(bin, args as string[], {
    encoding: "utf8",
    ...(opts?.cwd ? { cwd: opts.cwd } : {}),
  });
  return { stdout: out.stdout as string };
};

/**
 * Parse a git remote URL into `owner/name`. Handles the four forms git
 * emits in the wild:
 *   https://github.com/owner/name.git
 *   https://github.com/owner/name
 *   git@github.com:owner/name.git
 *   ssh://git@github.com/owner/name.git
 * Anything that isn't github.com is rejected — v0.4 is GitHub-only. (A
 * hostname check is strictly better than regex-hunting because one of our
 * support paths is "user pastes their own URL via --repo" and I'd rather
 * fail loud on GitLab/Bitbucket than pretend it'll work.)
 */
export function parseRemoteUrl(rawUrl: string): DetectedRepo | null {
  const url = rawUrl.trim();
  if (!url) return null;

  // https / ssh protocol form
  const httpsMatch = url.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (httpsMatch && httpsMatch[1] === "github.com") {
    const owner = httpsMatch[2]!;
    const name = httpsMatch[3]!;
    return { owner, name, slug: `${owner}/${name}`, rawUrl };
  }
  const sshProto = url.match(/^ssh:\/\/git@([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (sshProto && sshProto[1] === "github.com") {
    const owner = sshProto[2]!;
    const name = sshProto[3]!;
    return { owner, name, slug: `${owner}/${name}`, rawUrl };
  }
  // scp-like: git@github.com:owner/name(.git)
  const scp = url.match(/^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (scp && scp[1] === "github.com") {
    const owner = scp[2]!;
    const name = scp[3]!;
    return { owner, name, slug: `${owner}/${name}`, rawUrl };
  }
  return null;
}

/** Detect the repo from `git remote get-url origin`. */
export async function detectRepo(deps: DetectRepoDeps = {}): Promise<DetectedRepo> {
  const run = deps.run ?? defaultRun;
  let stdout: string;
  try {
    const res = await run("git", ["remote", "get-url", "origin"], deps.cwd ? { cwd: deps.cwd } : {});
    stdout = res.stdout;
  } catch (err) {
    throw new Error(
      `conclave init: could not read git remote 'origin' — run inside a git repo, or pass --repo owner/name`,
    );
  }
  const parsed = parseRemoteUrl(stdout);
  if (!parsed) {
    throw new Error(
      `conclave init: could not parse git remote as a GitHub repo (got ${JSON.stringify(stdout.trim())}). Pass --repo owner/name to override.`,
    );
  }
  return parsed;
}
