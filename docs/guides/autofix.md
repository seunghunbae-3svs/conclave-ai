# `conclave autofix` — guide

`conclave autofix` turns Council verdicts into committed, verified
patches. It's the v0.7 closer for the "Council caught it, now what?"
gap.

## When to use it

Use autofix when:
- A `conclave review` round returned `rework` with specific code-level
  blockers (type errors, imports, encoding, config syntax, etc.)
- You're on the PR branch locally (worktree checked out).
- You trust the council enough to let it attempt the fix.

Don't use autofix for:
- Strategic refactors or cross-cutting changes.
- Design / visual regressions — v0.7 skips these.
- DB schema / migration / prisma changes — treated as risky paths.
- Diffs > 500 lines — the budget guard will stop it anyway.

## Basic usage

```bash
# L2 — commits, awaits Bae's merge click (default)
conclave autofix --pr 21

# L3 — auto-merges on approve
conclave autofix --pr 21 --autonomy l3

# Dry-run — see what would happen without any filesystem ops
conclave autofix --pr 21 --dry-run
```

## Example output

```
$ conclave autofix --pr 21
autofix: pulling council verdict for seunghunbae-3svs/eventbadge#21…
autofix: 2 blockers, 1 agent (claude)
autofix: iter 1 — 2 patches proposed
  [ready]   workflow-syntax (./.github/workflows/x.yml)
  [ready]   binary-encoding  (src/logo.ts)
autofix: secret-guard: 0 findings
autofix: diff budget: 12 lines / 2 files
autofix: applied 2 patches
autofix: build OK (pnpm build, 8.3s)
autofix: tests OK (pnpm test, 3.1s)
autofix: commit 4d2f1a "autofix: 2 blockers (conclave-ai)"
autofix: meta-review → approve
autofix: complete, awaiting Bae approval (L2)
```

## Flow

1. **Load verdict.** Either run `conclave review` implicitly via a
   subprocess hook, or pass `--verdict path/to/episodic.json` from a
   prior review.
2. **Per-blocker fix.** Each blocker is sent to `@conclave-ai/agent-worker`
   (ClaudeWorker) with the current file contents. The worker returns a
   unified-diff patch.
3. **Safety checks.**
   - `git apply --check --recount` — patch applies?
   - secret-guard — no new secrets?
   - deny-list — no .env / *.pem / *.key / *secret* files?
   - diff-budget — total ≤ 500 lines across patches?
4. **Apply + verify.**
   - `git apply --recount` per patch.
   - Build command (auto-detected from `package.json` / `Cargo.toml` /
     `pyproject.toml`, or `--build-cmd`).
   - Test command (same).
5. **Commit.** One commit per iteration, authored as
   `conclave-autofix[bot] <noreply@conclave.ai>`.
6. **Meta-review.** Re-run Council. If verdict is `approve`:
   - L2: stop, print "awaiting Bae".
   - L3: `gh pr merge N --squash`.

   If still `rework` and iterations remain, loop back to step 2
   with the previous build/test failure tail fed to the worker.

## Safety rails

| Rail | Default | How to override |
|---|---|---|
| Budget | $3 | `--budget <usd>` (hard max $10) |
| Iterations | 2 | `--max-iterations N` (hard max 3) |
| Diff budget | 500 lines | not overridable |
| LoopGuard | 5/hour/(repo:pr:sha) | inherited from `@conclave-ai/core` |
| CircuitBreaker | 3 errors | inherited |
| Deny-list | .env* / *.pem / *.key / *secret* / *.credentials* | `autofix.denyPatterns` in config |
| Secret-guard | on | `--skip-secret-guard` (discouraged) or `--allow-secret <ruleId>` |

## Troubleshooting

### "autofix: loop guard tripped on …"
Same (repo:pr:sha) has been autofixed 5+ times in the last hour.
Investigate the PR — the worker's patches keep reopening blockers.
Usually means the blocker description is ambiguous or the diff is
actively broken. Hand it to a human reviewer.

### "autofix: diff budget exceeded — 712 lines across 4 files"
The proposed patches would touch > 500 lines. This is a hard stop —
Conclave v0.7 does not allow autonomous large-scale changes. Review
the dry-run output and apply selectively.

### "autofix: build failed (pnpm build) — reverting"
The patch applied but broke compilation. autofix reverts and tries
one more iteration with the build error fed back to the worker. If
it still fails, autofix bails with `bailed-build-failed`.

### "autofix: tests failed — reverting, will NOT commit"
Build passed, tests failed. Same retry-with-feedback behavior, then
bail if still failing.

### "autofix: circuit breaker open (until …)"
3 consecutive worker errors (network, LLM timeouts, etc.). Breaker
holds for 5 min — re-run after cooldown.

### "autofix: bailed after 2 iterations"
Council still rejects after max iterations. Remaining blockers are
posted as a PR comment. Hand to a human.

## Integration with existing flows

- **`conclave review`** produces the verdict. Use `--verdict` to reuse
  a prior review and skip LLM cost on the review step.
- **`conclave rework`** (v0.4+) handles single-blocker, one-shot reworks
  triggered by a Telegram button press. autofix is the multi-blocker,
  multi-iteration extension — use rework for one-off fixes and autofix
  for "please just fix it all".

## L3 trust checklist

Before enabling `--autonomy l3` on a repo:

- [ ] Council has ≥ 20 past reviews on the repo with ≥ 90% verdict
      consistency (use `conclave scores` to check).
- [ ] Branch protection requires PR review from the `conclave-autofix[bot]`
      but the bot comments are sufficient.
- [ ] Tests are comprehensive (autofix trusts tests — if they don't
      cover a regression, autofix can merge a regression).
- [ ] CI runs on push — so the final "merged" commit has one more
      check at rest.

## What v0.7 does NOT autofix

- **Design / visual blockers** — skipped with reason. v0.7.1 lands
  visual-aware autofix with before/after screenshots.
- **New file creation** — worker prompt forbids it. If a blocker says
  "file X is missing", autofix reports it unresolved; the human adds
  the skeleton; then re-run autofix to fill it in.
- **Prisma schema, migrations, secrets, .env** — always skipped for
  safety.

## See also

- `docs/releases/v0.7.0.md` — full release notes
- `docs/guides/audit.md` — `conclave audit` for whole-project health
- `packages/cli/src/commands/autofix.ts` — implementation
- `packages/core/src/autofix.ts` — shared types + policy helpers
