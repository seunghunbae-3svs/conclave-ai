# @conclave-ai/platform-render

Conclave AI Render adapter. Resolves a deploy URL for a given commit
SHA via Render's REST API (`api.render.com/v1`).

Ranked #1 deploy target for solo makers outside the original v2.0
five (Vercel/Netlify/Cloudflare/Railway/deployment-status) per the
2026-04 adapter scope study.

## Install

Pulled in automatically by `@conclave-ai/cli` when `"render"` is in
`config.visual.platforms`.

```bash
pnpm add @conclave-ai/platform-render
```

## Env

| Var | Required | Notes |
|---|---|---|
| `RENDER_API_TOKEN` | yes | User-scoped token (or Service Preview PAT) |
| `RENDER_SERVICE_ID` | yes | `srv-xxxxxxxxxxxx` — either the main service or a specific Service Preview service |

## Behavior

- `GET /v1/services/{serviceId}` — resolve canonical URL.
- `GET /v1/services/{serviceId}/deploys?limit=20` — list deploys.
- Client-side filter: `deploy.commit.id === sha` AND `deploy.status === "live"`.
- Newest by `finishedAt` (fallback `createdAt`) wins.
- Return `{ url: service.serviceDetails.url, sha, deploymentId, createdAt }`.

## Caveats

- **No per-deploy preview URL** on standard Web Services. The service
  URL is stable; returning it + the matched deploy ID is the best
  conforming signal for the `Platform` interface. If you need per-PR
  URLs, configure Render's **Service Previews** — each PR spawns its
  own service with its own `srv-...` id; point this adapter at the
  preview service (or register multiple adapter instances).
- 404 on service → adapter returns null (not thrown). 401/403 → throws.
  5xx → throws with truncated body for diagnostics.
- No native "wait for SHA" API — `waitSeconds` polls every ~3s until
  deadline.
