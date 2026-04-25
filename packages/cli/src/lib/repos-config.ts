import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * v0.12 — multi-repo watch list. Stored alongside credentials so a
 * single user-config dir holds every per-user piece of conclave state:
 *
 *   Windows:       %USERPROFILE%\.conclave\repos.json
 *   macOS / Linux: ~/.config/conclave/repos.json   (XDG-ish)
 *
 * File mode mirrors credentials.json — 0600 / Windows ACL — even though
 * a repo slug isn't sensitive, because the file SITS NEXT TO secrets and
 * a permissive default would normalize loose perms in that directory.
 *
 * Schema is v1; future additions (e.g. per-repo polling cadence,
 * per-repo notification preference) can land as new optional fields
 * without bumping the version.
 */

export interface ReposConfig {
  version: 1;
  repos: ReposEntry[];
}

export interface ReposEntry {
  /** "owner/name" — validated to match the GitHub slug grammar. */
  slug: string;
  /** ISO-8601 UTC timestamp when this repo was added to the watch list. */
  addedAt: string;
  /** Optional override for the per-repo poll cadence (seconds). When
   * absent, `conclave watch --interval` (or its default) applies. */
  pollIntervalSec?: number;
}

const SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function isValidSlug(s: string): boolean {
  return SLUG_RE.test(s) && s.length <= 200;
}

export function reposDir(): string {
  if (process.platform === "win32") {
    const home = process.env["USERPROFILE"] ?? os.homedir();
    return path.join(home, ".conclave");
  }
  const xdg = process.env["XDG_CONFIG_HOME"];
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "conclave");
}

export function reposPath(): string {
  return path.join(reposDir(), "repos.json");
}

/**
 * Read the watch list. Missing file → empty list (fresh install).
 * Malformed JSON throws with a path-prefixed message; we deliberately
 * do NOT silently wipe a corrupt file.
 */
export function loadRepos(): ReposConfig {
  const p = reposPath();
  if (!fs.existsSync(p)) return { version: 1, repos: [] };
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch (err) {
    throw new Error(`failed to read ${p}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`malformed ${p}: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`${p}: top-level must be an object`);
  }
  const obj = parsed as { version?: unknown; repos?: unknown };
  if (obj.version !== 1) {
    throw new Error(`${p}: unsupported version ${String(obj.version)} (expected 1)`);
  }
  if (!Array.isArray(obj.repos)) {
    throw new Error(`${p}: 'repos' must be an array`);
  }
  const out: ReposEntry[] = [];
  for (const r of obj.repos) {
    if (!r || typeof r !== "object") continue;
    const e = r as { slug?: unknown; addedAt?: unknown; pollIntervalSec?: unknown };
    if (typeof e.slug !== "string" || !isValidSlug(e.slug)) continue;
    if (typeof e.addedAt !== "string") continue;
    const entry: ReposEntry = { slug: e.slug, addedAt: e.addedAt };
    if (typeof e.pollIntervalSec === "number" && Number.isFinite(e.pollIntervalSec) && e.pollIntervalSec > 0) {
      entry.pollIntervalSec = e.pollIntervalSec;
    }
    out.push(entry);
  }
  return { version: 1, repos: out };
}

/**
 * Atomic write. Mirror credentialsPath's tmp-then-rename + chmod 0600
 * so the file can sit next to credentials without weakening their
 * permission posture.
 */
export function saveRepos(cfg: ReposConfig): void {
  const dir = reposDir();
  fs.mkdirSync(dir, { recursive: true });
  const p = reposPath();
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, p);
  // Best-effort chmod on Unix; no-op on Windows where mode is ignored.
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(p, 0o600);
    } catch {
      /* ignore — mode was already set on creation */
    }
  }
}

/**
 * Add a repo to the watch list. Idempotent: re-adding a slug that's
 * already present returns the existing config unchanged. Returns
 * `{ added: boolean, config }` so the CLI can print the right verb.
 */
export function addRepo(slug: string, now: string = new Date().toISOString()): {
  added: boolean;
  config: ReposConfig;
} {
  if (!isValidSlug(slug)) {
    throw new Error(`invalid repo slug: ${slug} (expected 'owner/name')`);
  }
  const cfg = loadRepos();
  const exists = cfg.repos.some((r) => r.slug === slug);
  if (exists) return { added: false, config: cfg };
  const next: ReposConfig = {
    version: 1,
    repos: [...cfg.repos, { slug, addedAt: now }],
  };
  saveRepos(next);
  return { added: true, config: next };
}

/**
 * Remove a repo from the watch list. Returns `{ removed: boolean }` so
 * the CLI can distinguish a successful removal from a no-op (slug
 * wasn't present).
 */
export function removeRepo(slug: string): { removed: boolean; config: ReposConfig } {
  const cfg = loadRepos();
  const before = cfg.repos.length;
  const after = cfg.repos.filter((r) => r.slug !== slug);
  if (after.length === before) return { removed: false, config: cfg };
  const next: ReposConfig = { version: 1, repos: after };
  saveRepos(next);
  return { removed: true, config: next };
}
