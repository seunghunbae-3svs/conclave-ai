# @conclave-ai/telegram-bot-runner

Long-polls Telegram `callback_query` updates (the 🔧 Rework / ✅ Approve / ❌ Reject buttons that `@conclave-ai/integration-telegram` renders) and dispatches `repository_dispatch` events back to the target repo's GH Actions workflows.

Closes the final gap documented in `next_session_kickoff.md`: the notifier already emits action buttons, but until now clicking them did nothing.

## How it fits together

```
Telegram user clicks 🔧 Rework
   → callback_query (update_id N, data="ep:<id>:reworked")
   → runBotOnce() reads it via getUpdates
   → gh api repos/<repo>/dispatches -f event_type=conclave-rework
        -f client_payload='{"episodic":"<id>", ...}'
   → GH Actions `rework.yml` workflow fires
   → workflow checks out the PR branch, runs `conclave rework --episodic <id>`
   → worker agent generates patch → commit + push → review re-runs automatically
```

Merge / reject map the same way — the bot-runner only dispatches, it never touches PR state directly. That keeps the token blast radius small: it needs `actions: write` on the target repo, nothing more.

## Running as a GH Actions cron

```yaml
# .github/workflows/telegram-bot.yml
name: conclave-telegram-bot
on:
  schedule:
    - cron: '*/1 * * * *'
  workflow_dispatch:

jobs:
  poll:
    runs-on: ubuntu-latest
    permissions: { contents: read, actions: write }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - uses: actions/cache@v4
        with:
          path: .telegram-bot-offset.json
          key: telegram-bot-offset
      - run: npx -p @conclave-ai/telegram-bot-runner conclave-telegram-bot --repo ${{ github.repository }}
        env:
          TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}
          GH_TOKEN: ${{ secrets.ORCHESTRATOR_PAT }}
```

The offset file is cached across runs so consecutive polls don't double-process the same callback. `--poll-timeout 25` means each tick blocks for up to 25 seconds on the Telegram side — the job typically finishes in under 30 seconds even when nothing is queued.

## API (for embedding)

```ts
import { runBotOnce } from "@conclave-ai/telegram-bot-runner";

const result = await runBotOnce({
  botToken: process.env.TELEGRAM_BOT_TOKEN!,
  repo: "acme/service",
  offset: savedOffset,         // persisted between runs
  pollTimeoutSec: 25,
  allowOutcomes: ["reworked"], // e.g. disable auto-merge from Telegram
});

// result.parsed:     every callback we saw
// result.dispatched: the ones we actually fired repository_dispatch for
// result.errors:     per-update errors (non-fatal)
// result.nextOffset: persist this and pass as `offset` next call
```

## Trust model

- The bot runs on GH Actions with `ORCHESTRATOR_PAT`. Anyone who can click the Telegram button can trigger a dispatch. **Telegram does not authenticate users beyond "they're in the chat."** That means the chat ACL is the authorisation surface — keep the chat private, invite only people who are allowed to rework/merge/reject PRs.
- The dispatcher never shells out `gh pr merge` itself — the target repo's workflow does, behind its own branch protection rules. So even a spoofed callback can't merge a PR that doesn't otherwise meet the repo's requirements.
- The bot's `answerCallbackQuery` shows the user what happened (`✓ conclave-rework dispatched` or `⚠ dispatch failed`) so they know the button did something.

## Zero runtime dependencies

Uses only `globalThis.fetch` (Node 18+) and the `gh` CLI. No Telegram SDK, no Octokit.
