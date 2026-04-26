#!/usr/bin/env node
/**
 * v0.13.12 — bump only the packages whose files changed since the
 * last release tag. Replaces the old lockstep `pnpm -r exec npm
 * version $BUMP` step.
 *
 * Why: in lockstep mode, every package's version advances every
 * release — even packages with zero file changes since the last tag.
 * That made `git log --oneline @conclave-ai/agent-design@0.9.x..@conclave-ai/agent-design@0.10.0`
 * meaningless (the tag advanced; the code didn't), and burned npm
 * publishing bandwidth on no-op tarballs.
 *
 * Behaviour:
 *   - The "tag-driver" package (core, by convention) ALWAYS bumps.
 *     This guarantees the v$CORE_VERSION tag advances every release
 *     so the existing release.yml tag-pinning logic keeps working.
 *   - Every other package under packages/* bumps ONLY when at least
 *     one file under that package directory changed since the
 *     previous v* tag.
 *   - If no previous v* tag exists (very first release), every
 *     package bumps. Same behaviour as the legacy lockstep path.
 *   - The bump kind comes from the BUMP env var (patch/minor/major).
 *
 * Output: a JSON summary on stdout listing { bumped: [...], skipped: [...] }
 * so the caller can echo it into the release commit body / GitHub
 * step summary.
 *
 * Exit codes:
 *   0   normal — at least the driver package was bumped
 *   2   misuse (BUMP env not set, no packages dir, etc.)
 */

import { execSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";

const DRIVER_PACKAGE = "core"; // packages/core — drives the v$X.Y.Z tag
const BUMP_KINDS = new Set(["patch", "minor", "major"]);

function git(args, opts = {}) {
  try {
    return execSync(`git ${args}`, {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      ...opts,
    }).trimEnd();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`git ${args} failed: ${msg}`);
  }
}

/** Find the most recent annotated/lightweight v* tag reachable from HEAD. */
export function findPreviousTag() {
  try {
    return execSync('git describe --tags --match "v*" --abbrev=0', {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trimEnd();
  } catch {
    return null;
  }
}

/** Returns the list of files changed between `prevTag` and HEAD. */
export function changedFilesSince(prevTag) {
  if (!prevTag) return null; // null sentinel = no baseline → everything is changed
  const out = git(`diff --name-only ${prevTag}..HEAD`);
  return out ? out.split("\n") : [];
}

/** True iff any path under `packages/<name>/` is in `changed`. */
export function packageChangedFromList(name, changed) {
  if (changed === null) return true; // first release / no baseline
  const prefix = `packages/${name}/`;
  return changed.some((p) => p.startsWith(prefix));
}

export function listPackages(packagesDir) {
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

export function readVersion(pkgDir) {
  const json = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  return json.version;
}

export function bumpVersionFile(pkgDir, kind) {
  const file = path.join(pkgDir, "package.json");
  const json = JSON.parse(readFileSync(file, "utf8"));
  const current = json.version;
  const next = nextVersion(current, kind);
  json.version = next;
  writeFileSync(file, JSON.stringify(json, null, 2) + "\n", "utf8");
  return { from: current, to: next };
}

/**
 * Compute the next semver string by kind. Supports the three pre-1.0
 * shapes we use (X.Y.Z) — does NOT preserve pre-release tags. Drops
 * any +build metadata.
 */
export function nextVersion(version, kind) {
  if (!BUMP_KINDS.has(kind)) {
    throw new Error(`unknown bump kind: ${kind}`);
  }
  const core = version.split(/[-+]/, 1)[0];
  const parts = core.split(".").map((n) => parseInt(n, 10));
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) {
    throw new Error(`unparseable version: ${version}`);
  }
  let [major, minor, patch] = parts;
  if (kind === "major") {
    major += 1; minor = 0; patch = 0;
  } else if (kind === "minor") {
    minor += 1; patch = 0;
  } else {
    patch += 1;
  }
  return `${major}.${minor}.${patch}`;
}

/**
 * Pure orchestration — takes the list of packages + a "did this
 * package change?" predicate + a "bump this package's version
 * file" effect, and returns the summary. Lets tests drive the
 * decision tree without touching disk or git.
 */
export function planBumps(packages, isChanged, bumpFn, opts = {}) {
  const driver = opts.driver ?? DRIVER_PACKAGE;
  const result = { bumped: [], skipped: [] };
  for (const name of packages) {
    if (name === driver || isChanged(name)) {
      const r = bumpFn(name);
      result.bumped.push({ name, ...r });
    } else {
      result.skipped.push({ name });
    }
  }
  return result;
}

// ---- main --------------------------------------------------------------

async function main() {
  const bump = process.env.BUMP;
  if (!bump || !BUMP_KINDS.has(bump)) {
    process.stderr.write(`BUMP env var must be one of: ${[...BUMP_KINDS].join(", ")}\n`);
    process.exit(2);
  }
  const repoRoot = process.cwd();
  const packagesDir = path.join(repoRoot, "packages");
  let dirs;
  try {
    dirs = listPackages(packagesDir).filter((n) => {
      try {
        return statSync(path.join(packagesDir, n, "package.json")).isFile();
      } catch {
        return false;
      }
    });
  } catch (err) {
    process.stderr.write(`Cannot read packages dir: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
  if (dirs.length === 0) {
    process.stderr.write("No packages found under packages/\n");
    process.exit(2);
  }
  const prevTag = findPreviousTag();
  const changed = changedFilesSince(prevTag);
  const summary = planBumps(
    dirs,
    (name) => packageChangedFromList(name, changed),
    (name) => bumpVersionFile(path.join(packagesDir, name), bump),
  );
  process.stdout.write(JSON.stringify({
    bump,
    prevTag,
    changedFiles: changed === null ? null : changed.length,
    ...summary,
  }, null, 2) + "\n");
}

// Run main() only when invoked as a script, not when imported by tests.
const invokedDirectly = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`;
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`bump-changed-packages failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(2);
  });
}
