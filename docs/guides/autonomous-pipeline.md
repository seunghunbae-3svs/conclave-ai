# Autonomous Pipeline (v0.8)

> System auto-rewrites. User just signs off.

## TL;DR

In v0.7 Conclave reviewed your PR and then asked you to decide (rework / merge / reject) via Telegram buttons — even when the council flagged blockers. v0.8 removes that middle click: when review comes back with `rework`, the central plane dispatches a Worker patch automatically, pushes it back to the PR branch, and the next review runs on the new commit. The loop continues until either the council approves (you get `[Merge & Push]` + `[Close]`) or the cycle count hits a configurable ceiling (you get manual review).

The only user action on the happy path is a final merge button press.

## State machine

```
┌───────────────────────────────────────────────────────────────┐
│                      /review/notify (v0.8)                    │
├───────────────────────────────────────────────────────────────┤
│                                                               │
│   verdict = approve  →  state = approved                      │
│      ↳ Telegram: "Ready to merge" + [Merge & Push] [Close]    │
│                                                               │
│   verdict = rework + cycle < max  →  state = reworking        │
│      ↳ repository_dispatch conclave-rework                    │
│        client_payload: { episodic, pr_number, cycle: N+1 }    │
│      ↳ Telegram: "Conclave is auto-fixing…" (no buttons)      │
│                                                               │
│   verdict = rework + cycle ≥ max  →  state = max-cycles-reached│
│      ↳ NO dispatch. Hand control back.                        │
│      ↳ Telegram: "Auto-fix limit" + [Merge Unsafe] [Close]    │
│                                                               │
│   verdict = reject  →  state = rejected                       │
│      ↳ NO dispatch.                                           │
│      ↳ Telegram: "Discard recommended" + [Close] [Open PR]    │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

The cycle counter propagates via the git commit message:

```
┌──────────────────────┐  push cycle N   ┌────────────────┐
│ conclave-worker[bot] │────────────────→│  PR branch     │
│  produces patch N    │  [conclave-rework-cycle:N]  │
└──────────────────────┘                 └──────┬─────────┘
                                                │
                                                │ pull_request:synchronize
                                                ▼
                                         ┌──────────────┐
                                         │ review.yml   │
                                         │  extracts N  │
                                         │  → --rework-cycle N │
                                         └──────┬───────┘
                                                │
                                                ▼
                                         ┌──────────────┐
                                         │ /review/notify│
                                         │  verdict + N  │
                                         └──────────────┘
```

No separate state store — the commit itself is the state.

## Configuration

`.conclaverc.json`:

```json
{
  "autonomy": {
    "maxReworkCycles": 3,
    "allowUnsafeMerge": true,
    "mergeStrategy": "squash"
  }
}
```

### `maxReworkCycles` (default 3, hard ceiling 5)

Number of auto-rework cycles the system will attempt before giving up and asking the user. Clamped to 5 in `core/clampMaxCycles()` regardless of what you set — safety rail against infinite loops.

Cycle 0 = the initial review of a human commit. Cycle 1 = after the first Worker-authored fix commit. So `maxReworkCycles: 3` means up to 3 auto-fixes before control returns to you.

### `allowUnsafeMerge` (default true)

At `max-cycles-reached`, should the Telegram keyboard include a `⚠️ Merge & Push (unsafe)` button? This button triggers a confirmation prompt before merging a PR with unresolved blockers.

Set to `false` in environments where bypassing the review gate should be impossible — the button is removed entirely, forcing users to open the PR on GitHub and merge from there.

### `mergeStrategy` (default "squash")

Strategy for the Merge & Push button. Maps to GitHub's merge API:

- `squash` — single commit, PR branch deleted after
- `merge` — regular merge commit
- `rebase` — rebase onto base, fast-forward

## CLI flags

### `conclave review --rework-cycle N`

Advertises the current cycle to `/review/notify` so the central plane can decide between `reworking` and `max-cycles-reached`. The `review.yml` workflow extracts N from the HEAD commit's `[conclave-rework-cycle:N]` marker automatically — you rarely pass this manually.

### `conclave review --max-rework-cycles N`

Per-run override for `autonomy.maxReworkCycles`. Clamped to 5.

### `conclave rework --rework-cycle N`

Used by `conclave-rework.yml` when invoked via the autonomy dispatch. Embeds the marker in the commit message so the next review run sees it. N ≥ 1 only; cycle 0 is the implicit human commit.

## Per-workflow override

`.github/workflows/conclave.yml` in your consumer repo:

```yaml
jobs:
  conclave:
    uses: conclave-ai/conclave-ai/.github/workflows/review.yml@v0.8
    with:
      force-max-cycles: "5"    # this PR only
    secrets: inherit
```

## Failure modes

| Scenario | Behavior |
|---|---|
| GitHub API down when firing `repository_dispatch` | Notifier logs `dispatchError`, returns 200. Loop is NOT wedged — next scheduled review (e.g. from a manual `gh workflow run`) recovers naturally. |
| Worker patches cleanly but CI fails | Worker commit is on the branch with the cycle marker. Subsequent review treats it as cycle N and either approves or continues the loop. |
| User pushes a manual fix mid-loop | Manual commit has no marker → cycle resets to 0 on the next review. The auto-loop "restarts" from the user's commit, which is the right behavior (user input beats stale auto-state). |
| Worker generates an empty patch | `conclave rework` exits non-zero, no commit, no loop advance. The existing LoopGuard catches 5 attempts on the same head SHA and opens the circuit. |
| Central plane not redeployed but CLI is v0.8 | Central plane rejects `rework_cycle: unknown field` — but we use lenient body parsing so old central planes silently ignore extra fields and fall back to legacy keyboard. Upgrade central plane FIRST. |
| `autonomy.maxReworkCycles: 0` | Notifier falls through to the legacy v0.7 three-button keyboard for every rework verdict. Clean opt-out. |

## Token budget implications

Each auto-rework cycle = 1 Worker call + 1 Council review. Default config:

- Worker: ~$0.05–0.15 depending on diff size
- Review: ~$0.20–0.50 (tier-1) + escalation

Rough cap per PR at `maxReworkCycles: 3` is `3 × ($0.10 + $0.40)` = **~$1.50** on top of the initial human-triggered review. This is within the default `budget.perPrUsd: 0.50` when the budget tracker is shared across cycles; in practice the first cycle eats most of the budget and subsequent cycles get early-exits when the gate fires.

If you want tighter cost control: `maxReworkCycles: 1` gives you the main value ("one auto-fix attempt") at half the worst-case cost.

## Debugging

Inspect the dispatched payload:

```bash
gh api repos/<slug>/actions/runs --jq '.workflow_runs[] | select(.event=="repository_dispatch") | .id' | head -5
gh run view <run-id> --log
```

Confirm the commit marker exists:

```bash
git log -1 --pretty=%B HEAD | grep -oE '\[conclave-rework-cycle:[0-9]+\]'
```

Central-plane logs (cloudflare dashboard → Workers → conclave-ai → Logs):

```
auto-rework dispatch failed: <reason>
```

If you see this repeatedly, the install's GitHub token is likely expired — re-run `conclave init` to refresh.

## Rollback

Downgrade the consumer workflow pin and keep the CLI at the older version:

```yaml
uses: conclave-ai/conclave-ai/.github/workflows/review.yml@v0.7.4
```

Central plane can stay on v0.8.0 — the legacy fallback keyboard handles old CLI callers.
