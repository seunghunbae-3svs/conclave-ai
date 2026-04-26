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

const WORKSPACE_SCOPE = "@conclave-ai/";

/**
 * Read the workspace-internal dependencies declared by a package's
 * package.json. Returns the set of dependency names with the scope
 * prefix stripped — i.e., for `"@conclave-ai/core": "workspace:*"`
 * we return "core". Both runtime and dev deps are included; both
 * cause the consumer to be republished.
 */
export function readWorkspaceDeps(pkgDir) {
  const json = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  const out = new Set();
  for (const block of [json.dependencies, json.devDependencies, json.peerDependencies]) {
    if (!block) continue;
    for (const dep of Object.keys(block)) {
      if (dep.startsWith(WORKSPACE_SCOPE)) {
        out.add(dep.slice(WORKSPACE_SCOPE.length));
      }
    }
  }
  return out;
}

/**
 * v0.13.13 — when a package's source changes, every package that
 * declares it as a workspace dep must ALSO bump, because at publish
 * time pnpm replaces `workspace:*` with the exact current version.
 * Without this, downstream packages keep referencing the OLD core/agent
 * versions on npm, and consumers don't pick up the fix until the
 * downstream package's own source happens to change.
 *
 * Live RC: v0.13.13 fuzzy-dedupe shipped in core@0.11.13 but cli was
 * still on 0.13.12 (no source change). cli@0.13.12's published
 * package.json says `"@conclave-ai/core": "0.11.12"` (exact) — so
 * `pnpm i -g @conclave-ai/cli@0.13.12` pulls the OLD core, no fuzzy
 * dedupe. Operators wouldn't see the fix until cli's source
 * incidentally changed.
 *
 * Returns the EXPANDED set: the input changed set plus every
 * transitively-dependent package. BFS over the dependents graph.
 */
export function expandWithDependents(initiallyChanged, packagesDir, packages) {
  const dependents = new Map(); // pkg → array of pkgs that depend on it
  for (const p of packages) dependents.set(p, []);
  for (const p of packages) {
    let deps;
    try {
      deps = readWorkspaceDeps(path.join(packagesDir, p));
    } catch {
      continue;
    }
    for (const d of deps) {
      if (dependents.has(d)) dependents.get(d).push(p);
    }
  }
  const expanded = new Set(initiallyChanged);
  const queue = [...initiallyChanged];
  while (queue.length > 0) {
    const cur = queue.shift();
    for (const dependent of dependents.get(cur) ?? []) {
      if (!expanded.has(dependent)) {
        expanded.add(dependent);
        queue.push(dependent);
      }
    }
  }
  return expanded;
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
  // Initial pass: which packages have direct file changes since prev tag?
  // Always include the driver in the initial set — it will bump
  // unconditionally, and its dependents must follow (so cli +
  // every agent etc. pick up the new core version reference).
  const directlyChanged = new Set(
    dirs.filter((n) => packageChangedFromList(n, changed)),
  );
  // Expand to include transitive workspace-dep consumers — pnpm replaces
  // workspace:* with the exact current version at publish time, so any
  // dependent of a bumped package must also republish to pick up the
  // new dep version. Skip on first release (changed === null already
  // marks every package, no expansion needed). The driver is added
  // before expansion so even an "empty diff" release still bumps every
  // dependent of core.
  const seedSet = new Set(directlyChanged);
  seedSet.add(DRIVER_PACKAGE);
  const allChanged = changed === null
    ? directlyChanged
    : expandWithDependents(seedSet, packagesDir, dirs);
  const transitivelyAdded = [...allChanged].filter((p) => !directlyChanged.has(p) && p !== DRIVER_PACKAGE);
  const summary = planBumps(
    dirs,
    (name) => allChanged.has(name),
    (name) => bumpVersionFile(path.join(packagesDir, name), bump),
  );
  summary.transitivelyAddedDependents = transitivelyAdded;
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
