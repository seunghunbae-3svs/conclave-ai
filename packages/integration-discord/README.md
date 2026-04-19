# @conclave-ai/integration-discord

Discord notifier for Conclave AI council reviews. Implements the
`Notifier` interface from `@conclave-ai/core`.

Decision #24: equal-weight integration alongside Telegram / Slack /
Email / CLI. No hero surface.

## Install

```bash
pnpm add @conclave-ai/integration-discord @conclave-ai/core
```

## Usage

```ts
import { DiscordNotifier } from "@conclave-ai/integration-discord";

const discord = new DiscordNotifier({
  webhookUrl: process.env.DISCORD_WEBHOOK_URL,
});

await discord.notifyReview({
  outcome,
  ctx,
  episodicId: episodic.id,
  totalCostUsd: gate.metrics.summary().totalCostUsd,
  prUrl: "https://github.com/acme/app/pull/42",
});
```

## Setup

1. In your Discord server → channel → Settings → Integrations → **Webhooks** → New Webhook
2. Copy the webhook URL
3. `export DISCORD_WEBHOOK_URL='https://discord.com/api/webhooks/…'`

No bot token or OAuth setup needed — webhooks are the simplest path and
match the write-only contract of this notifier.

## Message shape

Single embed:
- Color-coded title: ✅ green (approve) / 🔧 amber (rework) / ❌ red (reject)
- Title links to the PR URL when supplied
- Per-agent fields: verdict + top-3 severity-sorted blockers + summary
- Footer: total cost + episodic id

Inbound interactivity (button clicks, slash commands) is not in scope
here — use a separate Discord bot package if / when needed.
