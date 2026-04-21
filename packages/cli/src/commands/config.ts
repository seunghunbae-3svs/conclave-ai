/**
 * `conclave config` — persistent per-user credential storage (v0.7.4).
 *
 * Eliminates the daily API-key-paste friction. One-time interactive setup
 * via `conclave config`; programmatic access via `conclave config set/get/
 * list/unset/path/migrate`. Values live in %USERPROFILE%\.conclave\
 * credentials.json (Windows) or ~/.config/conclave/credentials.json
 * (Unix, chmod 600). Env vars keep winning, so CI is unaffected.
 */
import {
  ALL_KEY_NAMES,
  credentialsPath,
  loadCredentials,
  maskKey,
  migrateFromEnv,
  primaryEnvVar,
  resolveKey,
  setKey,
  unsetKey,
  type Credentials,
  type CredentialKeyName,
} from "../lib/credentials.js";
import { createPrompter, type Prompter } from "./init/prompts.js";

const HELP = `conclave config — persistent per-user credential storage (v0.7.4)

Usage:
  conclave config                              # interactive TUI — set all keys
  conclave config set <key> [<value>]          # programmatic set (prompts if value omitted)
  conclave config set <key> -                  # read value from stdin
  conclave config get <key> [--show-raw]       # print value (masked by default)
  conclave config list                         # list keys with length + last-4 chars
  conclave config unset <key>                  # remove a key
  conclave config path                         # print storage path
  conclave config migrate                      # import current env-var values into storage

Supported keys:
  anthropic          (ANTHROPIC_API_KEY)
  openai             (OPENAI_API_KEY)
  gemini             (GEMINI_API_KEY or GOOGLE_API_KEY)
  conclave-token     (CONCLAVE_TOKEN — central plane bearer)
  xai                (XAI_API_KEY)

Resolution order for every conclave command:
  1. Env var           — CI / CD keep working unchanged
  2. Stored config     — populated by this command
  3. Nothing           — agent skipped

Storage:
  Windows: %USERPROFILE%\\.conclave\\credentials.json (ACL: current user only)
  Unix:    ~/.config/conclave/credentials.json (chmod 600)

No encryption at rest in v0.7.4. Master-password + OS keychain integration
tracked for v0.8+.
`;

type SubCommand = "set" | "get" | "list" | "unset" | "path" | "migrate" | "tui";

export interface ConfigDeps {
  prompterFactory?: () => Prompter;
  /** Override stdin read for the "read from stdin" path. */
  readStdin?: () => Promise<string>;
  /** Override environment for tests. */
  env?: NodeJS.ProcessEnv;
}

function parseKeyName(raw: string): CredentialKeyName {
  if ((ALL_KEY_NAMES as readonly string[]).includes(raw)) {
    return raw as CredentialKeyName;
  }
  throw new Error(
    `conclave config: unknown key "${raw}". Supported: ${ALL_KEY_NAMES.join(", ")}`,
  );
}

async function readStdinAll(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buf += chunk;
    });
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", reject);
    process.stdin.resume();
  });
}

/**
 * Interactive TUI — walks each supported key, shows current status,
 * lets the user keep / replace / skip. Default path for `conclave
 * config` with no args.
 */
async function runTui(
  deps: ConfigDeps,
  existing: Credentials,
): Promise<{ updated: Credentials; changed: CredentialKeyName[] }> {
  const prompter = (deps.prompterFactory ?? createPrompter)();
  const changed: CredentialKeyName[] = [];
  const next: Credentials = { ...existing };
  try {
    process.stdout.write(
      `conclave config — interactive setup\n\n` +
        `For each key, press Enter to keep the existing value (or skip if unset),\n` +
        `or paste a new value (masked). Ctrl+C aborts without saving.\n\n`,
    );
    for (const name of ALL_KEY_NAMES) {
      const current = existing[name];
      const envName = primaryEnvVar(name);
      const statusLine = current
        ? `  current: stored (${maskKey(current)})`
        : `  current: not set`;
      process.stdout.write(`${name} (${envName})\n${statusLine}\n`);
      const entered = await prompter.askSecret(`  new value`);
      if (!entered) {
        process.stdout.write(`  → keeping existing\n\n`);
        continue;
      }
      next[name] = entered;
      changed.push(name);
      process.stdout.write(`  → saved (${maskKey(entered)})\n\n`);
    }
  } finally {
    prompter.close();
  }
  return { updated: next, changed };
}

export async function config(
  argv: string[],
  deps: ConfigDeps = {},
): Promise<void> {
  if (argv.length === 0) {
    // Interactive TUI path.
    const existing = safeLoad();
    const { updated, changed } = await runTui(deps, existing);
    if (changed.length === 0) {
      process.stdout.write(
        `conclave config: no changes. keys stored in ${credentialsPath()}\n`,
      );
      return;
    }
    // saveCredentials is called via setKey per-entry would be chatty —
    // instead persist once at the end for fewer disk writes.
    const { saveCredentials } = await import("../lib/credentials.js");
    saveCredentials(updated);
    process.stdout.write(
      `conclave config: ${changed.length} key(s) stored in ${credentialsPath()} ` +
        `(${process.platform === "win32" ? "ACL: user-only" : "mode 600"})\n`,
    );
    return;
  }
  const [sub, ...rest] = argv;
  if (sub === "--help" || sub === "-h" || sub === "help") {
    process.stdout.write(HELP);
    return;
  }

  const subCommand: SubCommand =
    sub === "set" ||
    sub === "get" ||
    sub === "list" ||
    sub === "unset" ||
    sub === "path" ||
    sub === "migrate"
      ? sub
      : (() => {
          throw new Error(
            `conclave config: unknown subcommand "${sub}"\n\n${HELP}`,
          );
        })();

  switch (subCommand) {
    case "set":
      await runSet(rest, deps);
      return;
    case "get":
      await runGet(rest, deps);
      return;
    case "list":
      await runList(deps);
      return;
    case "unset":
      await runUnset(rest);
      return;
    case "path":
      process.stdout.write(`${credentialsPath()}\n`);
      return;
    case "migrate":
      await runMigrate(deps);
      return;
    default:
      process.stdout.write(HELP);
  }
}

async function runSet(rest: string[], deps: ConfigDeps): Promise<void> {
  const rawName = rest[0];
  if (!rawName) {
    throw new Error(
      `conclave config set: missing key name. Usage: conclave config set <key> [<value>|-]`,
    );
  }
  const name = parseKeyName(rawName);
  const valueArg = rest[1];
  let value: string;
  if (valueArg === "-") {
    const reader = deps.readStdin ?? readStdinAll;
    value = (await reader()).trim();
    if (!value) {
      throw new Error(`conclave config set: stdin was empty for "${name}"`);
    }
  } else if (valueArg !== undefined) {
    value = valueArg;
  } else {
    // Interactive secret prompt.
    const prompter = (deps.prompterFactory ?? createPrompter)();
    try {
      value = await prompter.askSecret(`${name} (${primaryEnvVar(name)})`, {
        required: true,
      });
    } finally {
      prompter.close();
    }
  }
  setKey(name, value);
  process.stdout.write(
    `conclave config set ${name}: stored (${maskKey(value)})\n`,
  );
}

async function runGet(rest: string[], _deps: ConfigDeps): Promise<void> {
  const rawName = rest[0];
  if (!rawName) {
    throw new Error(
      `conclave config get: missing key name. Usage: conclave config get <key> [--show-raw]`,
    );
  }
  const name = parseKeyName(rawName);
  const showRaw = rest.includes("--show-raw");
  const stored = safeLoad();
  const value = stored[name];
  if (value === undefined) {
    // Fall through to env so users can verify what resolveKey would pick.
    const envFallback = resolveKey(name);
    if (envFallback === undefined) {
      process.stderr.write(
        `conclave config get: "${name}" is not set (neither env nor stored)\n`,
      );
      process.exit(1);
      return;
    }
    process.stdout.write(
      showRaw
        ? `${envFallback} (from env: ${primaryEnvVar(name)})\n`
        : `${maskKey(envFallback)} (from env: ${primaryEnvVar(name)})\n`,
    );
    return;
  }
  process.stdout.write(showRaw ? `${value}\n` : `${maskKey(value)}\n`);
}

async function runList(_deps: ConfigDeps): Promise<void> {
  const stored = safeLoad();
  process.stdout.write(`conclave config — ${credentialsPath()}\n`);
  for (const name of ALL_KEY_NAMES) {
    const envName = primaryEnvVar(name);
    const envVal = process.env[envName];
    const storedVal = stored[name];
    if (envVal && envVal.trim().length > 0) {
      process.stdout.write(
        `  ${name.padEnd(16)} env ${envName}   ${maskKey(envVal.trim())}${storedVal ? ` (also stored)` : ""}\n`,
      );
    } else if (storedVal) {
      process.stdout.write(
        `  ${name.padEnd(16)} stored ${envName}   ${maskKey(storedVal)}\n`,
      );
    } else {
      process.stdout.write(
        `  ${name.padEnd(16)} not set (${envName} unset, no stored value)\n`,
      );
    }
  }
}

async function runUnset(rest: string[]): Promise<void> {
  const rawName = rest[0];
  if (!rawName) {
    throw new Error(
      `conclave config unset: missing key name. Usage: conclave config unset <key>`,
    );
  }
  const name = parseKeyName(rawName);
  const removed = unsetKey(name);
  if (removed) {
    process.stdout.write(`conclave config unset ${name}: removed\n`);
  } else {
    process.stdout.write(
      `conclave config unset ${name}: nothing to remove (not stored)\n`,
    );
  }
}

async function runMigrate(deps: ConfigDeps): Promise<void> {
  const { imported } = migrateFromEnv(deps.env ?? process.env);
  if (imported.length === 0) {
    process.stdout.write(
      `conclave config migrate: no supported env vars set; nothing to import.\n`,
    );
    return;
  }
  process.stdout.write(
    `conclave config migrate: imported ${imported.length} key(s) → ${credentialsPath()}\n` +
      imported.map((k) => `  - ${k} (${primaryEnvVar(k)})\n`).join(""),
  );
}

function safeLoad(): Credentials {
  try {
    return loadCredentials();
  } catch (err) {
    process.stderr.write(
      `conclave config: ${(err as Error).message}\n` +
        `  using empty storage for this run; fix the file to recover stored keys.\n`,
    );
    return {};
  }
}
