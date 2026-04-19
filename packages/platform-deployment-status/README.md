# @conclave-ai/platform-deployment-status

Generic GitHub-Deployments-API adapter. Works with **any** host that
reports deployments back to GitHub via the standard
`deployment_status` event (Vercel / Netlify / Render / Fly / Railway /
Replit / Cloudflare / custom CI workflows — if the host follows
GitHub's standard deploy-status protocol, this adapter resolves its
preview URL).

## Why

The long tail of hosts (Render / Fly / Railway / Replit / self-hosted
Docker) doesn't warrant a dedicated adapter package each. This single
adapter covers them all by reading GitHub as the source of truth —
same way humans audit deploys via the PR's "Deployments" tab.

## Setup

Uses `gh api` — same auth as `@conclave-ai/scm-github`. No separate
token. `gh auth login` once is enough.

## Usage

```ts
import { DeploymentStatusPlatform } from "@conclave-ai/platform-deployment-status";

const generic = new DeploymentStatusPlatform({
  environment: "preview",          // optional filter
  acceptedStates: ["success"],     // default
});
```

## Fallback placement

Put this adapter LAST in your `platforms` array. Dedicated adapters
(Vercel, Netlify, Cloudflare) are faster (direct API) and more
reliable (no dependency on the host posting back to GitHub
correctly). The generic adapter is a safety net for hosts without a
dedicated package.

```ts
const platforms = [
  new VercelPlatform(),
  new NetlifyPlatform(),
  new CloudflarePlatform(),
  new DeploymentStatusPlatform(),  // ← fallback
];
```
