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

## Local development

Requires `wrangler` + a Cloudflare account. The Worker runs against a local D1 emulator:

```bash
pnpm install
cd apps/central-plane
pnpm wrangler d1 create conclave-ai    # one-time — copy the database_id into wrangler.toml
pnpm migrate:local                       # apply schema to the local D1
pnpm dev                                 # http://localhost:8787
```

Then:

```bash
curl http://localhost:8787/health
curl -X POST http://localhost:8787/register -H 'content-type: application/json' -d '{"repo":"acme/service"}'
```

## Deploy

```bash
pnpm migrate:prod   # one-time per schema change
pnpm deploy
```

Deploys to `https://conclave-ai.<your-cf-subdomain>.workers.dev` by default. Custom domain (`conclave.ai` once we own it) is a `wrangler.toml` `[[routes]]` block away — deferred until the repo is public and user signal justifies it.

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
