import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export interface BuildResult {
  success: boolean;
  command: string;
  stdout: string;
  stderr: string;
  durationMs: number;
  detectedFrom: "package.json" | "cargo.toml" | "pyproject.toml" | "explicit" | "none";
  /** True when the runner timed out rather than exiting non-zero. */
  timedOut?: boolean;
}

export type VerifyKind = "build" | "test";

export interface VerifierDeps {
  /** Execute a command line. Defaults to `child_process.execFile`. */
  run?: (
    cmd: string,
    args: readonly string[],
    opts?: { cwd?: string; timeout?: number },
  ) => Promise<{ stdout: string; stderr: string }>;
  /** Read a file as utf-8 text. Defaults to `fs/promises`. */
  readFile?: (absPath: string) => Promise<string>;
  /** Stat a file (existence check). */
  stat?: (absPath: string) => Promise<{ isFile: () => boolean }>;
  /** Clock. */
  now?: () => number;
}

/**
 * Auto-detect a build/test command for the project rooted at `cwd`.
 *
 * Detection order:
 *   1. package.json     → pnpm/npm/yarn run <script>
 *   2. Cargo.toml       → cargo build / cargo test
 *   3. pyproject.toml   → pytest / python -m build
 *
 * Returns `null` when nothing matched. The caller is expected to pass
 * `--build-cmd` / `--test-cmd` explicitly in that case OR to treat the
 * verification step as "no-op, trust the PR author's CI".
 *
 * Pure — no process side effects. Suitable for unit tests by injecting
 * `readFile` + `stat`.
 */
export async function detectCommand(
  cwd: string,
  kind: VerifyKind,
  deps: VerifierDeps = {},
): Promise<{ command: string; detectedFrom: BuildResult["detectedFrom"] } | null> {
  const readFile = deps.readFile ?? ((p: string) => fs.readFile(p, "utf8"));
  const stat = deps.stat ?? ((p: string) => fs.stat(p));

  // package.json — pnpm preferred (our workspace uses pnpm 10), then npm.
  try {
    const pkgPath = path.join(cwd, "package.json");
    const info = await stat(pkgPath);
    if (info.isFile()) {
      const raw = await readFile(pkgPath);
      const pkg = JSON.parse(raw) as { scripts?: Record<string, string>; packageManager?: string };
      const scripts = pkg.scripts ?? {};
      const pmRaw = (pkg.packageManager ?? "").split("@")[0] ?? "";
      const pm = pmRaw === "yarn" ? "yarn" : pmRaw === "npm" ? "npm" : "pnpm";
      if (kind === "build") {
        // Prefer "build" → "compile" → "tsc".
        const s = scripts["build"] ? "build" : scripts["compile"] ? "compile" : scripts["tsc"] ? "tsc" : null;
        if (s) return { command: `${pm} run ${s}`, detectedFrom: "package.json" };
      } else {
        const s = scripts["test"] ? "test" : scripts["test:unit"] ? "test:unit" : null;
        if (s) return { command: `${pm} run ${s}`, detectedFrom: "package.json" };
      }
    }
  } catch {
    /* missing or unreadable — fall through */
  }

  // Cargo.toml
  try {
    const info = await stat(path.join(cwd, "Cargo.toml"));
    if (info.isFile()) {
      return kind === "build"
        ? { command: "cargo build", detectedFrom: "cargo.toml" }
        : { command: "cargo test", detectedFrom: "cargo.toml" };
    }
  } catch {
    /* not a rust project */
  }

  // pyproject.toml — best-effort; prefer pytest for tests, `python -m build` for build.
  try {
    const info = await stat(path.join(cwd, "pyproject.toml"));
    if (info.isFile()) {
      return kind === "build"
        ? { command: "python -m build", detectedFrom: "pyproject.toml" }
        : { command: "pytest", detectedFrom: "pyproject.toml" };
    }
  } catch {
    /* not a python project */
  }

  return null;
}

/**
 * Run a shell-style command. We split on whitespace (no quoting support) —
 * which is fine for the auto-detected commands above and for simple
 * user-supplied overrides like `pnpm build` or `npm test`. If a user
 * needs pipes / quoted args they can wrap the command in a script file
 * and pass `./scripts/verify.sh`.
 */
export async function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  deps: VerifierDeps = {},
): Promise<BuildResult> {
  const run =
    deps.run ??
    (async (cmd, args, opts) => {
      const { stdout, stderr } = await execFile(cmd, args as string[], {
        ...(opts?.cwd ? { cwd: opts.cwd } : {}),
        ...(opts?.timeout ? { timeout: opts.timeout } : {}),
        maxBuffer: 20 * 1024 * 1024,
      });
      return { stdout, stderr };
    });
  const now = deps.now ?? (() => Date.now());

  const parts = command.trim().split(/\s+/);
  const bin = parts[0] ?? "";
  const args = parts.slice(1);

  const start = now();
  try {
    const { stdout, stderr } = await run(bin, args, { cwd, timeout: timeoutMs });
    return {
      success: true,
      command,
      stdout,
      stderr,
      durationMs: now() - start,
      detectedFrom: "explicit",
    };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      killed?: boolean;
      signal?: string;
      code?: number | string;
    };
    const timedOut = e.killed === true && (e.signal === "SIGTERM" || e.signal === "SIGKILL");
    return {
      success: false,
      command,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? (e.message ?? ""),
      durationMs: now() - start,
      detectedFrom: "explicit",
      ...(timedOut ? { timedOut: true } : {}),
    };
  }
}

/**
 * High-level helper: detect + run in one shot. `explicit` overrides
 * detection entirely. Returns `null` when nothing was detected AND no
 * override was given — callers treat that as "verification skipped,
 * trust the CI".
 */
export async function verify(
  cwd: string,
  kind: VerifyKind,
  opts: { explicit?: string; timeoutMs?: number } = {},
  deps: VerifierDeps = {},
): Promise<BuildResult | null> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000; // 5 min default
  if (opts.explicit) {
    const result = await runCommand(opts.explicit, cwd, timeoutMs, deps);
    return { ...result, detectedFrom: "explicit" };
  }
  const detected = await detectCommand(cwd, kind, deps);
  if (!detected) return null;
  const result = await runCommand(detected.command, cwd, timeoutMs, deps);
  return { ...result, detectedFrom: detected.detectedFrom };
}

/**
 * Summarise a BuildResult's stderr/stdout tail into a short message
 * suitable for re-prompting the worker. Keeps only the last 2KB — the
 * head of a compilation error log is almost always noise and the
 * useful diagnostic lives at the bottom.
 */
export function summarizeFailure(result: BuildResult): string {
  const tail = (result.stderr || result.stdout || "").slice(-2048);
  const prefix = result.timedOut
    ? `Command "${result.command}" TIMED OUT after ${result.durationMs}ms.`
    : `Command "${result.command}" exited non-zero after ${result.durationMs}ms.`;
  return `${prefix}\n--- tail ---\n${tail}`;
}
