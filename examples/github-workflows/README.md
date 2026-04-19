# GH Actions workflow templates

Drop-in YAMLs that wire Conclave AI into a repo's CI. Copy any of these into `.github/workflows/` on the target repo.

| File | What it does | Secrets needed |
|---|---|---|
| `telegram-bot.yml` | 1-minute cron: long-polls Telegram and fires `repository_dispatch` on button clicks | `TELEGRAM_BOT_TOKEN`, `ORCHESTRATOR_PAT` |
| `conclave-rework.yml` | Receives `conclave-rework` dispatch → runs `conclave rework` → commits the fix back to the PR branch | `ANTHROPIC_API_KEY`, `ORCHESTRATOR_PAT` |
| `conclave-merge.yml` | Receives `conclave-merge` dispatch → `gh pr merge --squash` + records outcome | `ORCHESTRATOR_PAT` |
| `conclave-reject.yml` | Receives `conclave-reject` dispatch → `gh pr close` + records outcome | `ORCHESTRATOR_PAT` |

## Minimal install path

To enable the full Telegram → worker loop on a repo that already has `conclave-review.yml` installed, copy all four files and populate the three secrets above. Branch-protection rules still apply to the merge workflow — Telegram is a convenience, not an authorisation bypass.

## Why `ORCHESTRATOR_PAT` and not `GITHUB_TOKEN`

GH Actions' default `GITHUB_TOKEN` can't trigger subsequent workflow runs. The worker's push to the PR branch has to wake up the review workflow, and the Telegram bot's `repository_dispatch` has to wake up the rework/merge/reject workflows — both require a PAT (or GitHub App token) with the appropriate scopes. A fine-grained PAT with `contents: write` + `actions: write` on the specific repo is usually enough.
