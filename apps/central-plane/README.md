# @conclave-ai/central-plane

Cloudflare Worker that backs conclave-ai's v0.4 centralized install model.

See `docs/architecture-v0.4.md` for the full design; this package is the concrete home for everything labelled "central control plane" in that doc.

## Endpoints

| Method | Path                          | Status | Auth |
|--------|-------------------------------|--------|------|
| GET    | `/health`                     | ✅ real | none |
| POST   | `/register`                   | ✅ real (placeholder token; prefer OAuth for real installs) | none |
| POST   | `/oauth/device/start`         | ✅ real — GitHub device-flow bootstrap | none |
| POST   | `/oauth/device/poll`          | ✅ real — returns CONCLAVE_TOKEN on success | none |
| POST   | `/episodic/push`              | ✅ real — federated aggregate upsert | Bearer CONCLAVE_TOKEN |
| GET    | `/memory/pull`                | ✅ real — frequency baseline for retrieval re-rank | Bearer CONCLAVE_TOKEN |
| POST   | `/telegram/webhook`           | ✅ real — central @conclave_ai bot | Telegram secret_token (optional) |

## Central Telegram bot (milestone 4)

One `@conclave_ai` bot serves all installs. Users DM `/link <CONCLAVE_TOKEN>` to associate their chat with a repo; subsequent 🔧 / ✅ / ❌ clicks fire `repository_dispatch` on behalf of the user via the GitHub token captured during OAuth.

### One-time bot setup (after `ship`)

```bash
# 1. Register a bot with BotFather on Telegram — copy the token
#    https://t.me/BotFather → /newbot

# 2. Store the token in CF
cd apps/central-plane
echo <BOT_TOKEN> | pnpm wrangler secret put TELEGRAM_BOT_TOKEN

# 3. (optional, recommended) generate a random webhook secret and store it
openssl rand -hex 32 | pnpm wrangler secret put TELEGRAM_WEBHOOK_SECRET

# 4. Register the webhook
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -d "url=https://<your-worker>.workers.dev/telegram/webhook" \
  -d "secret_token=<SECRET_FROM_STEP_3>" \
  -d "allowed_updates=[\"message\",\"callback_query\"]"
```

After this, DM the bot `/start` to see onboarding. `/link c_...` creates the chat↔install association.

### Federated memory shape

**Push** — body `{ items: [{ contentHash, kind, domain, category?, severity?, tags? }, ...] }`, up to 500 items per request. Content hashes and metadata cross the boundary; no diff text or blocker message content leaves the caller. Duplicate contentHash across repos or within the same repo atomically increments the aggregate count.

**Pull** — query params `?kind=...&domain=...&min_count=N&limit=M`. All optional. Returns aggregates sorted by count descending — the most frequently observed patterns across the entire install population rank first. Callers use this as a re-rank signal when retrieving their local answer-keys / failure-catalog at review time (per decision #21).

## GitHub OAuth setup (one-time per deployment)

1. Register an OAuth App at https://github.com/settings/developers
   - Name: `Conclave AI` (or whatever is appropriate for your deployment)
   - Homepage URL: your worker URL (e.g. `https://conclave-ai.<sub>.workers.dev`)
   - Authorization callback URL: same as homepage (device flow does not use it, but the GitHub form requires a value)
   - **Enable device flow**: tick the checkbox
2. Copy the `Client ID` shown on the OAuth App page
3. Replace `REPLACE_WITH_GITHUB_OAUTH_APP_CLIENT_ID` in `wrangler.toml` with it (client_id is public; safe to commit)
4. Re-deploy: `pnpm run ship`

Until step 3 is done, `POST /oauth/device/start` returns `503`. `preflight.mjs` also catches the placeholder and refuses to run migrate/ship.

## First-time setup

```powershell
# from repo root
pnpm install

cd apps/central-plane
pnpm wrangler login                    # browser auth, once per CF account
pnpm wrangler d1 create conclave-ai    # prints a UUID on success — COPY IT
```

Then edit `wrangler.toml` and replace `REPLACE_WITH_wrangler_d1_create_OUTPUT` with the UUID from the previous step. Preflight (see below) will refuse to run until you do this.

## Apply schema + local dev

```powershell
pnpm run migrate:local   # schema → local D1 emulator
pnpm run dev             # http://localhost:8787
```

Then:
```powershell
curl http://localhost:8787/health
curl -X POST http://localhost:8787/register -H 'content-type: application/json' -d '{\"repo\":\"acme/service\"}'
```

## Deploy

```powershell
pnpm run migrate:prod    # one-time per schema change; runs preflight first
pnpm run ship            # deploys — name chosen to avoid pnpm's builtin `deploy` command
```

Use `pnpm run <name>` (not bare `pnpm <name>`) for these — pnpm reserves `pnpm deploy` / `pnpm publish` / etc. as builtins, hence the script is named `ship` instead of `deploy`.

Deploys to `https://conclave-ai.<your-cf-subdomain>.workers.dev` by default. Custom domain deferred per v0.4 architecture doc (§D2) — ship and iterate on user signal first.

## Testing

```bash
pnpm test   # 14 unit tests against in-memory D1 mock
```

Tests don't require wrangler or a Cloudflare account — they instantiate `createApp()` from `dist/router.js` and use `Request` objects directly. Integration testing against a real D1 is the wrangler-dev path above.

## What's coming next

| PR | Scope |
|----|-------|
| **+1** | GitHub OAuth flow — `/oauth/github/start` + `/oauth/github/callback`, signed JWT tokens replace the placeholder. |
| **+2** | Federated memory aggregation — `/episodic/push` becomes real, `/memory/pull` returns frequency maps. Decision #21 / D4 hashes-only baseline. |
| **+3** | Central `@conclave_ai` Telegram bot — long-poll Worker + `/link <token>` command. |
| **+4** | Deploy-status integration in ReviewContext (D10 a+b). |

## File layout

```
apps/central-plane/
├── wrangler.toml              # CF Worker + D1 bindings
├── migrations/
│   └── 0001_initial.sql       # installs + episodic_aggregates
├── src/
│   ├── index.ts               # fetch handler entry
│   ├── router.ts              # composes all routes
│   ├── env.ts                 # Env binding types
│   ├── util.ts                # newId, sha256Hex, slug validation
│   ├── db/
│   │   └── installs.ts        # CRUD for the installs table
│   └── routes/
│       ├── health.ts
│       ├── register.ts
│       ├── episodic.ts        # stub
│       └── memory.ts          # stub
└── test/
    └── router.test.mjs        # 14 hermetic route tests (mocked D1)
```
