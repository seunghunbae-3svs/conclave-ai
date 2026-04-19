# Configuration reference

`.conclaverc.json` lives at the repo root. All fields are optional
except `version`.

## Full shape

```json
{
  "version": 1,
  "agents": ["claude", "openai", "gemini"],
  "budget": { "perPrUsd": 0.5 },
  "efficiency": { "cacheEnabled": true, "compactEnabled": true },
  "council": { "maxRounds": 3, "enableDebate": true },
  "memory": {
    "answerKeysDir": ".conclave/answer-keys",
    "failureCatalogDir": ".conclave/failure-catalog",
    "root": ".conclave"
  },
  "observability": {
    "langfuse": { "enabled": true, "baseUrl": "https://cloud.langfuse.com" }
  },
  "integrations": {
    "telegram": { "enabled": true, "chatId": -1001234567890, "includeActionButtons": true },
    "discord":  { "enabled": true, "webhookUrl": "https://discord.com/api/webhooks/..." },
    "slack":    { "enabled": true, "webhookUrl": "https://hooks.slack.com/..." },
    "email":    { "enabled": true, "from": "bot@example.com", "to": "you@example.com" }
  },
  "visual": {
    "enabled": true,
    "platforms": ["vercel", "netlify", "cloudflare", "railway", "deployment-status"],
    "width": 1280,
    "height": 800,
    "fullPage": true,
    "waitSeconds": 60,
    "diffThreshold": 0.1
  },
  "federated": {
    "enabled": false,
    "endpoint": "https://baseline.example.com"
  }
}
```

## Fields

### `version` (required)

Always `1`. Bump the schema when making a breaking change; the CLI
rejects unknown versions.

### `agents`

Array of `"claude"`, `"openai"`, `"gemini"`. An agent is only
instantiated if its env var is set — missing keys cleanly skip.

| Agent | Env var |
|---|---|
| `claude` | `ANTHROPIC_API_KEY` |
| `openai` | `OPENAI_API_KEY` |
| `gemini` | `GOOGLE_API_KEY` (or `GEMINI_API_KEY`) |

### `budget.perPrUsd`

Hard cap on total LLM spend per `conclave review`. The efficiency
gate reserves cost before each call and throws `BudgetExceededError`
if a call would breach the cap. Default `0.5`.

### `efficiency`

- `cacheEnabled` — Anthropic prompt-cache for Claude agent (5-min TTL,
  model-scoped). Default `true`.
- `compactEnabled` — message-list compaction for long review chains.
  Default `true`.

### `council`

- `maxRounds` — cap on debate rounds. `1` = legacy single-round. Cap
  of `5`. Default `3` per decision #7.
- `enableDebate` — set `false` to force single-round regardless of
  `maxRounds`. Default `true`.

### `memory`

Filesystem paths, relative to repo root unless `root` is absolute.

### `observability.langfuse`

- `enabled` — when `true`, every LLM call records a metric to Langfuse.
  Set `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY` env vars.
- `baseUrl` — Langfuse Cloud (default) or self-hosted URL.

### `integrations.*`

Equal-weight notifiers per decision #24. Each one runs independently;
failures in one do not block the others. Set the matching env vars:

| Integration | Required env |
|---|---|
| telegram | `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` (or `chatId` in config) |
| discord  | `DISCORD_WEBHOOK_URL` (or `webhookUrl` in config) |
| slack    | `SLACK_WEBHOOK_URL` (or `webhookUrl` in config) |
| email    | SMTP envs: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` |

### `visual`

Playwright-driven visual regression per decision #23. Requires at
least one `platforms` entry to successfully resolve a preview URL.

| Platform ID | Required env |
|---|---|
| `vercel` | `VERCEL_TOKEN` |
| `netlify` | `NETLIFY_TOKEN` + `NETLIFY_SITE_ID` |
| `cloudflare` | `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_PROJECT_NAME` |
| `railway` | `RAILWAY_API_TOKEN` + `RAILWAY_PROJECT_ID` (optional `RAILWAY_ENVIRONMENT_ID`) |
| `deployment-status` | none (uses `gh` CLI auth) |

Platforms are tried in order; first non-null preview wins. Missing-creds
platforms are skipped with a stderr notice, not thrown.

### `federated`

Off by default. See [federated-sync.md](federated-sync.md) for the
privacy model before enabling.

- `enabled` — must be `true` to opt in.
- `endpoint` — HTTPS URL of the federation server. Must implement
  `POST /baselines` + `GET /baselines?since=<ISO>`.

Optional `AI_CONCLAVE_FEDERATION_TOKEN` env for bearer auth.

## Config discovery

`loadConfig(cwd)` uses [cosmiconfig](https://github.com/cosmiconfig/cosmiconfig)
to walk up from `cwd` looking for (in order; first hit wins):

1. `.conclaverc` (auto-detected JSON or YAML)
2. `.conclaverc.json`
3. `.conclaverc.yaml` / `.conclaverc.yml`
4. `.conclaverc.js` / `.cjs` / `.mjs`
5. `conclave.config.js` / `.cjs` / `.mjs`
6. `package.json` with a top-level `"conclave"` field

The ordering is deliberate: an explicit `.conclaverc.*` file wins over
an incidental `conclave` field in `package.json`. Cosmiconfig's default
puts `package.json` first; we override that so users can keep the rc
file authoritative.

The resolved config is Zod-validated against the schema above — any
unknown field is rejected. When nothing is found, `DEFAULT_CONFIG` is
used silently.

### YAML example

```yaml
# .conclaverc.yaml
version: 1
agents:
  - claude
  - openai
budget:
  perPrUsd: 0.5
council:
  maxRounds: 3
```

### JS example (dynamic config)

```js
// conclave.config.js
module.exports = {
  version: 1,
  agents: process.env.CI ? ["claude"] : ["claude", "openai", "gemini"],
  budget: { perPrUsd: process.env.CI ? 0.2 : 1.0 },
};
```

### package.json example

```json
{
  "name": "my-app",
  "version": "1.0.0",
  "conclave": {
    "version": 1,
    "agents": ["claude"]
  }
}
```
