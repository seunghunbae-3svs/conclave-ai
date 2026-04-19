import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import {
  BudgetTracker,
  CircuitBreaker,
  CircuitOpenError,
  EfficiencyGate,
  FileSystemMemoryStore,
  LoopDetectedError,
  LoopGuard,
  MetricsRecorder,
  OutcomeWriter,
  type EpisodicEntry,
  type MemoryStore,
} from "@conclave-ai/core";
import { ClaudeWorker, type ClaudeWorkerOptions, type FileSnapshot, type WorkerOutcome } from "@conclave-ai/agent-worker";
import { fetchPrState, type GhRunner, type PullRequestState } from "@conclave-ai/scm-github";
import { formatFinding, scanPatch, type ScanResult } from "@conclave-ai/secret-guard";
import { loadConfig, resolveMemoryRoot, type ConclaveConfig } from "../lib/config.js";

const execFile = promisify(execFileCallback);

const HELP = `conclave rework — turn council blockers into a committed fix

Usage:
  conclave rework --pr N [--episodic <id>] [--cwd <dir>] [--dry-run] [--no-push]
                  [--loop-threshold N] [--loop-window-ms MS] [--breaker-threshold N]

Options:
  --pr N                Pull-request number on the current repo to rework. Required unless --episodic is given.
  --episodic <id>       Explicit episodic id to load (otherwise the latest "pending" episodic for --pr wins).
  --cwd <dir>           Working directory — must be checked out to the PR branch (default: .).
  --dry-run             Generate the patch and print it; do not apply, commit, or push.
  --no-push             Apply + commit locally, skip \`git push\`.
  --loop-threshold N    Max rework attempts on the same head sha before giving up (default 5).
  --loop-window-ms MS   Rolling window for the loop guard (default 3600000 = 1h).
  --breaker-threshold N Consecutive worker failures before the circuit opens (default 3).
  --allow-secret <id>   Allow-list a secret-guard rule id (repeatable). Use only after human review.
  --skip-secret-guard   Disable the pre-apply secret scan (discouraged — use --allow-secret instead).

Environment:
  ANTHROPIC_API_KEY     required — the worker uses Claude.

Side effects (unless --dry-run):
  - \`git apply\` the worker patch on top of the current branch
  - \`git commit\` with author "conclave-worker[bot] <noreply@conclave.ai>"
  - \`git push\` (unless --no-push) — assumes current branch tracks a remote
  - Marks the episodic as "reworked" in the memory store.

The LoopGuard uses \`<repo>#<pr>:<headSha>\` as its key. Running \`rework\` more than --loop-threshold times on the SAME commit within the window aborts with non-zero exit — that's the signal for a human to step in.
`;

export interface ReworkArgs {
  pr?: number;
  episodic?: string;
  cwd: string;
  dryRun: boolean;
  noPush: boolean;
  loopThreshold: number;
  loopWindowMs: number;
  breakerThreshold: number;
  allowSecrets: string[];
  skipSecretGuard: boolean;
  help: boolean;
}

export function parseArgv(argv: string[]): ReworkArgs {
  const out: ReworkArgs = {
    cwd: ".",
    dryRun: false,
    noPush: false,
    loopThreshold: 5,
    loopWindowMs: 3600_000,
    breakerThreshold: 3,
    allowSecrets: [],
    skipSecretGuard: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--no-push") out.noPush = true;
    else if (a === "--pr" && argv[i + 1]) {
      const n = Number.parseInt(argv[i + 1]!, 10);
      if (!Number.isNaN(n)) out.pr = n;
      i += 1;
    } else if (a === "--episodic" && argv[i + 1]) {
      out.episodic = argv[i + 1];
      i += 1;
    } else if (a === "--cwd" && argv[i + 1]) {
      out.cwd = argv[i + 1]!;
      i += 1;
    } else if (a === "--loop-threshold" && argv[i + 1]) {
      const n = Number.parseInt(argv[i + 1]!, 10);
      if (!Number.isNaN(n) && n > 0) out.loopThreshold = n;
      i += 1;
    } else if (a === "--loop-window-ms" && argv[i + 1]) {
      const n = Number.parseInt(argv[i + 1]!, 10);
      if (!Number.isNaN(n) && n > 0) out.loopWindowMs = n;
      i += 1;
    } else if (a === "--breaker-threshold" && argv[i + 1]) {
      const n = Number.parseInt(argv[i + 1]!, 10);
      if (!Number.isNaN(n) && n > 0) out.breakerThreshold = n;
      i += 1;
    } else if (a === "--allow-secret" && argv[i + 1]) {
      out.allowSecrets.push(argv[i + 1]!);
      i += 1;
    } else if (a === "--skip-secret-guard") {
      out.skipSecretGuard = true;
    }
  }
  return out;
}

export type Exec = (
  bin: string,
  args: readonly string[],
  opts?: { cwd?: string; input?: string; timeout?: number },
) => Promise<{ stdout: string; stderr?: string; code?: number }>;

export interface ReworkDeps {
  /** cosmiconfig loader — override in tests. */
  loadConfig?: () => Promise<{ config: ConclaveConfig; configDir: string }>;
  /** Override the memory store (tests). Otherwise built from config. */
  store?: MemoryStore;
  /** Override the outcome writer (tests). Otherwise built from the store. */
  writer?: OutcomeWriter;
  /** Override the worker instance (tests). Otherwise built from config + env. */
  worker?: { work: (ctx: Parameters<ClaudeWorker["work"]>[0]) => Promise<WorkerOutcome> };
  /** gh runner for fetchPrState (same contract as scm-github). */
  gh?: GhRunner;
  /** git runner — accepts (args, opts) like execFile. */
  git?: Exec;
  /** Reads a file's contents at a path inside cwd. */
  readFile?: (absPath: string) => Promise<string>;
  /** Write + delete temp patch file; defaults to fs/promises. */
  writeTempPatch?: (absPath: string, contents: string) => Promise<void>;
  removeTempPatch?: (absPath: string) => Promise<void>;
  /** Stdout / stderr sinks — override in tests. */
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  /** LoopGuard — inject for test-time clock control. */
  loopGuard?: LoopGuard;
  /** CircuitBreaker — inject for test-time clock control. */
  breaker?: CircuitBreaker;
  /** Factory for a real ClaudeWorker when `worker` is not injected. */
  workerFactory?: (opts: ClaudeWorkerOptions) => { work: (ctx: Parameters<ClaudeWorker["work"]>[0]) => Promise<WorkerOutcome> };
  /** Patch scanner — defaults to `scanPatch` from @conclave-ai/secret-guard. */
  secretScan?: (patch: string, opts?: { allow?: readonly string[] }) => ScanResult;
}

const defaultGit: Exec = async (bin, args, opts) => {
  try {
    const { stdout, stderr } = await execFile(bin, args as string[], {
      ...(opts?.cwd ? { cwd: opts.cwd } : {}),
      ...(opts?.input ? { input: opts.input } : {}),
      ...(opts?.timeout ? { timeout: opts.timeout } : {}),
      maxBuffer: 20 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    const out: { stdout: string; stderr?: string; code?: number } = {
      stdout: e.stdout ?? "",
    };
    if (e.stderr !== undefined) out.stderr = e.stderr;
    if (e.code !== undefined) out.code = typeof e.code === "number" ? e.code : Number(e.code);
    throw Object.assign(new Error(`${bin} ${args.join(" ")} failed: ${e.stderr ?? e.message}`), out);
  }
};

const defaultGh: GhRunner = async (bin, args, opts) => {
  const { stdout, stderr } = await execFile(bin, args as string[], {
    ...opts,
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout, stderr };
};

/**
 * Resolve which episodic entry to rework. When --episodic is given we
 * honour it literally (even if the user asks for something non-pending —
 * operators occasionally want to re-run the worker on an already-recorded
 * entry, e.g. after tweaking the failure-catalog). When only --pr is given
 * we pick the most recent pending episodic for that PR.
 */
export async function resolveEpisodic(
  store: MemoryStore,
  args: Pick<ReworkArgs, "pr" | "episodic">,
): Promise<EpisodicEntry> {
  if (args.episodic) {
    const found = await store.findEpisodic(args.episodic);
    if (!found) throw new Error(`rework: episodic ${args.episodic} not found in store`);
    return found;
  }
  if (!args.pr) {
    throw new Error("rework: --pr or --episodic is required");
  }
  const all = await store.listEpisodic();
  const candidates = all
    .filter((e) => e.pullNumber === args.pr && e.outcome === "pending")
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  if (candidates.length === 0) {
    throw new Error(`rework: no pending episodic found for PR #${args.pr}`);
  }
  return candidates[0]!;
}

/** Walk `reviews[*].blockers[*].file` and return unique paths (skipping missing). */
export function collectBlockerFiles(episodic: EpisodicEntry): string[] {
  const seen = new Set<string>();
  for (const r of episodic.reviews) {
    for (const b of r.blockers) {
      if (b.file && !seen.has(b.file)) seen.add(b.file);
    }
  }
  return [...seen];
}

export async function runRework(args: ReworkArgs, deps: ReworkDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? ((s) => process.stdout.write(s));
  const stderr = deps.stderr ?? ((s) => process.stderr.write(s));

  const cfg = await (deps.loadConfig ?? loadConfig)();
  const store =
    deps.store ??
    new FileSystemMemoryStore({ root: resolveMemoryRoot(cfg.config, cfg.configDir) });
  const writer = deps.writer ?? new OutcomeWriter({ store });

  const episodic = await resolveEpisodic(store, args);

  const prState: PullRequestState = await fetchPrState(episodic.repo, episodic.pullNumber, { run: deps.gh ?? defaultGh });
  if (prState.state !== "open") {
    stderr(`rework: PR ${episodic.repo}#${episodic.pullNumber} is ${prState.state}, not open — nothing to do\n`);
    return 1;
  }

  const loopGuard =
    deps.loopGuard ??
    new LoopGuard({ threshold: args.loopThreshold, windowMs: args.loopWindowMs });
  const breaker =
    deps.breaker ?? new CircuitBreaker({ failureThreshold: args.breakerThreshold });

  const loopKey = `${episodic.repo}#${episodic.pullNumber}:${prState.headSha}`;
  try {
    loopGuard.check(loopKey);
  } catch (err) {
    if (err instanceof LoopDetectedError) {
      stderr(
        `rework: loop guard tripped on ${loopKey} (${err.count} attempts in ${err.windowMs}ms) — human needed\n`,
      );
      return 2;
    }
    throw err;
  }

  const git = deps.git ?? defaultGit;
  const read = deps.readFile ?? ((p: string) => readFile(p, "utf8"));
  const blockerFiles = collectBlockerFiles(episodic);

  const fileSnapshots: FileSnapshot[] = [];
  for (const relPath of blockerFiles) {
    const abs = path.isAbsolute(relPath) ? relPath : path.join(args.cwd, relPath);
    try {
      const contents = await read(abs);
      fileSnapshots.push({ path: relPath, contents });
    } catch {
      stderr(`rework: could not read ${relPath} — worker will proceed without it\n`);
    }
  }

  const worker = deps.worker ?? buildWorker(deps, cfg.config);

  let outcome: WorkerOutcome;
  try {
    outcome = await breaker.guard("worker", () =>
      worker.work({
        repo: episodic.repo,
        pullNumber: episodic.pullNumber,
        newSha: prState.headSha,
        reviews: episodic.reviews,
        fileSnapshots,
      }),
    );
  } catch (err) {
    if (err instanceof CircuitOpenError) {
      stderr(`rework: circuit breaker open for worker (until ${new Date(err.openUntil).toISOString()}) — human needed\n`);
      return 2;
    }
    throw err;
  }

  if (!outcome.patch) {
    stderr(`rework: worker could not produce a patch — no changes applied\n`);
    return 1;
  }

  stdout(
    `rework: worker proposed patch (${outcome.appliedFiles.length} file${
      outcome.appliedFiles.length === 1 ? "" : "s"
    }, ${outcome.patch.length} bytes)\n`,
  );
  stdout(`rework: commit message: ${outcome.message}\n`);

  if (!args.skipSecretGuard) {
    const scan = (deps.secretScan ?? scanPatch)(outcome.patch, { allow: args.allowSecrets });
    if (scan.blocked) {
      stderr(
        `rework: secret-guard blocked the patch — ${scan.findings.length} high-confidence finding(s):\n`,
      );
      for (const f of scan.findings) stderr(`  ${formatFinding(f)}\n`);
      stderr(
        `rework: run with --allow-secret <ruleId> only after a human confirms the match is a false positive\n`,
      );
      return 1;
    }
    if (scan.findings.length > 0) {
      stdout(`rework: secret-guard saw ${scan.findings.length} low/medium finding(s), not blocking\n`);
    }
  }

  if (args.dryRun) {
    stdout(`---\n${outcome.patch}\n---\n`);
    stdout(`rework: --dry-run, not applying\n`);
    return 0;
  }

  const patchPath = path.join(args.cwd, ".conclave-rework.patch");
  const writeTemp = deps.writeTempPatch ?? ((p: string, c: string) => writeFile(p, c, "utf8"));
  const removeTemp = deps.removeTempPatch ?? ((p: string) => unlink(p));

  await writeTemp(patchPath, outcome.patch);

  try {
    // --recount lets git apply recompute the @@ hunk header line counts from
    // the actual hunk content. LLMs (Claude, GPT, Gemini) routinely get those
    // counts wrong — the hunk body is correct but the header claims e.g.
    // "7 lines" when only 3 are present, which `git apply` would otherwise
    // reject as "corrupt patch at line N". --recount is the official git
    // option designed for exactly this case.
    await git("git", ["apply", "--check", "--recount", patchPath], { cwd: args.cwd });
  } catch (err) {
    await removeTemp(patchPath).catch(() => undefined);
    const msg = err instanceof Error ? err.message : String(err);
    stderr(`rework: patch does not apply cleanly — ${msg}\n`);
    return 1;
  }

  await git("git", ["apply", "--recount", patchPath], { cwd: args.cwd });
  await removeTemp(patchPath).catch(() => undefined);

  if (outcome.appliedFiles.length > 0) {
    await git("git", ["add", "--", ...outcome.appliedFiles], { cwd: args.cwd });
  } else {
    await git("git", ["add", "-A"], { cwd: args.cwd });
  }

  await git(
    "git",
    [
      "-c",
      "user.name=conclave-worker[bot]",
      "-c",
      "user.email=noreply@conclave.ai",
      "commit",
      "-m",
      outcome.message,
      "--author",
      "conclave-worker[bot] <noreply@conclave.ai>",
    ],
    { cwd: args.cwd },
  );

  if (!args.noPush) {
    await git("git", ["push"], { cwd: args.cwd });
  }

  await writer.recordOutcome({ episodicId: episodic.id, outcome: "reworked" });

  stdout(
    `rework: applied${args.noPush ? " (local only)" : " + pushed"} — ${outcome.appliedFiles.join(", ") || "(none listed)"}\n`,
  );
  stdout(`rework: episodic ${episodic.id} recorded as reworked\n`);
  return 0;
}

function buildWorker(deps: ReworkDeps, config: ConclaveConfig): { work: (ctx: Parameters<ClaudeWorker["work"]>[0]) => Promise<WorkerOutcome> } {
  const perPrUsd = config.budget?.perPrUsd ?? 0.5;
  const gate = new EfficiencyGate({
    budget: new BudgetTracker({ perPrUsd }),
    metrics: new MetricsRecorder(),
  });
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "rework: ANTHROPIC_API_KEY is not set (the worker agent needs it; pass --dry-run only after setting the key)",
    );
  }
  const factory = deps.workerFactory ?? ((opts: ClaudeWorkerOptions) => new ClaudeWorker(opts));
  return factory({ apiKey, gate });
}

export async function rework(argv: string[]): Promise<void> {
  const args = parseArgv(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (args.pr === undefined && !args.episodic) {
    process.stderr.write(`conclave rework: --pr or --episodic is required\n\n${HELP}`);
    process.exit(2);
    return;
  }
  const code = await runRework(args);
  if (code !== 0) process.exit(code);
}
