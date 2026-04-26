import { promises as fs } from "node:fs";
import path from "node:path";
import { CLI_VERSION } from "../version.js";

/**
 * `conclave doctor` — single-command diagnostic of the install + central-
 * plane state. Runs a small fixed set of checks and prints one line per
 * check with `[OK]` / `[WARN]` / `[FAIL]` + a remediation hint. No LLM
 * calls, no billable subprocesses — safe to run any time.
 *
 * v0.13.7 scope (deliberately narrow):
 *   1. env: ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY / CONCLAVE_TOKEN
 *   2. central-plane /healthz returns 2xx
 *   3. workflow files in .github/workflows/ pin to the expected reusable
 *   4. installed CLI version vs latest published on npm
 *
 * Out of scope (would need install-specific tokens or design work):
 *   - Telegram webhook binding (needs the bot token; varies per install)
 *   - D1 schema introspection (lives behind the worker)
 *   - Per-repo dispatch readiness (covered by existing `repos list`)
 */

const DEFAULT_WORKER_HEALTH = "https://conclave-ai.seunghunbae.workers.dev/healthz";
const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org/@conclave-ai/cli/latest";
const EXPECTED_REUSABLE_REPO = "seunghunbae-3svs/conclave-ai";
const EXPECTED_REUSABLE_TAG = "v0.4";
const HTTP_TIMEOUT_MS = 8_000;

export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorCheckResult {
  readonly key: string;
  readonly label: string;
  readonly status: DoctorStatus;
  readonly detail?: string;
  readonly hint?: string;
}

export interface DoctorDeps {
  /** Read text file. Defaults to fs/promises.readFile(... , "utf8"). */
  readonly readFile?: (absPath: string) => Promise<string>;
  /** List directory entries. Defaults to fs/promises.readdir. */
  readonly readDir?: (absPath: string) => Promise<readonly string[]>;
  /** Returns true if the path exists. Defaults to fs.access. */
  readonly stat?: (absPath: string) => Promise<{ exists: boolean }>;
  /** Project root (where .github/workflows/ lives). Defaults to cwd(). */
  readonly cwd?: string;
  /** Env source. Defaults to process.env. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** HTTP fetch impl. Defaults to globalThis.fetch. */
  readonly fetch?: typeof fetch;
  /** Override worker /healthz URL (tests). */
  readonly workerHealthUrl?: string;
  /** Override npm registry URL (tests). */
  readonly npmRegistryUrl?: string;
  /** CLI version to compare against npm. Defaults to CLI_VERSION. */
  readonly cliVersion?: string;
  /** Override the expected reusable repo + tag (tests). */
  readonly expectedReusableRepo?: string;
  readonly expectedReusableTag?: string;
  /** stdout / stderr sinks. Default to process.stdout/stderr. */
  readonly stdout?: (s: string) => void;
  readonly stderr?: (s: string) => void;
}

export async function runDoctor(
  _argv: readonly string[],
  deps: DoctorDeps = {},
): Promise<{ code: number; results: DoctorCheckResult[] }> {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const cwd = deps.cwd ?? process.cwd();
  const stdout = deps.stdout ?? ((s: string) => process.stdout.write(s));

  const checks: Promise<DoctorCheckResult[]>[] = [
    Promise.resolve(checkEnvKeys(env)),
    checkWorkerHealth(deps.workerHealthUrl ?? DEFAULT_WORKER_HEALTH, fetchImpl).then((r) => [r]),
    checkWorkflowFiles(cwd, deps).then((r) => [r]),
    checkCliVersion(deps.cliVersion ?? CLI_VERSION, deps.npmRegistryUrl ?? DEFAULT_NPM_REGISTRY, fetchImpl).then((r) => [r]),
  ];
  const results = (await Promise.all(checks)).flat();

  // Print one line per check.
  for (const r of results) {
    const tag = r.status === "ok" ? "[OK]  " : r.status === "warn" ? "[WARN]" : "[FAIL]";
    stdout(`${tag} ${r.label}${r.detail ? ` — ${r.detail}` : ""}\n`);
    if (r.hint && r.status !== "ok") stdout(`       ↳ ${r.hint}\n`);
  }

  const anyFail = results.some((r) => r.status === "fail");
  const anyWarn = results.some((r) => r.status === "warn");
  if (anyFail) return { code: 1, results };
  if (anyWarn) return { code: 0, results }; // warn ≠ failure
  return { code: 0, results };
}

// ---- env keys -----------------------------------------------------------

const REQUIRED_ENV_KEYS: ReadonlyArray<{ name: string; envVars: readonly string[]; hint: string }> = [
  {
    name: "ANTHROPIC_API_KEY",
    envVars: ["ANTHROPIC_API_KEY"],
    hint: "set ANTHROPIC_API_KEY (env) or run `conclave config` to store it persistently",
  },
  {
    name: "OPENAI_API_KEY",
    envVars: ["OPENAI_API_KEY"],
    hint: "set OPENAI_API_KEY (env) or run `conclave config` to store it persistently",
  },
  {
    name: "GEMINI_API_KEY",
    envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    hint: "set GEMINI_API_KEY or GOOGLE_API_KEY, or run `conclave config`",
  },
  {
    name: "CONCLAVE_TOKEN",
    envVars: ["CONCLAVE_TOKEN"],
    hint: "set CONCLAVE_TOKEN (the central-plane shared secret) or run `conclave config`",
  },
];

export function checkEnvKeys(env: Readonly<Record<string, string | undefined>>): DoctorCheckResult[] {
  return REQUIRED_ENV_KEYS.map((spec) => {
    const present = spec.envVars.find((v) => typeof env[v] === "string" && env[v]!.length > 0);
    if (present) {
      return {
        key: `env-${spec.name.toLowerCase()}`,
        label: `env: ${spec.name}`,
        status: "ok",
        detail: `set via ${present}`,
      };
    }
    return {
      key: `env-${spec.name.toLowerCase()}`,
      label: `env: ${spec.name}`,
      status: "fail",
      detail: "not set",
      hint: spec.hint,
    };
  });
}

// ---- central-plane /healthz --------------------------------------------

export async function checkWorkerHealth(
  url: string,
  fetchImpl: typeof fetch | undefined,
): Promise<DoctorCheckResult> {
  if (!fetchImpl) {
    return {
      key: "worker-healthz",
      label: "central-plane /healthz",
      status: "warn",
      detail: "no fetch implementation available",
      hint: "run on Node 18+ where global fetch is available",
    };
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) {
      return {
        key: "worker-healthz",
        label: "central-plane /healthz",
        status: "fail",
        detail: `HTTP ${res.status}`,
        hint: "check Cloudflare Worker deploy + D1 binding (`wrangler tail` for live errors)",
      };
    }
    let detail = "200 ok";
    try {
      const body = (await res.json()) as { service?: string; version?: string; db?: string };
      if (body.service) detail = `${body.service} v${body.version ?? "?"} db=${body.db ?? "?"}`;
    } catch {
      // non-JSON body is fine — we already have 2xx
    }
    return { key: "worker-healthz", label: "central-plane /healthz", status: "ok", detail };
  } catch (err) {
    clearTimeout(t);
    return {
      key: "worker-healthz",
      label: "central-plane /healthz",
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
      hint: "verify network + worker deploy (https://conclave-ai.seunghunbae.workers.dev/)",
    };
  }
}

// ---- workflow files ----------------------------------------------------

export async function checkWorkflowFiles(cwd: string, deps: DoctorDeps): Promise<DoctorCheckResult> {
  const readDir = deps.readDir ?? (async (p: string) => fs.readdir(p));
  const readFile = deps.readFile ?? (async (p: string) => fs.readFile(p, "utf8"));
  const expectedRepo = deps.expectedReusableRepo ?? EXPECTED_REUSABLE_REPO;
  const expectedTag = deps.expectedReusableTag ?? EXPECTED_REUSABLE_TAG;
  const wfDir = path.join(cwd, ".github", "workflows");

  let entries: readonly string[];
  try {
    entries = await readDir(wfDir);
  } catch {
    return {
      key: "workflow-files",
      label: ".github/workflows/",
      status: "warn",
      detail: "no workflow directory found",
      hint: "if this repo should run conclave reviews, add the reusable workflow to .github/workflows/",
    };
  }

  // Find any YAML that references the expected reusable.
  const yamls = entries.filter((e) => e.endsWith(".yml") || e.endsWith(".yaml"));
  const matches: { file: string; tag: string | null }[] = [];
  const reusablePattern = new RegExp(`${escapeRe(expectedRepo)}/\\.github/workflows/[\\w.-]+@([\\w.-]+)`);
  for (const f of yamls) {
    let body: string;
    try {
      body = await readFile(path.join(wfDir, f));
    } catch {
      continue;
    }
    const m = body.match(reusablePattern);
    if (m) matches.push({ file: f, tag: m[1] ?? null });
  }

  if (matches.length === 0) {
    return {
      key: "workflow-files",
      label: ".github/workflows/",
      status: "warn",
      detail: `no workflow references ${expectedRepo}/.github/workflows/...`,
      hint: `add a workflow that uses ${expectedRepo}/.github/workflows/review.yml@${expectedTag}`,
    };
  }
  const stale = matches.filter((m) => m.tag !== expectedTag);
  if (stale.length > 0) {
    return {
      key: "workflow-files",
      label: ".github/workflows/",
      status: "warn",
      detail: `${stale.length} workflow(s) pin a non-${expectedTag} version: ${stale.map((s) => `${s.file}@${s.tag ?? "?"}`).join(", ")}`,
      hint: `bump the @ref to ${expectedTag} (or the current floating tag) so review behavior matches docs`,
    };
  }
  return {
    key: "workflow-files",
    label: ".github/workflows/",
    status: "ok",
    detail: `${matches.length} workflow(s) pin @${expectedTag}`,
  };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---- npm version --------------------------------------------------------

export async function checkCliVersion(
  installedVersion: string,
  registryUrl: string,
  fetchImpl: typeof fetch | undefined,
): Promise<DoctorCheckResult> {
  if (!fetchImpl) {
    return {
      key: "cli-version",
      label: "@conclave-ai/cli version",
      status: "warn",
      detail: `installed ${installedVersion} (cannot check latest — no fetch)`,
    };
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetchImpl(registryUrl, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) {
      return {
        key: "cli-version",
        label: "@conclave-ai/cli version",
        status: "warn",
        detail: `installed ${installedVersion} (npm registry HTTP ${res.status})`,
      };
    }
    const body = (await res.json()) as { version?: string };
    const latest = body.version ?? "";
    if (!latest) {
      return {
        key: "cli-version",
        label: "@conclave-ai/cli version",
        status: "warn",
        detail: `installed ${installedVersion} (registry returned no version field)`,
      };
    }
    if (compareSemver(installedVersion, latest) >= 0) {
      return {
        key: "cli-version",
        label: "@conclave-ai/cli version",
        status: "ok",
        detail: `installed ${installedVersion} (latest ${latest})`,
      };
    }
    return {
      key: "cli-version",
      label: "@conclave-ai/cli version",
      status: "warn",
      detail: `installed ${installedVersion}, latest ${latest}`,
      hint: `npm i -g @conclave-ai/cli@${latest}`,
    };
  } catch (err) {
    clearTimeout(t);
    return {
      key: "cli-version",
      label: "@conclave-ai/cli version",
      status: "warn",
      detail: `installed ${installedVersion} (registry probe failed: ${err instanceof Error ? err.message : String(err)})`,
    };
  }
}

/** Returns -1 / 0 / 1 like Array.sort comparator (semver-aware, ignores
 * pre-release tags — sufficient for the latest-vs-installed check). */
export function compareSemver(a: string, b: string): number {
  const pa = a.split(/[-+]/, 1)[0]!.split(".").map((s) => parseInt(s, 10) || 0);
  const pb = b.split(/[-+]/, 1)[0]!.split(".").map((s) => parseInt(s, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// ---- entry --------------------------------------------------------------

export async function doctor(argv: string[]): Promise<void> {
  const { code } = await runDoctor(argv);
  if (code !== 0) process.exit(code);
}
