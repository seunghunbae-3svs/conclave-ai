# @conclave-ai/integration-slack

Slack notifier for Conclave AI council reviews. Implements the
`Notifier` interface from `@conclave-ai/core`.

Decision #24: equal-weight integration alongside Telegram / Discord /
Email / CLI.

## Install

```bash
pnpm add @conclave-ai/integration-slack @conclave-ai/core
```

## Usage

```ts
import { SlackNotifier } from "@conclave-ai/integration-slack";

const slack = new SlackNotifier({
  webhookUrl: process.env.SLACK_WEBHOOK_URL,
});

await slack.notifyReview({
  outcome,
  ctx,
  episodicId: episodic.id,
  totalCostUsd: gate.metrics.summary().totalCostUsd,
  prUrl: "https://github.com/acme/app/pull/42",
});
```

## Setup

1. https://api.slack.com/apps → Create App → From scratch
2. **Incoming Webhooks** → toggle on → **Add New Webhook to Workspace**
3. Pick a channel, copy the URL
4. `export SLACK_WEBHOOK_URL='https://hooks.slack.com/services/…'`

## Message shape

- Block Kit body (sections + context + dividers)
- Verdict header with emoji, links to PR URL when supplied
- Per-agent section: top-3 severity-sorted blockers + summary
- Footer context block: cost + episodic id
- Fallback `text` field for mobile push notifications

## Inbound interactivity

Not supported here (webhooks are write-only). For slash commands or
button clicks, add a separate Slack app with OAuth + event subscriptions.
