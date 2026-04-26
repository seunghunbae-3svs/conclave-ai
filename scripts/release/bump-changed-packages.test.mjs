import { test } from "node:test";
import assert from "node:assert/strict";
import {
  nextVersion,
  packageChangedFromList,
  planBumps,
} from "./bump-changed-packages.mjs";

/**
 * v0.13.12 — release-script unit tests.
 *
 * Hermetic: never touches git or filesystem. Drives the planner with
 * fake `isChanged` + `bumpFn` so we can exercise every branch.
 */

// ---- nextVersion --------------------------------------------------------

test("nextVersion: patch bumps Z", () => {
  assert.equal(nextVersion("0.13.10", "patch"), "0.13.11");
  assert.equal(nextVersion("1.0.0", "patch"), "1.0.1");
});

test("nextVersion: minor bumps Y, resets Z", () => {
  assert.equal(nextVersion("0.13.10", "minor"), "0.14.0");
  assert.equal(nextVersion("1.4.7", "minor"), "1.5.0");
});

test("nextVersion: major bumps X, resets Y+Z", () => {
  assert.equal(nextVersion("0.13.10", "major"), "1.0.0");
  assert.equal(nextVersion("1.4.7", "major"), "2.0.0");
});

test("nextVersion: drops pre-release / build suffix", () => {
  assert.equal(nextVersion("0.13.10-beta.1", "patch"), "0.13.11");
  assert.equal(nextVersion("0.13.10+build.5", "patch"), "0.13.11");
});

test("nextVersion: throws on unknown kind", () => {
  assert.throws(() => nextVersion("0.1.0", "huge"), /unknown bump kind/);
});

test("nextVersion: throws on unparseable version", () => {
  assert.throws(() => nextVersion("v0.1.0", "patch"), /unparseable version/);
  assert.throws(() => nextVersion("1.0", "patch"), /unparseable version/);
});

// ---- packageChangedFromList --------------------------------------------

test("packageChangedFromList: matches files under packages/<name>/", () => {
  assert.equal(
    packageChangedFromList("cli", [
      "packages/cli/src/x.ts",
      "packages/core/src/y.ts",
    ]),
    true,
  );
});

test("packageChangedFromList: ignores files outside packages/<name>/", () => {
  assert.equal(
    packageChangedFromList("cli", [
      "packages/core/src/y.ts",
      "apps/central-plane/src/z.ts",
    ]),
    false,
  );
});

test("packageChangedFromList: null baseline (first release) → always true", () => {
  assert.equal(packageChangedFromList("cli", null), true);
  assert.equal(packageChangedFromList("anything", null), true);
});

test("packageChangedFromList: empty diff → false (no changes)", () => {
  assert.equal(packageChangedFromList("cli", []), false);
});

test("packageChangedFromList: case-sensitive prefix match", () => {
  // packages/cli-foo should NOT match name="cli"
  assert.equal(packageChangedFromList("cli", ["packages/cli-foo/src/x.ts"]), false);
});

// ---- planBumps ---------------------------------------------------------

test("planBumps: bumps driver always, plus changed packages", () => {
  const bumped = [];
  const result = planBumps(
    ["core", "cli", "agent-design", "secret-guard"],
    (name) => name === "cli", // only cli has changes
    (name) => {
      bumped.push(name);
      return { from: "0.1.0", to: "0.1.1" };
    },
  );
  assert.deepEqual(bumped.sort(), ["cli", "core"]);
  assert.equal(result.bumped.length, 2);
  assert.equal(result.skipped.length, 2);
  assert.deepEqual(result.skipped.map((s) => s.name).sort(), ["agent-design", "secret-guard"]);
});

test("planBumps: nothing changed → only driver bumps", () => {
  const result = planBumps(
    ["core", "cli", "agent-design"],
    () => false,
    () => ({ from: "0.1.0", to: "0.1.1" }),
  );
  assert.equal(result.bumped.length, 1);
  assert.equal(result.bumped[0].name, "core");
  assert.equal(result.skipped.length, 2);
});

test("planBumps: everything changed → all bump", () => {
  const result = planBumps(
    ["core", "cli", "agent-design"],
    () => true,
    () => ({ from: "0.1.0", to: "0.1.1" }),
  );
  assert.equal(result.bumped.length, 3);
  assert.equal(result.skipped.length, 0);
});

test("planBumps: custom driver name is honoured", () => {
  const result = planBumps(
    ["cli", "core"],
    () => false,
    () => ({ from: "0.1.0", to: "0.1.1" }),
    { driver: "cli" },
  );
  assert.equal(result.bumped[0].name, "cli");
  assert.equal(result.skipped[0].name, "core");
});

test("planBumps: bumpFn return value is folded into the summary", () => {
  const result = planBumps(
    ["core"],
    () => false,
    () => ({ from: "0.13.10", to: "0.13.11" }),
  );
  assert.equal(result.bumped[0].from, "0.13.10");
  assert.equal(result.bumped[0].to, "0.13.11");
});
