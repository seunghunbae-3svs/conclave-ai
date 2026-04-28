/**
 * OP-3 — workflow YAML contract integrity.
 *
 * The 3 workflow files (review.yml / rework.yml / merge.yml) are
 * load-bearing for the entire user-facing automation. A typo in a
 * dispatch event name, a wrong path in `gh secret set`, or a missing
 * permissions block silently breaks everything. Hermetic tests parse
 * the YAML and pin down the contract.
 *
 * Existing CLI tests (workflows.test.mjs) lock RC #4/#6/#8/#9/#11
 * — these are additional invariants from the OP audit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const WORKFLOW_DIR = path.resolve(import.meta.dirname, "../../../.github/workflows");

function readWf(name) {
  return fs.readFileSync(path.join(WORKFLOW_DIR, name), "utf8");
}

test("OP-3 review.yml: cycle marker regex covers `[conclave-rework-cycle:N]` for N=0..N≥10", () => {
  const body = readWf("review.yml");
  // Extract the regex literal autofix.ts uses elsewhere. The workflow
  // uses `grep -oE '\\[conclave-rework-cycle:[0-9]+\\]'` — verify it
  // actually matches all canonical shapes.
  assert.match(body, /grep -oE '\\?\[conclave-rework-cycle:\[0-9\]\+\\?\]'/);
});

test("OP-3 review.yml: skip-conclave guard recognizes 4 variants", () => {
  const body = readWf("review.yml");
  // The guard regex MUST match all four user-facing skip phrases so
  // accidental case mismatches don't surprise users.
  for (const phrase of ["[skip conclave]", "[skip ci]", "[ci skip]", "[no review]"]) {
    // Escape brackets for regex inclusion. The yml uses escaped variant.
    const escaped = phrase
      .replace(/\[/g, "\\[")
      .replace(/\]/g, "\\]");
    assert.ok(
      body.includes(escaped) || body.includes(phrase),
      `review.yml skip-guard must include "${phrase}"`,
    );
  }
});

test("OP-3 review.yml: skip-guard runs BEFORE secret-bearing steps (no key exposure on a no-op run)", () => {
  const body = readWf("review.yml");
  // Find the FIRST USAGE (env: ${{ secrets.X }}) — not the doc-header
  // mention. The skip-guard step name marker is unambiguous.
  const skipIdx = body.search(/^\s*-\s*name:\s*Skip-conclave guard/m);
  const tokenIdx = body.search(/\$\{\{\s*secrets\.(ANTHROPIC_API_KEY|CONCLAVE_TOKEN)/);
  assert.ok(skipIdx > -1, "skip-guard step must exist");
  assert.ok(tokenIdx > -1, "secret-bearing usage exists");
  assert.ok(
    skipIdx < tokenIdx,
    `skip-guard must run BEFORE first secret loading; got skipIdx=${skipIdx}, tokenIdx=${tokenIdx}`,
  );
});

test("OP-3 rework.yml: workflow refuses to run when cycle >= max_cycles (hard ceiling)", () => {
  const body = readWf("rework.yml");
  // Look for the cycle-cap gate.
  assert.match(
    body,
    /CYCLE.*=.*\$\{\{\s*inputs\.cycle\s*\}\}/,
    "rework.yml must read the cycle input",
  );
  assert.match(
    body,
    /CYCLE\s*[><=!]/,
    "rework.yml must compare CYCLE to a ceiling",
  );
  // Must mention that >= max bails (either bash -ge / -gt or `>=`).
  assert.match(
    body,
    /(-ge\s+["']?\$?\{?MAX\}?["']?)|>=\s*\$?\{?MAX\}?/,
    "rework.yml must compare cycle >= MAX",
  );
});

test("OP-3 consumer-side wrapper templates: declare exactly `conclave-rework` + `conclave-merge` dispatch types", () => {
  // The dispatch listeners aren't in /.github/workflows/{rework,merge}.yml
  // (those are reusable workflow_call workflows); they're in the
  // consumer-side wrapper templates that `conclave init` writes to
  // each user's repo. The string declarations must EXACTLY match
  // central-plane's outgoing dispatch type — a typo here breaks every
  // user's autonomy loop.
  const writer = fs.readFileSync(
    path.resolve(import.meta.dirname, "../src/commands/init/workflow-writer.ts"),
    "utf8",
  );
  assert.match(writer, /types:\s*\[conclave-rework\]/);
  assert.match(writer, /types:\s*\[conclave-merge\]/);
});

test("OP-3 rework.yml: declared as a reusable workflow (workflow_call), expects dispatch from consumer wrapper", () => {
  const body = readWf("rework.yml");
  assert.match(body, /workflow_call:/);
  // It MUST take cycle / pr-number inputs (the dispatch payload fields).
  assert.match(body, /pr-number:/);
  assert.match(body, /cycle:/);
});

test("OP-3 merge.yml: reusable workflow with central-plane fallback URL", () => {
  const body = readWf("merge.yml");
  assert.match(body, /workflow_call:/);
  assert.match(body, /pr_number|episodic/);
});

test("OP-3 merge.yml: invokes `gh pr merge` with --repo (not relying on cwd)", () => {
  const body = readWf("merge.yml");
  // RC #4 contract — confirmed in the existing workflows.test.mjs but
  // re-pinned here as part of the OP audit.
  assert.match(body, /gh pr merge.*--repo/s, "must pass --repo to gh pr merge");
});

test("OP-3 every workflow: declares an explicit `permissions:` block (no implicit write-all)", () => {
  for (const name of ["review.yml", "rework.yml", "merge.yml"]) {
    const body = readWf(name);
    // Either top-level OR job-level — both are valid Actions usage.
    assert.match(body, /\bpermissions:/, `${name} must declare permissions:`);
    // Must NOT use the dangerous `permissions: write-all`.
    assert.doesNotMatch(
      body,
      /permissions:\s*write-all/,
      `${name} must not use write-all permissions`,
    );
  }
});

test("OP-3 every workflow: pinned actions (uses uses: foo/bar@SOMETHING) — no floating @main", () => {
  for (const name of ["review.yml", "rework.yml", "merge.yml"]) {
    const body = readWf(name);
    const usesLines = body.match(/^\s*-?\s*uses:\s*\S+/gm) ?? [];
    for (const line of usesLines) {
      // Allow @v3, @v4, @sha — ban @main / @master (pin discipline).
      assert.doesNotMatch(line, /@(main|master)\s*$/, `${name}: floating ref in "${line.trim()}"`);
    }
  }
});

test("OP-3 review.yml: no hard-coded API keys / tokens (only ${{ secrets.X }})", () => {
  const body = readWf("review.yml");
  // No real-shape keys: prefix + ≥40 alnum chars. The redaction sed
  // pattern in review.yml uses the literal regex `sk-ant-api03-...` —
  // valid; we only ban actual key values, not regex literals matching
  // them.
  assert.doesNotMatch(body, /\bsk-ant-api03-[A-Za-z0-9_-]{40,}\b/, "no raw Anthropic key value");
  assert.doesNotMatch(body, /\bsk-proj-[A-Za-z0-9_-]{40,}\b/, "no raw OpenAI project key");
  assert.doesNotMatch(body, /\bghp_[A-Za-z0-9]{36}\b/, "no raw GitHub PAT");
  // Every token reference goes through ${{ secrets.X }}.
  const refs = body.match(/\$\{\{\s*secrets\.\w+/g) ?? [];
  assert.ok(refs.length > 0, "review.yml must reference at least one ${{ secrets.X }}");
});

test("OP-3 rework.yml: bail-comment uses fail-tolerant idiom (|| true OR continue-on-error)", () => {
  const body = readWf("rework.yml");
  // Either pattern is acceptable. `|| true` is the shell idiom in the
  // current rework.yml; `continue-on-error: true` is the YAML
  // equivalent. Both prevent a failed comment from killing the whole
  // workflow.
  const hasShellTolerance = /\|\|\s*true\s*$/m.test(body);
  const hasYamlTolerance = /continue-on-error:\s*true/.test(body);
  assert.ok(
    hasShellTolerance || hasYamlTolerance,
    "rework.yml must tolerate sub-step failures via `|| true` OR `continue-on-error`",
  );
});

test("OP-3 dev-loop.yml: cron is intentionally COMMENTED OUT (manual trigger only until OP-1 verified)", () => {
  const body = readWf("dev-loop.yml");
  // The cron line must be commented (starts with `#`) — pre-OP-1 state
  // must be preserved until operator verifies the new diagnostics.
  const cronLines = body.split("\n").filter((l) => /cron:/.test(l));
  for (const line of cronLines) {
    assert.match(line.trim(), /^#/, `dev-loop.yml cron line must remain commented: "${line.trim()}"`);
  }
});
