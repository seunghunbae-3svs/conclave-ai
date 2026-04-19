# @ai-conclave/integration-email

Email notifier for Ai-Conclave council reviews. Implements the
`Notifier` interface from `@ai-conclave/core`.

Decision #24: equal-weight integration alongside Telegram / Discord /
Slack / CLI.

## Install

```bash
pnpm add @ai-conclave/integration-email @ai-conclave/core
```

## Default transport — Resend

```ts
import { EmailNotifier } from "@ai-conclave/integration-email";

const email = new EmailNotifier({
  from: "conclave@yourdomain.com",
  to: "you@yourdomain.com",
  // RESEND_API_KEY is read from env automatically
});
```

No Resend SDK dependency — a single `fetch` call to the REST API.

## Swapping transports

`EmailNotifier` accepts any object implementing `EmailTransport`
(`{ id, send(msg) }`). Drop-in examples:

```ts
// nodemailer SMTP
import nodemailer from "nodemailer";
const smtp = nodemailer.createTransport({ host, port, auth });
const transport = {
  id: "smtp",
  send: (m) => smtp.sendMail(m).then(() => undefined),
};
new EmailNotifier({ from, to, transport });

// @aws-sdk/client-ses — similar wrapper
// postmark / sendgrid / mailgun — implement send() the same way
```

## Env

| Var | Purpose |
|---|---|
| `RESEND_API_KEY` | Default transport (Resend API) |
| `CONCLAVE_EMAIL_FROM` | From address fallback |
| `CONCLAVE_EMAIL_TO` | Comma-separated recipient list fallback |

## Message shape

- Subject: `[conclave] VERDICT — repo #N` (override via `subjectOverride`)
- Plaintext body + HTML body; both rendered from the same source
- HTML is self-contained (inline styles, email-client safe)
- Cost + episodic id in footer
