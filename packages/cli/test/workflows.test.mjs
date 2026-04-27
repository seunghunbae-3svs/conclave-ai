import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * v0.13.9 — structural-snapshot tests for the reusable workflows
 * (`.github/workflows/review.yml` and `.github/workflows/rework.yml`).
 *
 * These are NOT executed (we'd need `act` for that). Instead they
 * lock in the contracts that earlier RCs surfaced — if a future
 * edit breaks one of these, the test catches it before we ship a
 * broken v0.4 floating-tag bump:
 *
 *   RC #4 (v0.13.2): `gh pr view` calls always include `--repo`.
 *     Live-caught on eventbadge#25 dispatch run 24954226458 — without
 *     --repo, the gh CLI tries to infer the repo from the surrounding
 *     cwd, but the step runs BEFORE actions/checkout, so cwd isn't a
 *     git repo. fatal: not a git repository.
 *
 *   RC #6 (v0.13.4): the rework workflow installs deps in EVERY
 *     subdir that has a package.json, not just the root. Eventbadge
 *     has a split layout (root package.json with a `cd frontend &&
 *     build` script + frontend/ subdir with its own package.json).
 *     Single-root install missed the nested deps; autofix bailed
 *     with "build failed".
 *
 *   RC #8 (v0.13.4): the rework checkout step uses
 *     AUTOFIX_PUSH_TOKEN || ORCHESTRATOR_PAT || GITHUB_TOKEN.
 *     Pushes made with the default GITHUB_TOKEN do NOT trigger
 *     downstream pull_request:synchronize, so review.yml never
 *     re-fires after autofix. Live-caught on eventbadge#25 commit
 *     22a0b99.
 *
 *   RC #9 (v0.13.4): cycle extraction reads the head commit message
 *     by SHA (github.event.pull_request.head.sha), not the literal
 *     string "HEAD". On the synchronize event, GITHUB_SHA is the
 *     merge commit, and `git log -1 HEAD` reads the merge commit
 *     message — never the autofix marker the worker embedded.
 *
 *   RC #11 (v0.13.4): `[skip conclave]` (and ci-skip aliases) is
 *     honoured at the top of the review job. Without this, every
 *     workflow-only / docs-only push pays a $0.30+ council review.
 */

const ROOT = path.resolve(
  fileURLToPath(import.meta.url),
  "..", // test/
  "..", // packages/cli/
  "..", // packages/
  "..", // repo root
);
const REVIEW_YML = readFileSync(path.join(ROOT, ".github/workflows/review.yml"), "utf8");
const REWORK_YML = readFileSync(path.join(ROOT, ".github/workflows/rework.yml"), "utf8");
const MERGE_YML = readFileSync(path.join(ROOT, ".github/workflows/merge.yml"), "utf8");
const RELEASE_YML = readFileSync(path.join(ROOT, ".github/workflows/release.yml"), "utf8");

// ---- RC #4 — `gh pr view` always carries --repo --------------------------

test("RC #4: every `gh pr view` invocation in review.yml includes --repo", () => {
  const occurrences = REVIEW_YML.match(/gh pr view[^\n]*/g) ?? [];
  for (const line of occurrences) {
    assert.match(
      line,
      /--repo\b/,
      `gh pr view without --repo in review.yml: "${line}"`,
    );
  }
});

test("RC #4: every `gh pr view` invocation in rework.yml includes --repo", () => {
  const occurrences = REWORK_YML.match(/gh pr view[^\n]*/g) ?? [];
  // The rework workflow uses gh pr view at least once (resolve PR head ref).
  assert.ok(occurrences.length >= 1, "rework.yml must call `gh pr view` at least once");
  for (const line of occurrences) {
    assert.match(
      line,
      /--repo\b/,
      `gh pr view without --repo in rework.yml: "${line}"`,
    );
  }
});

// ---- RC #6 — install consumer-repo deps walks every subdir ---------------

test("RC #6: rework.yml installs consumer dependencies (post-checkout step exists)", () => {
  assert.match(
    REWORK_YML,
    /Install consumer-repo dependencies/,
    "rework.yml must have a step that installs consumer deps before autofix verify",
  );
});

test("RC #6: rework.yml install step walks every subdir with a package.json", () => {
  // The step must fan out across nested package.jsons (split layouts like
  // eventbadge: root + frontend/). A single `pnpm install` at the root
  // misses the nested deps. The implementation walks via find / for-loop;
  // the giveaway in the YAML body is that it iterates over multiple dirs
  // (the comment block + install_dir helper).
  assert.match(
    REWORK_YML,
    /install_dir|while\s+IFS=|for\s+\w+\s+in\s+\$/,
    "rework.yml install step must iterate over directories (not just one root install)",
  );
});

// ---- RC #8 — checkout token chain prefers PAT over GITHUB_TOKEN ----------

test("RC #8: rework checkout uses AUTOFIX_PUSH_TOKEN || ORCHESTRATOR_PAT || GITHUB_TOKEN", () => {
  assert.match(
    REWORK_YML,
    /token:\s*\$\{\{\s*secrets\.AUTOFIX_PUSH_TOKEN\s*\|\|\s*secrets\.ORCHESTRATOR_PAT\s*\|\|\s*secrets\.GITHUB_TOKEN\s*\}\}/,
    "rework.yml checkout must use the PAT-first token fallback chain so autofix pushes re-trigger downstream workflows",
  );
});

// ---- RC #9 — cycle extraction uses head.sha, not literal HEAD ------------

test("RC #9: review.yml cycle extraction reads message by head SHA, not HEAD", () => {
  // The review workflow's cycle-extraction block must look up the head
  // commit message via github.event.pull_request.head.sha. If it reads
  // `git log -1 HEAD`, on the synchronize event the merge commit hides
  // the cycle marker.
  const headShaRefs = REVIEW_YML.match(/github\.event\.pull_request\.head\.sha/g) ?? [];
  assert.ok(
    headShaRefs.length >= 2,
    "review.yml must reference github.event.pull_request.head.sha (skip-guard + cycle-extract)",
  );
  // Defensive: assert the cycle-extract regex looks at HEAD_SHA, not HEAD.
  assert.match(
    REVIEW_YML,
    /CYCLE=.*HEAD_SHA|grep[^\n]*conclave-rework-cycle/,
    "cycle extraction must run on the resolved head SHA, not literal HEAD",
  );
});

// ---- RC #11 — [skip conclave] guard at the top of review.yml -------------

test("RC #11: review.yml honours [skip conclave] / [skip ci] / [no review]", () => {
  // The skip-guard reads the head commit message and exits early when
  // the marker is present. Pre-v0.13.4 every workflow-only push paid
  // a $0.30+ review.
  assert.match(
    REVIEW_YML,
    /\[skip conclave\]/,
    "review.yml must check for [skip conclave]",
  );
  assert.match(
    REVIEW_YML,
    /\[skip ci\]/,
    "review.yml must also honour [skip ci] (alias)",
  );
});

// ---- v0.13.9 — release.yml floating-tag auto-move ------------------------

test("v0.13.9: release.yml has a 'Move floating tag' step that runs after publish", () => {
  assert.match(
    RELEASE_YML,
    /Move floating tag/,
    "release.yml must include the floating-tag move step (post-publish)",
  );
  // Order check: the move step must come AFTER the npm publish step,
  // so a publish failure aborts the move (default `if: success()`).
  const publishIdx = RELEASE_YML.indexOf("Publish to npm");
  const moveIdx = RELEASE_YML.indexOf("Move floating tag");
  assert.ok(publishIdx > 0 && moveIdx > 0, "both steps must exist");
  assert.ok(
    publishIdx < moveIdx,
    "Publish to npm must precede Move floating tag in the YAML",
  );
});

test("v0.13.9: release.yml move step refuses to move a non-floating (vMAJOR.MINOR.PATCH) tag", () => {
  // Defense-in-depth: if .release-floating-tag is misconfigured to a
  // patch tag (e.g. v0.13.9), the step must error out instead of
  // silently force-moving an immutable release tag.
  assert.match(
    RELEASE_YML,
    /not a floating tag/,
    "move step must validate the tag shape and reject patch-pinned tags",
  );
});

test("v0.13.9: .release-floating-tag exists at repo root and names a valid floating tag", () => {
  const tagFile = readFileSync(path.join(ROOT, ".release-floating-tag"), "utf8").trim();
  assert.match(
    tagFile,
    /^v[0-9]+(\.[0-9]+)?$/,
    `.release-floating-tag must contain a vMAJOR or vMAJOR.MINOR string, got "${tagFile}"`,
  );
});

// ---- v0.13.17 — reusable merge workflow ---------------------------------

test("v0.13.17: merge.yml exists as a reusable workflow_call workflow", () => {
  assert.match(MERGE_YML, /^on:\s*\n\s*workflow_call:/m, "merge.yml must be invoked via workflow_call (reusable)");
  assert.match(MERGE_YML, /repository_dispatch.*conclave-merge|conclave-merge/, "merge.yml must mention the conclave-merge dispatch path");
});

test("v0.13.17: merge.yml has a step that calls /merge/notify", () => {
  // Without this step the autonomy loop's terminal "✅ Merged"
  // notification never reaches Telegram and the user-visible loop
  // feels broken even when the merge succeeded.
  assert.match(MERGE_YML, /\/merge\/notify/, "merge.yml must POST to /merge/notify after a successful merge");
  assert.match(MERGE_YML, /Notify central plane/, "the merge-notify step's name must be present so operators can find it in run logs");
});

test("v0.13.17: merge.yml uses --repo on the executable `gh pr merge` invocation (parity with rework.yml RC #4)", () => {
  // RC #4 lesson: gh CLI tries to infer repo from cwd, but workflows
  // sometimes run before checkout completes. Be explicit. We match
  // executable lines (start with optional whitespace then `gh pr
  // merge`), not prose mentions in comments / step descriptions.
  const cmdLines = MERGE_YML
    .split("\n")
    .filter((l) => /^\s*gh pr merge\b/.test(l));
  assert.ok(cmdLines.length >= 1, "merge.yml must invoke `gh pr merge` at least once as a real command");
  for (const line of cmdLines) {
    assert.match(line, /--repo\b/, `gh pr merge invocation without --repo: "${line.trim()}"`);
  }
});

test("v0.13.17: record-outcome step is best-effort (continue-on-error)", () => {
  // Live RC eventbadge#32: record-outcome failed because no local
  // .conclave/episodic file existed on the runner, marking the whole
  // run red despite the merge having succeeded. Now best-effort.
  assert.match(MERGE_YML, /Record outcome[^\n]*\n[^]*?continue-on-error:\s*true/m, "record-outcome must be wrapped with continue-on-error: true");
});

test("RC #11: skip-guard runs near the top of the review job (before secret-bearing steps)", () => {
  // The guard must short-circuit BEFORE any step that actually invokes
  // the CLI. We verify by line ordering: the [skip conclave] guard
  // string must appear before the FIRST `conclave review` invocation —
  // i.e. the line where the command is actually run as a step (not a
  // comment). The unique marker for the run step is `conclave review \`
  // (line continuation); doc/comment mentions don't have that.
  const skipIdx = REVIEW_YML.indexOf("[skip conclave]");
  const reviewStepMatch = REVIEW_YML.match(/^\s*conclave review \\$/m);
  assert.ok(skipIdx > 0, "[skip conclave] guard must exist");
  assert.ok(reviewStepMatch, "review step (conclave review \\) must exist");
  const reviewStepIdx = REVIEW_YML.indexOf(reviewStepMatch[0]);
  assert.ok(
    skipIdx < reviewStepIdx,
    `[skip conclave] guard (idx=${skipIdx}) must appear before the conclave review step (idx=${reviewStepIdx}) in the YAML`,
  );
});
