#!/usr/bin/env node
/**
 * scripts/release/bump-workflow-cli-version.mjs
 *
 * PIA-1 — keep the `cli-version: default: X.Y.Z` pin in
 *   .github/workflows/{review,rework,merge}.yml
 * in lockstep with packages/cli/package.json `.version`.
 *
 * Why: release.yml's bump-changed-packages.mjs only updates package.json
 * versions. The workflow defaults are plain YAML strings. Pre-PIA-1
 * they had to be hand-bumped via a separate "chore(workflows): bump
 * cli-version default → X.Y.Z" commit. Forgetting that step left
 * consumer-side wrappers (`uses: ...@v0.4`) installing the OLD CLI on
 * every PR even after the floating tag moved — caught LIVE during
 * Phase C verification on cli@0.14.0.
 *
 * This script is invoked by release.yml AFTER bump-changed-packages
 * finished and BEFORE the commit + push step, so the workflow update
 * lands in the same release commit + tag.
 *
 * Outputs JSON on stdout for the CI summary.
 *
 * Exit codes:
 *   0  success (changes made or no-op)
 *   2  misuse — file missing or malformed
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

export const WORKFLOW_FILES = [
  ".github/workflows/review.yml",
  ".github/workflows/rework.yml",
  ".github/workflows/merge.yml",
];

const PIN_REGEX = /^(\s*default:\s+)([\d]+\.[\d]+\.[\d]+)(\s*)$/m;

/**
 * Replace the `cli-version` default in `body` with `targetVersion`. Only the
 * line under the `cli-version:` input is touched — other `default:` lines
 * (e.g. force-domain, build-cmd) are NOT semver-shaped so the regex
 * above (must match a 3-part semver) skips them.
 *
 * Returns { body: newBody, changed: boolean, prevVersion: string | null }.
 * Idempotent — running with the same target on a body that already has
 * it is a no-op (changed=false).
 */
export function replaceCliVersionPin(body, targetVersion) {
  // Only the cli-version section's default line — locate it precisely
  // so we don't accidentally touch any other YAML default.
  const cliBlockRegex = /(cli-version:[\s\S]*?default:\s+)([\d]+\.[\d]+\.[\d]+)(\s*$)/m;
  const match = body.match(cliBlockRegex);
  if (!match) return { body, changed: false, prevVersion: null };
  const prevVersion = match[2];
  if (prevVersion === targetVersion) return { body, changed: false, prevVersion };
  const replaced = body.replace(cliBlockRegex, `$1${targetVersion}$3`);
  return { body: replaced, changed: true, prevVersion };
}

function readCliVersion(repoRoot) {
  const pkgPath = path.join(repoRoot, "packages/cli/package.json");
  if (!existsSync(pkgPath)) {
    throw new Error(`cli package.json not found at ${pkgPath}`);
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  if (typeof pkg.version !== "string" || !/^\d+\.\d+\.\d+$/.test(pkg.version)) {
    throw new Error(`cli package.json version is not a valid semver: ${pkg.version}`);
  }
  return pkg.version;
}

export function bumpWorkflows(repoRoot, targetVersion) {
  const results = [];
  for (const rel of WORKFLOW_FILES) {
    const abs = path.join(repoRoot, rel);
    if (!existsSync(abs)) {
      results.push({ file: rel, status: "missing", changed: false });
      continue;
    }
    const before = readFileSync(abs, "utf8");
    const { body: after, changed, prevVersion } = replaceCliVersionPin(before, targetVersion);
    if (!changed) {
      results.push({ file: rel, status: "unchanged", changed: false, prevVersion });
      continue;
    }
    writeFileSync(abs, after, "utf8");
    results.push({ file: rel, status: "bumped", changed: true, prevVersion, newVersion: targetVersion });
  }
  return results;
}

const invokedDirectly = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const repoRoot = process.cwd();
  try {
    const target = readCliVersion(repoRoot);
    const results = bumpWorkflows(repoRoot, target);
    const summary = {
      cliVersion: target,
      results,
      changedCount: results.filter((r) => r.changed).length,
    };
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    process.exit(0);
  } catch (err) {
    process.stderr.write(
      `bump-workflow-cli-version: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
  }
}
