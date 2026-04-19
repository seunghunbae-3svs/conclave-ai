# @conclave-ai/platform-railway

Conclave AI Railway adapter. Resolves a preview URL for a given commit SHA
via Railway's GraphQL API
(`POST https://backboard.railway.com/graphql/v2`).

One of five v2.0 platform adapters per decision #31: Vercel + Netlify +
Railway + Cloudflare Pages + `deployment-status`.

## Install

Bundled with the Conclave AI monorepo. Pulled in automatically when the
CLI includes `railway` in `config.visual.platforms`.

## Environment

| Var | Required | Notes |
|---|---|---|
| `RAILWAY_API_TOKEN` | yes | Project or team token with read scope on deployments |
| `RAILWAY_PROJECT_ID` | yes | Railway project UUID |
| `RAILWAY_ENVIRONMENT_ID` | no | Narrows deployment results to one environment |

If any required env var is missing the platform factory skips this adapter
rather than throwing — see `packages/cli/src/lib/platform-factory.ts`.

## Behavior

- `resolve({ sha })` queries `deployments(first: 20, ...)` filtered by
  project (+ optional environment).
- Filters client-side by `meta.commitHash === sha` AND
  `status === "SUCCESS"`.
- Picks the newest by `createdAt`.
- Prefers `staticUrl` (`*.up.railway.app`); falls back to `url` for
  custom domains.
- 404 → null. 401/403 → throws (auth failure). 5xx → throws.
- GraphQL `errors[]` in the response body → throws.

## Limits

- Non-SUCCESS statuses (BUILDING, DEPLOYING, FAILED, etc.) are filtered.
  For a staging preview that's still building, retry with
  `waitSeconds > 0`.
- Railway's GraphQL schema is not versioned. If this adapter breaks
  after a Railway API change, the exact selection set in
  `DEPLOYMENTS_QUERY` (src/index.ts) is the thing to update.
