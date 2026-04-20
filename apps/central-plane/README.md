# @conclave-ai/central-plane

Cloudflare Worker that backs conclave-ai's v0.4 centralized install model.

See `docs/architecture-v0.4.md` for the full design; this package is the concrete home for everything labelled "central control plane" in that doc.

## v0.4-alpha endpoints (this PR)

| Method | Path              | Status |
|--------|-------------------|--------|
| GET    | `/health`         | ✅ real |
| POST   | `/register`       | ✅ real (placeholder token — OAuth in next PR) |
| POST   | `/episodic/push`  | 🟡 stub (aggregation pending) |
| GET    | `/memory/pull`    | 🟡 stub (aggregation pending) |

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
