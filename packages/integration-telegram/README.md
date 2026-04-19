# @conclave-ai/integration-telegram

Telegram notifier for Conclave AI council reviews. Implements the
`Notifier` interface from `@conclave-ai/core`.

Decision #24: equal-weight integration alongside Discord / Slack / Email
/ CLI. No hero surface.

## Install

```bash
pnpm add @conclave-ai/integration-telegram @conclave-ai/core
```

## Usage

```ts
import { TelegramNotifier } from "@conclave-ai/integration-telegram";

const telegram = new TelegramNotifier({
  token: process.env.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_CHAT_ID,
});

// After Council.deliberate:
await telegram.notifyReview({
  outcome,
  ctx,
  episodicId: episodic.id,
  totalCostUsd: gate.metrics.summary().totalCostUsd,
  prUrl: "https://github.com/acme/app/pull/42",
});
```

## Setup

1. Create a bot via [@BotFather](https://t.me/BotFather) and save the token
2. Open a chat with the bot OR add it to a group
3. Get your chat id:
   ```bash
   curl "https://api.telegram.org/bot<TOKEN>/getUpdates"
   ```
   (Send a message to the bot first, then the chat id appears in the result.)
4. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in your env.

## What's in the message

- Header: verdict emoji + repo + PR link (if supplied)
- Per-agent verdict + top-3 blockers by severity
- Summary per agent
- Footer: total cost + episodic id (for later `conclave record-outcome`)
- Inline action buttons: ✅ Approve / 🔧 Rework / ❌ Reject

Inline buttons emit `callback_data = "ep:<episodicId>:<outcome>"` — a
callback handler in a future package can close the loop by invoking
`OutcomeWriter.recordOutcome` directly.
