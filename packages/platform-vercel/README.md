# @ai-conclave/platform-vercel

Vercel adapter for Ai-Conclave — resolves the preview URL for a given
commit SHA via Vercel's `/v6/deployments` REST endpoint. Implements the
`Platform` interface from `@ai-conclave/core`.

Decision #31: Vercel is part of the v2.0 platform set alongside Netlify
/ Railway / Cloudflare Pages / `deployment-status`.

## Install

```bash
pnpm add @ai-conclave/platform-vercel @ai-conclave/core
```

## Usage

```ts
import { VercelPlatform } from "@ai-conclave/platform-vercel";
import { resolveFirstPreview } from "@ai-conclave/core";

const vercel = new VercelPlatform({
  token: process.env.VERCEL_TOKEN,
  projectId: process.env.VERCEL_PROJECT_ID, // optional filter
});

const preview = await resolveFirstPreview([vercel], {
  repo: "acme/app",
  sha: "abc123",
  waitSeconds: 120, // poll up to 2 min if deployment still building
});
```

## Env

| Var | Required | Purpose |
|---|---|---|
| `VERCEL_TOKEN` | ✓ | Auth |
| `VERCEL_TEAM_ID` | team projects | Team scope |
| `VERCEL_PROJECT_ID` | optional | Filter to a single project |

## Polling behavior

- `waitSeconds: 0` (default): one poll; returns null if no READY deployment yet.
- `waitSeconds > 0`: polls every ~3s until READY or deadline — useful when calling conclave review right after `git push` (deployment is still BUILDING).
- Returns null on 404 (unknown SHA) or non-matching state.
- Throws on auth failure (401/403) or 5xx — `resolveFirstPreview` catches + tries the next adapter.
