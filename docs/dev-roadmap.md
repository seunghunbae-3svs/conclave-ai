# Conclave AI development roadmap (operator + dev-loop reference)

> **Source of truth:** this file.
> Bae's nickname for it: "개발로드맵".
> The autonomous dev-loop (`.github/workflows/dev-loop.yml`) reads this
> file every run to figure out the next task. Edit this file to change
> what gets built next.

## Operating contract

- **One item per dev-loop run.** Pick the lowest-numbered pending item,
  ship it (code + tests + commit + release if needed), update
  `.dev-loop-state.json`, then exit. Don't try to do two items in one run.
- **Verify before advancing.** A run only advances `lastShipped` if a
  commit + push actually landed AND `pnpm test` passed. Otherwise the
  state stays put and `consecutiveFailures` increments.
- **Hard stop conditions.**
  - `consecutiveFailures >= 3` → freeze the loop, write a status note,
    wait for a human.
  - Per-run cost cap exceeded → exit early, mark the partial result.
  - Daily cost cap exceeded → freeze.
- **Never destructive.** No force-push to main. No `git reset --hard`.
  No skip-ci on commits unless the change is workflow-only.

## Status tracker

The dev-loop reads `.dev-loop-state.json` at the repo root for
{currentItem, lastShipped, consecutiveFailures, frozen, ...}. When
`currentItem` matches an item below, that's the next thing to build.
When all items in a horizon complete, currentItem advances to the
first item of the next horizon.

---

## H1 — Reliability + DX  ✅ ALL SHIPPED (2026-04-27)

Pre-requisites for any other user adopting the system. Don't skip.

1. **`conclave init --reconfigure` automatic migration.** ✅ cli@0.13.16
2. **Install dashboard** — `conclave status` CLI + `/admin/install-summary`. ✅ cli@0.13.17
3. **Secret-drift detection in `conclave doctor`.** ✅ cli@0.13.18
4. **autofix worker retry-with-feedback.** ✅ cli@0.13.19
5. **Per-install monthly cost cap + alert.** ✅ cli@0.13.20

---

## H1.5 — Whole-Product Verification

These are the three capabilities Bae says are part of the original
design intent for conclave: not just per-PR review, but full-product
audit. The packages exist (`packages/cli/src/commands/audit.ts`,
`packages/visual-review/`, design-agent + spec hints) but **end-to-end
verification on a real repo has never been done**. Per-PR review caught
console.log; the whole-product story is unproven.

These are intentionally separate from H1's reliability work because
they're a different kind of debt — "feature shipped but not validated"
vs. "feature operational but not robust".

Bae's directive: do NOT run audit yet. Build/verify these first, THEN
run on eventbadge.

**A. `conclave audit` whole-project end-to-end.** ✅ cli@0.13.21
Actually scan a real repo (eventbadge), produce the prioritized GitHub
issue, validate that the issue list maps to real defects (no
hallucinations, no missed obvious ones). Fix any RCs that surface (will
likely be ≥2-3 like the per-PR loop had). Live cost: $2-10 once. Output:
a GitHub issue on eventbadge that Bae can scan and feel "yes, conclave
saw the right things".
RCs fixed: audit-1 (`gh issue create` now passes `--repo` so `--cwd`
runs land in the right repo), audit-2 (`--output both` no longer
double-writes stdout when issue creation fails). 9 new hermetic tests
added (21 total in audit.test.mjs). Actual audit run on eventbadge is a
separate Bae-triggered action.

**B. `conclave review --visual` against design system baseline.** ✅ cli@0.13.22
DesignAgent + Playwright capture + pixelmatch already exist. Wire the
design-spec input (`.conclave/design/baseline/`) so DesignAgent compares
the PR's preview URL screenshots against a stored baseline (or against
a Figma export if we ship that integration). Verify it actually fires
on a UI PR, surfaces design-drift blockers (color token mismatch,
layout regression, contrast, cropped text), AND those blockers can be
autofixed by the worker (v0.13.7 already enabled design-domain autofix
when blocker.file is set).
Implementation: new `design-baseline.ts` module (routeToFilename, saveDesignBaseline,
matchBaselinesToArtifacts), `ReviewContext.designBaselineDrift` field in core,
DesignAgent buildVisionContent updated to interleave BASELINE→CURRENT pairs
before PR before→after pairs, SYSTEM_PROMPT updated with baseline-drift guidance,
`--capture-baseline` CLI flag to save golden reference. 17 new hermetic tests
(10 in design-baseline.test.mjs, 7 in vision-mode.test.mjs).

**C. `conclave audit --spec docs/spec.md`** ✅ shipped 2026-04-28
(cli@0.13.23). Hermetic deterministic classifier — no LLM call, $0
to run. Spec markdown is parsed for bullets (any indent / `-`*`+`),
each feature is classified PRESENT / PARTIAL / MISSING by keyword
overlap against the codebase (path matches weighted ×3). Output:
stdout / `--output issue` (creates a "Conclave Spec Gap" GitHub issue
with checklist of missing/partial features) / both / json. 7 new
hermetic tests in audit.test.mjs.

Acceptance criteria: all three run on eventbadge end-to-end, output
reads as "this is what I'd expect a senior reviewer to flag", Bae
confirms the audit / visual / spec outputs match his mental model of
eventbadge's actual gaps.

---

## H2 — Review quality

Foundation already exists in `core/memory/` (answer-keys +
failure-catalog seeds shipped, federated-* code present). Just not
wired live.

6. **answer-keys live retrieval.** ✅ shipped 2026-04-28 (commit 6c90ef8,
   manual dev). Merged PR's pre-merge "removed blockers" (categories
   caught in earlier rework cycles, resolved before merge) land on the
   AnswerKey. Future councils retrieve them via the same BM25 path —
   matching on the original blocker words ("console.log", "missing
   test"), not just category labels — so "this repo flags X" is learned
   automatically. EpisodicEntry gains cycleNumber + priorEpisodicId;
   AnswerKey gains removedBlockers; classifier walks the chain on merge.
   13 new hermetic tests.
7. **failure-catalog active gating.** Rejected-PR patterns become
   sticky blockers in subsequent reviews. Same mistake never sneaks
   past twice.
8. **Per-repo blocker-vs-nit calibration.** When user clicks ✅ on a
   REWORK verdict (overriding) → that category's threshold drops for
   this repo. Adaptive.
9. **Diff splitter** — >500-line diffs auto-split into logical chunks,
   chunk-by-chunk review, integrated verdict.
10. **Agent score routing** (decision #19, partially shipped via
    `conclave scores`). Vote weights from past accuracy.

---

## H3 — Self-evolve

H2 has to be live first or this just feeds noise.

11. **Autofix patch → answer-key auto-register.** When an autofix
    commit gets merged, the (pre-diff, blocker, post-diff) tuple
    becomes an answer-key. Worker starts seeing prior solutions.
12. **Rework-loop failure → failure-catalog.** "fuzzy dedupe missed →
    stall" becomes a stored pattern; subsequent verdicts of similar
    shape pre-apply the dedupe.
13. **Worker prompt auto-tuning.** Recurring autofix failures feed a
    prompt-iteration loop instead of needing manual prompt edits.
14. **Federated baseline live.** Code already in `core/federated-*`
    for k-anonymous baseline exchange. Flip the opt-in switch.
15. **Regression-detection meta-loop.** "Yesterday we caught
    console.log. Today we didn't." → automated agent re-eval + alert.

---

## H4 — Ecosystem

Not before product-market fit.

16. **Multi-user tenancy** — install isolation, per-user billing,
    dashboard.
17. **Template marketplace** — `conclave init --template react-fullstack`
    style.
18. **VS Code / Cursor MCP integration polish** (`conclave mcp-server`
    exists; needs IDE-inline review delivery).
19. **Public dashboard** — review history, merge patterns, category
    trends.
20. **Fine-tune layer** for heavy users — answer-keys feed a fine-tune;
    council cost halves; opt-in.

---

## Sprint sequencing (target)

- **Week 1-2**: H1 (all 5 items). ✅ DONE 2026-04-27.
- **Week 3-4**: H1.5 A → B → C → run audit on eventbadge once.
- **Month 2**: H2 #6, #7, #8 (review quality is the substrate
  self-evolve eats).
- **Month 3-4**: H3 #11, #12 (autofix → answer-key, stall → catalog).
- Beyond: H3 #13-15, then H4 by demand.
