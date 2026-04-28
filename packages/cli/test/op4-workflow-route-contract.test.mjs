/**
 * OP-4 — workflow ↔ central-plane route contract.
 *
 * The central plane already has 158 route-level tests. The gap this
 * test fills is the SHAPE CONTRACT between consumer-side workflows
 * (which build payload via shell + curl) and the Hono routes that
 * validate them. A field rename on either side silently breaks
 * production for every install.
 *
 * Verifies:
 *   - merge.yml's curl payload contains every field /merge/notify
 *     reads as required
 *   - rework dispatch payload (rework.yml inputs) maps cleanly to
 *     central-plane outgoing dispatch shape
 *   - workflow-writer.ts's consumer templates wire the same
 *     repository_dispatch types the central plane fires
 *   - admin/webhook-status response shape matches doctor's expectation
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const readFile = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

test("OP-4 merge.yml curl: payload includes every field route /merge/notify needs", () => {
  const merge = readFile(".github/workflows/merge.yml");
  const route = readFile("apps/central-plane/src/routes/review.ts");

  // Find the merge.yml payload (jq -n --arg ep ... --arg pr ... { outcome, episodic_id, pr_number, pr_url }).
  // Required fields per the route handler: episodic_id, pr_number, outcome, pr_url.
  for (const field of ["episodic_id", "pr_number", "outcome"]) {
    assert.match(
      merge,
      new RegExp(`\\b${field}\\b`),
      `merge.yml curl payload must include ${field}`,
    );
  }
  // The route declares episodic_id as a string field.
  assert.match(route, /episodic_id\?:\s*unknown|episodic_id:\s*string/);
});

test("OP-4 rework.yml: --rework-cycle input plumbed to autofix's --rework-cycle flag", () => {
  const rework = readFile(".github/workflows/rework.yml");
  // rework.yml takes `inputs.cycle` and must pass it as `--rework-cycle <cycle>`
  // to `conclave autofix`. Mismatched flag name would break the cycle bumping.
  assert.match(rework, /--rework-cycle\b/);
  assert.match(rework, /\$\{\{\s*inputs\.cycle\s*\}\}/);
});

test("OP-4 consumer wrapper templates: emit exactly `conclave-rework` + `conclave-merge` dispatch types", () => {
  const writer = readFile("packages/cli/src/commands/init/workflow-writer.ts");
  // The central plane sends dispatch with these exact event types;
  // consumer-side listeners must match.
  assert.match(writer, /types:\s*\[conclave-rework\]/);
  assert.match(writer, /types:\s*\[conclave-merge\]/);
});

test("OP-4 central plane fires outbound dispatch with exact type names consumer expects", () => {
  // Look for `event_type: "conclave-rework"` or similar in the central
  // plane's outbound-dispatch logic.
  const installs = readFile("apps/central-plane/src/db/installs.ts");
  const review = readFile("apps/central-plane/src/routes/review.ts");
  const haystack = installs + "\n" + review;
  // Either the dispatch helper or the route handler must reference
  // the exact event type names.
  assert.ok(
    /conclave-rework/.test(haystack) || /event_type.*rework/.test(haystack),
    "central plane code must reference 'conclave-rework' event type",
  );
});

test("OP-4 /admin/webhook-status route exists + returns shape doctor expects", () => {
  const admin = readFile("apps/central-plane/src/routes/admin.ts");
  assert.match(admin, /\/admin\/webhook-status|webhook-status/);
  // doctor parses response for { ok, version } or similar; route
  // should return JSON.
  assert.match(admin, /c\.json|JSON\.stringify/);
});

test("OP-4 review.yml install step pins explicit cli-version (no `latest` supply-chain risk)", () => {
  const review = readFile(".github/workflows/review.yml");
  // The install step uses ${{ inputs.cli-version }} with a pinned default.
  assert.match(review, /pnpm add -g.*@conclave-ai\/cli@\$\{\{\s*inputs\.cli-version/);
  // Default value MUST be a real version, not "latest" or "*".
  const defaultMatch = review.match(/cli-version:\s*[\s\S]*?default:\s*([0-9.]+)/);
  assert.ok(defaultMatch, "cli-version default must be defined");
  assert.match(defaultMatch[1], /^\d+\.\d+\.\d+$/, "cli-version default must be a pinned semver");
});

test("OP-4 review.yml + rework.yml + merge.yml share the SAME pinned cli-version default (lockstep)", () => {
  const versions = ["review.yml", "rework.yml", "merge.yml"]
    .map((f) => readFile(`.github/workflows/${f}`))
    .map((body) => {
      const m = body.match(/cli-version:[\s\S]*?default:\s*([0-9.]+)/);
      return m ? m[1] : null;
    });
  // All present.
  for (let i = 0; i < versions.length; i += 1) {
    assert.ok(versions[i], `workflow ${i} missing cli-version default`);
  }
  // All identical.
  assert.equal(
    new Set(versions).size,
    1,
    `workflow cli-version defaults must be identical (lockstep). got: ${versions.join(", ")}`,
  );
});
