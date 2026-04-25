import {
  addRepo,
  loadRepos,
  removeRepo,
  reposPath,
  isValidSlug,
} from "../lib/repos-config.js";

const HELP = `conclave repos — manage the multi-repo watch list (v0.12)

Usage:
  conclave repos add <owner/name>      Add a repo to the watch list.
  conclave repos list                  Print the current watch list.
  conclave repos remove <owner/name>   Remove a repo from the watch list.
  conclave repos path                  Print the path of the watch list file.

The watch list lives in:
  Windows:        %USERPROFILE%\\.conclave\\repos.json
  macOS / Linux:  ~/.config/conclave/repos.json   (XDG-ish)

\`conclave watch\` reads this file and polls each listed repo for new PRs,
dispatching review-on-PR events when one appears.
`;

export interface ReposArgs {
  subcommand: "add" | "list" | "remove" | "path" | "help";
  slug?: string;
}

export function parseReposArgv(argv: string[]): ReposArgs | { error: string } {
  if (argv.length === 0) return { subcommand: "help" };
  const sub = argv[0];
  if (sub === "-h" || sub === "--help" || sub === "help") {
    return { subcommand: "help" };
  }
  if (sub === "list") return { subcommand: "list" };
  if (sub === "path") return { subcommand: "path" };
  if (sub === "add" || sub === "remove") {
    const slug = argv[1];
    if (!slug) return { error: `repos ${sub}: missing <owner/name> argument` };
    if (!isValidSlug(slug)) {
      return { error: `repos ${sub}: '${slug}' doesn't look like a GitHub slug (expected owner/name)` };
    }
    return { subcommand: sub, slug };
  }
  return { error: `unknown subcommand: ${sub}. Run 'conclave repos --help' for usage.` };
}

export interface ReposDeps {
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  /** v0.12 — DI for tests. Production calls pass these through. */
  loadReposFn?: typeof loadRepos;
  addRepoFn?: typeof addRepo;
  removeRepoFn?: typeof removeRepo;
  reposPathFn?: typeof reposPath;
  now?: () => string;
}

/**
 * v0.12 — entry-point wrapper invoked by `index.ts`'s router. Parses
 * argv, dispatches to `runRepos`, and translates the numeric result
 * into a process.exit. Tests call `runRepos` directly; production
 * tops out here.
 */
export async function repos(argv: string[]): Promise<void> {
  const parsed = parseReposArgv(argv);
  if ("error" in parsed) {
    process.stderr.write(`conclave repos: ${parsed.error}\n`);
    process.exit(2);
  }
  const code = await runRepos(parsed);
  if (code !== 0) process.exit(code);
}

export async function runRepos(args: ReposArgs, deps: ReposDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? ((s) => process.stdout.write(s));
  const stderr = deps.stderr ?? ((s) => process.stderr.write(s));
  const loadFn = deps.loadReposFn ?? loadRepos;
  const addFn = deps.addRepoFn ?? addRepo;
  const removeFn = deps.removeRepoFn ?? removeRepo;
  const pathFn = deps.reposPathFn ?? reposPath;
  const now = deps.now ?? (() => new Date().toISOString());

  if (args.subcommand === "help") {
    stdout(HELP);
    return 0;
  }

  if (args.subcommand === "path") {
    stdout(`${pathFn()}\n`);
    return 0;
  }

  if (args.subcommand === "list") {
    const cfg = loadFn();
    if (cfg.repos.length === 0) {
      stdout("conclave repos: watch list is empty. Add one with `conclave repos add owner/name`.\n");
      return 0;
    }
    stdout(`${cfg.repos.length} repo${cfg.repos.length === 1 ? "" : "s"} on watch list:\n`);
    for (const r of cfg.repos) {
      const cadence = r.pollIntervalSec ? ` (poll: ${r.pollIntervalSec}s)` : "";
      stdout(`  ${r.slug}  added=${r.addedAt}${cadence}\n`);
    }
    return 0;
  }

  if (args.subcommand === "add") {
    if (!args.slug) {
      stderr("conclave repos add: <owner/name> required\n");
      return 2;
    }
    try {
      const { added } = addFn(args.slug, now());
      if (added) {
        stdout(`conclave repos: added ${args.slug}\n`);
      } else {
        stdout(`conclave repos: ${args.slug} already on watch list (no-op)\n`);
      }
      return 0;
    } catch (err) {
      stderr(`conclave repos add: ${(err as Error).message}\n`);
      return 1;
    }
  }

  if (args.subcommand === "remove") {
    if (!args.slug) {
      stderr("conclave repos remove: <owner/name> required\n");
      return 2;
    }
    try {
      const { removed } = removeFn(args.slug);
      if (removed) {
        stdout(`conclave repos: removed ${args.slug}\n`);
        return 0;
      }
      stderr(`conclave repos: ${args.slug} was not on the watch list\n`);
      return 1;
    } catch (err) {
      stderr(`conclave repos remove: ${(err as Error).message}\n`);
      return 1;
    }
  }

  // Exhaustive — TS would catch a missing case at compile time.
  stderr(`conclave repos: unhandled subcommand\n`);
  return 2;
}
