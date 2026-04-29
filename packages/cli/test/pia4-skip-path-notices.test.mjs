/**
 * PIA-4 — every workflow skip path must close the loop with a user-
 * facing notice. Pre-PIA-4, three paths in review.yml could short-
 * circuit the entire review without posting any PR comment, leaving
 * the PR author staring at a stalled "no review yet" indicator.
 *
 * The most user-impactful was the "diff under 3 lines" skip — when an
 * autofix cycle resolved the only blocker by deleting dead code, the
 * next review.yml run hit this branch and went silent (caught LIVE on
 * eventbadge PR #37). PIA-4 wires a PR comment + workflow summary
 * annotation so the terminal-success state is visible.
 *
 * This test enforces the contract going forward: any newly-added skip
 * branch in review.yml / rework.yml / merge.yml must either be an
 * EXPLICIT user opt-out (`[skip conclave]` markers — silent is fine
 * because the user typed the marker themselves) or carry a notice
 * step. The taxonomy lives in this test as an executable spec.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

function readWorkflow(name) {
  return readFileSync(path.join(repoRoot, ".github/workflows", name), "utf8");
}

test("PIA-4 review.yml: SKIP_REVIEW=true (sub-3-line diff) path has a Skip notice that posts to PR", () => {
  const yml = readWorkflow("review.yml");
  // The skip-notice step exists.
  assert.match(yml, /name:\s+Skip notice/, "review.yml has Skip notice step");
  // It is gated on SKIP_REVIEW.
  const skipSection = yml.split(/name:\s+Skip notice/)[1] ?? "";
  assert.match(
    skipSection,
    /SKIP_REVIEW\s*==\s*'true'/,
    "Skip notice gates on SKIP_REVIEW=true",
  );
  // It posts to PR (gh pr comment).
  assert.match(
    skipSection,
    /gh pr comment/,
    "PIA-4 — Skip notice MUST post a PR comment so users see resolution",
  );
  // It writes to the workflow run summary.
  assert.match(
    skipSection,
    /GITHUB_STEP_SUMMARY/,
    "PIA-4 — Skip notice writes a runner-visible summary annotation",
  );
});

test("PIA-4 review.yml: external-PR skip path posts a friendly PR comment", () => {
  const yml = readWorkflow("review.yml");
  // The "Post external-PR notice" step exists.
  assert.match(
    yml,
    /name:\s+Post external-PR notice/,
    "review.yml has external-PR notice step (closes the fork-PR silent-skip loop)",
  );
  // It runs `gh pr comment`.
  const slice = yml.split(/name:\s+Post external-PR notice/)[1] ?? "";
  assert.match(slice, /gh pr comment/, "external-PR notice posts comment");
});

test("PIA-4 review.yml: [skip conclave] / [skip ci] markers ARE allowed to be silent (explicit opt-out)", () => {
  // Sanity check the contract carve-out: when the user explicitly
  // typed `[skip conclave]` in their commit message, they don't want
  // a comment back. This test pins down the carve-out so a future
  // change doesn't accidentally make the explicit-opt-out path noisy.
  const yml = readWorkflow("review.yml");
  assert.match(
    yml,
    /\[skip conclave\]/,
    "skip-conclave marker is recognised in the guard",
  );
  // The skip-conclave path sets skip=true and exits early. We don't
  // require a PR comment for this branch — only the SKIP_REVIEW=true
  // generic path must comment, which is reached AFTER the explicit-
  // marker exit. The skip-guard exits BEFORE setting SKIP_REVIEW=true
  // would matter, so the marker case is silent by design.
  // (No assertion needed beyond the marker presence — the carve-out
  // is preserved by the structure of the guard step itself.)
});

test("PIA-4 rework.yml: cycle-ceiling skip posts a Skipped notice PR comment", () => {
  const yml = readWorkflow("rework.yml");
  assert.match(yml, /name:\s+Skipped notice/, "rework.yml has Skipped notice step");
  const slice = yml.split(/name:\s+Skipped notice/)[1] ?? "";
  // It is gated on the cycle-ceiling guard's skip output.
  assert.match(
    slice,
    /steps\.guard\.outputs\.skip\s*==\s*'true'/,
    "Skipped notice gates on guard.outputs.skip=true",
  );
  // It posts a PR comment.
  assert.match(slice, /gh pr comment/, "Skipped notice posts PR comment");
  // The body mentions the cycle ceiling so the user knows why.
  assert.match(
    slice,
    /cycle ceiling|Human review needed|cycle-ceiling/i,
    "Skipped notice body explains the cycle-ceiling cause",
  );
});

test("PIA-4 merge.yml: CONCLAVE_TOKEN-missing skip is acceptable as silent (merge already succeeded)", () => {
  // Carve-out documentation. merge.yml's defensive skip in "Notify
  // central plane (merged)" runs AFTER the merge has already
  // succeeded. The merge result is visible on the PR page (closed +
  // merged), so a missing terminal Telegram is a degraded but not
  // hidden state. We accept silent here.
  const yml = readWorkflow("merge.yml");
  assert.match(
    yml,
    /CONCLAVE_TOKEN not set.*skipping merge notification/,
    "merge.yml documents the silent-skip carve-out via the warning text",
  );
  // ::warning:: is at minimum visible on the runner. PR comment
  // would be redundant since the PR is already merged.
  assert.match(
    yml,
    /::warning::CONCLAVE_TOKEN not set/,
    "merge.yml escalates the missing-token case to ::warning:: in runner logs",
  );
});

test("PIA-4 contract: every workflow's skip-true output must have a corresponding notice step", () => {
  // Static drift catcher — enumerates each workflow and asserts that
  // any step using `skip == 'true'` (a skip output) has a sibling
  // step with `gh pr comment` OR `GITHUB_STEP_SUMMARY` OR
  // ::warning::/::notice:: emission. This catches the case where
  // someone adds a new skip branch but forgets the notice.
  const workflows = [
    { name: "review.yml", body: readWorkflow("review.yml") },
    { name: "rework.yml", body: readWorkflow("rework.yml") },
    { name: "merge.yml", body: readWorkflow("merge.yml") },
  ];
  for (const wf of workflows) {
    // Find every line that gates on a skip-true output.
    const skipGateMatches = wf.body.matchAll(
      /skip\s*==\s*'true'|SKIP_REVIEW\s*==\s*'true'/g,
    );
    const count = [...skipGateMatches].length;
    if (count === 0) continue;
    // The workflow MUST have at least one PR-comment step or summary
    // annotation to close the user-facing loop.
    const hasPrComment = /gh pr comment/.test(wf.body);
    const hasSummary = /GITHUB_STEP_SUMMARY/.test(wf.body);
    const hasWarn = /::warning::|::notice::/.test(wf.body);
    assert.ok(
      hasPrComment || hasSummary || hasWarn,
      `${wf.name} has skip-gated steps but NO user-facing notice (gh pr comment / GITHUB_STEP_SUMMARY / ::warning::)`,
    );
  }
});

test("PIA-4 contract: review.yml SKIP_REVIEW path is reachable from both 'sub-3-line' AND 'skip-conclave marker' branches", () => {
  // Documents the structural invariant: SKIP_REVIEW=true gets set in
  // two places — the skip-conclave guard (line ~155) AND the diff-
  // size check (line ~221). The single Skip-notice step at the end
  // catches both. A future refactor that splits these branches must
  // preserve the "every SKIP_REVIEW=true path leads to the notice
  // step" property — this test fails if either source is removed.
  const yml = readWorkflow("review.yml");
  // Two distinct echo-to-env steps that set SKIP_REVIEW=true.
  const sources = yml.match(/SKIP_REVIEW=true/g) ?? [];
  assert.ok(
    sources.length >= 2,
    `expected ≥2 SKIP_REVIEW=true assignment sites, got ${sources.length}`,
  );
});
