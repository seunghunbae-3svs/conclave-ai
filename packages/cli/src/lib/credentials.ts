/**
 * credentials.ts — persistent per-user API key storage (v0.7.4).
 *
 * Eliminates the daily "paste API key into PowerShell" friction that has
 * leaked keys multiple times. Keys are stored once via `conclave config`
 * and then resolved from disk for every subsequent `conclave` invocation
 * (including autofix's subprocess spawns of `conclave review`).
 *
 * Storage layout (JSON, file mode 0600 / Windows ACL current-user-only):
 *
 *   Windows:       %USERPROFILE%\.conclave\credentials.json
 *   macOS / Linux: ~/.config/conclave/credentials.json
 *
 * Resolution order for `resolveKey(name)`:
 *
 *   1. Env var (ANTHROPIC_API_KEY etc.)   — CI keeps working unchanged
 *   2. On-disk credentials.json            — populated via `conclave config`
 *   3. undefined                           — downstream treats as "agent skip"
 *
 * No encryption at rest for v0.7.4. File-mode 0600 on Unix, Windows ACL
 * restriction via `icacls` on Windows. Encryption + Credential Manager
 * integration is tracked for v0.8+.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type CredentialKeyName =
  | "anthropic"
  | "openai"
  | "gemini"
  | "conclave-token"
  | "xai";

export const ALL_KEY_NAMES: readonly CredentialKeyName[] = [
  "anthropic",
  "openai",
  "gemini",
  "conclave-token",
  "xai",
] as const;

/**
 * On-disk format (version 1). Kept boring on purpose — plain JSON so a
 * panicked user with a text editor can still repair / clear it.
 */
export interface CredentialsFile {
  version: 1;
  keys: Partial<Record<CredentialKeyName, string>>;
  createdAt: string;
  updatedAt: string;
}

/**
 * In-memory view of stored credentials. Returned by `loadCredentials()`.
 * Missing keys are absent rather than empty-string to simplify the
 * "is this key set?" check downstream.
 */
export interface Credentials {
  anthropic?: string;
  openai?: string;
  gemini?: string;
  "conclave-token"?: string;
  xai?: string;
}

/**
 * Map each credential name to the env var(s) that take precedence.
 * `gemini` accepts either GEMINI_API_KEY or GOOGLE_API_KEY (SDK accepts
 * both historically — resolving from either kept parity with the old
 * direct-env behavior in review.ts).
 */
const ENV_VAR_MAP: Record<CredentialKeyName, readonly string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  "conclave-token": ["CONCLAVE_TOKEN"],
  xai: ["XAI_API_KEY"],
};

/**
 * Returns the OS-appropriate directory that holds `credentials.json`.
 * Windows goes under %USERPROFILE%\.conclave (dotfile style, parallels
 * ~/.conclave on Unix for people moving between platforms). macOS / Linux
 * follows XDG-ish `~/.config/conclave`.
 */
export function credentialsDir(): string {
  if (process.platform === "win32") {
    const home = process.env["USERPROFILE"] ?? os.homedir();
    return path.join(home, ".conclave");
  }
  const xdg = process.env["XDG_CONFIG_HOME"];
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "conclave");
}

export function credentialsPath(): string {
  return path.join(credentialsDir(), "credentials.json");
}

/**
 * Read the stored credentials file. Missing file → empty object (fresh
 * install, first run). Malformed JSON throws with a clear message and
 * does NOT nuke the file — we'd rather fail loud than silently wipe keys.
 */
export function loadCredentials(): Credentials {
  const p = credentialsPath();
  if (!fs.existsSync(p)) return {};
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch (err) {
    throw new Error(
      `credentials: failed to read ${p} — ${(err as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `credentials: malformed JSON in ${p} — ${(err as Error).message}. Fix or remove the file; keys were NOT wiped.`,
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("keys" in parsed) ||
    typeof (parsed as { keys: unknown }).keys !== "object"
  ) {
    throw new Error(
      `credentials: ${p} is missing the required "keys" object. Fix or remove the file.`,
    );
  }
  const keys = (parsed as { keys: Record<string, unknown> }).keys;
  const out: Credentials = {};
  for (const name of ALL_KEY_NAMES) {
    const v = keys[name];
    if (typeof v === "string" && v.length > 0) {
      out[name] = v;
    }
  }
  return out;
}

/**
 * Write the credentials file with restrictive permissions. On Unix we
 * chmod 0600 after write. On Windows we shell out to `icacls` to strip
 * inherited ACLs and grant only the current user — failures here are
 * logged to stderr but do NOT abort the write; the file still exists
 * under %USERPROFILE% which is already user-private on standard setups.
 */
export function saveCredentials(
  creds: Credentials,
  opts: { createdAt?: string } = {},
): void {
  const dir = credentialsDir();
  fs.mkdirSync(dir, { recursive: true });
  const p = credentialsPath();
  const now = new Date().toISOString();
  let createdAt = opts.createdAt ?? now;
  // Preserve the original createdAt if the file already exists.
  if (!opts.createdAt && fs.existsSync(p)) {
    try {
      const prev = JSON.parse(fs.readFileSync(p, "utf8")) as {
        createdAt?: string;
      };
      if (typeof prev.createdAt === "string") createdAt = prev.createdAt;
    } catch {
      // corrupted previous file — fall through, treat as fresh.
    }
  }
  const keysObj: Partial<Record<CredentialKeyName, string>> = {};
  for (const name of ALL_KEY_NAMES) {
    const v = creds[name];
    if (typeof v === "string" && v.length > 0) keysObj[name] = v;
  }
  const payload: CredentialsFile = {
    version: 1,
    keys: keysObj,
    createdAt,
    updatedAt: now,
  };
  // Write atomically via rename so a mid-write crash never leaves a
  // half-written credentials file.
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", "utf8");
  try {
    // Permission-tighten BEFORE the rename so the final inode is already
    // locked-down. If the rename races something, the permissions stick.
    if (process.platform !== "win32") {
      fs.chmodSync(tmp, 0o600);
    }
    fs.renameSync(tmp, p);
    if (process.platform === "win32") {
      restrictWindowsAcl(p);
    }
  } catch (err) {
    // Best-effort cleanup; rethrow.
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/**
 * Strip inherited ACLs and grant the credentials file exclusively to the
 * current user. Silent-skips if icacls is missing (very stripped-down
 * Windows Server images); the file still lives under %USERPROFILE%
 * which is user-private by default.
 */
function restrictWindowsAcl(filePath: string): void {
  const user = process.env["USERNAME"] ?? process.env["USER"];
  if (!user) return;
  try {
    // /inheritance:r removes inherited ACEs; then grant current user :F (full).
    execFileSync("icacls", [filePath, "/inheritance:r"], { stdio: "ignore" });
    execFileSync("icacls", [filePath, "/grant:r", `${user}:F`], {
      stdio: "ignore",
    });
  } catch {
    // icacls unavailable or denied — filesystem ACL fallback to %USERPROFILE%
    // inheritance (still user-private). Surface a one-line diagnostic to
    // stderr so security-conscious users notice.
    process.stderr.write(
      `conclave config: icacls restriction failed (file is still in your user profile, but verify ACLs manually)\n`,
    );
  }
}

/**
 * Resolve a credential by name: env var wins, then stored, then undefined.
 *
 * Downstream agents treat `undefined` as "skip this agent" — matching the
 * pre-v0.7.4 behavior where an unset env var also skipped the agent.
 */
export function resolveKey(
  name: CredentialKeyName,
  opts: { env?: NodeJS.ProcessEnv; stored?: Credentials } = {},
): string | undefined {
  const env = opts.env ?? process.env;
  for (const envName of ENV_VAR_MAP[name]) {
    const v = env[envName];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  const stored = opts.stored ?? safeLoad();
  const fromStored = stored[name];
  if (typeof fromStored === "string" && fromStored.length > 0) return fromStored;
  return undefined;
}

/**
 * loadCredentials() wrapped so a malformed file doesn't break `resolveKey`
 * for callers that just want a best-effort read. We still honor env vars
 * when the file is broken.
 */
function safeLoad(): Credentials {
  try {
    return loadCredentials();
  } catch {
    return {};
  }
}

/**
 * Mask a secret for display: shows length + last 4 chars. Never prints
 * the full key. Called from `config list` / `config get` (without
 * --show-raw) and anywhere a stored key ends up in CLI output.
 */
export function maskKey(value: string): string {
  if (value.length === 0) return "(empty)";
  if (value.length <= 4) return `len=${value.length} ${"*".repeat(value.length)}`;
  const tail = value.slice(-4);
  return `len=${value.length} ...${tail}`;
}

/**
 * Pull env var values into the stored credentials file — used by
 * `conclave config migrate` to one-shot convert an existing shell-env
 * setup into persistent storage. Only writes keys that are actually
 * present in env; existing stored keys are preserved when env is empty
 * (non-destructive merge).
 */
export function migrateFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): { imported: CredentialKeyName[]; stored: Credentials } {
  const existing = (() => {
    try {
      return loadCredentials();
    } catch {
      return {};
    }
  })();
  const imported: CredentialKeyName[] = [];
  const next: Credentials = { ...existing };
  for (const name of ALL_KEY_NAMES) {
    for (const envName of ENV_VAR_MAP[name]) {
      const v = env[envName];
      if (typeof v === "string" && v.trim().length > 0) {
        next[name] = v.trim();
        imported.push(name);
        break;
      }
    }
  }
  if (imported.length > 0) saveCredentials(next);
  return { imported, stored: next };
}

/**
 * Remove a single key and persist. Returns true if something was removed.
 */
export function unsetKey(name: CredentialKeyName): boolean {
  const existing = (() => {
    try {
      return loadCredentials();
    } catch {
      return {};
    }
  })();
  if (existing[name] === undefined) return false;
  const next: Credentials = { ...existing };
  delete next[name];
  saveCredentials(next);
  return true;
}

/**
 * Set a single key and persist. Empty / whitespace-only values throw —
 * if a user wants to clear a key they should use `unsetKey`.
 */
export function setKey(name: CredentialKeyName, value: string): void {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(
      `credentials: refusing to store empty value for "${name}" (use 'conclave config unset' to remove)`,
    );
  }
  const existing = (() => {
    try {
      return loadCredentials();
    } catch {
      return {};
    }
  })();
  const next: Credentials = { ...existing, [name]: trimmed };
  saveCredentials(next);
}

/**
 * Map a stored-key name back to the canonical env var it shadows. Used
 * by `config list` to show users "this key maps to ANTHROPIC_API_KEY"
 * when they're debugging env-vs-stored precedence.
 */
export function primaryEnvVar(name: CredentialKeyName): string {
  const vars = ENV_VAR_MAP[name];
  const first = vars[0];
  if (first === undefined) {
    throw new Error(`credentials: no env var registered for ${name}`);
  }
  return first;
}

/**
 * Populate env vars from stored credentials when the env is empty.
 *
 * Rationale: several downstream packages (integration-telegram, agent-*
 * readmes, visual-review judge) read `process.env[...]` directly. Rather
 * than plumb `resolveKey` through every package (which would balloon this
 * PR), we hydrate the process env from storage at CLI entry points. The
 * precedence contract holds — env wins, we only fill blanks.
 *
 * Returns the list of env var names that were populated from storage
 * (empty if env was already set or storage was empty). Primarily used
 * for diagnostics.
 *
 * IMPORTANT: do NOT call this from library code that might be used
 * outside the CLI — it's scoped to the `conclave` binary on purpose.
 */
export function hydrateEnvFromStorage(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  let stored: Credentials;
  try {
    stored = loadCredentials();
  } catch {
    return [];
  }
  const populated: string[] = [];
  for (const name of ALL_KEY_NAMES) {
    const value = stored[name];
    if (!value) continue;
    const envVars = ENV_VAR_MAP[name];
    // If ANY of the mapped env vars is already set (and non-empty), leave
    // the env alone — user / CI intent wins.
    const alreadySet = envVars.some((v) => {
      const existing = env[v];
      return typeof existing === "string" && existing.trim().length > 0;
    });
    if (alreadySet) continue;
    // Only populate the primary env var. Gemini's GOOGLE_API_KEY alias
    // is read-only from the user's side; we don't shadow it.
    const primary = envVars[0];
    if (!primary) continue;
    env[primary] = value;
    populated.push(primary);
  }
  return populated;
}
