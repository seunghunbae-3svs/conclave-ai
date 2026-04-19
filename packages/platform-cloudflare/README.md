# @conclave-ai/platform-cloudflare

Cloudflare Pages adapter. Mirrors `@conclave-ai/platform-vercel` /
`platform-netlify` contracts.

## Env

| Var | Required |
|---|---|
| `CLOUDFLARE_API_TOKEN` | ✓ (Pages:Edit permission) |
| `CLOUDFLARE_ACCOUNT_ID` | ✓ |
| `CLOUDFLARE_PROJECT_NAME` | ✓ |

```ts
import { CloudflarePlatform } from "@conclave-ai/platform-cloudflare";
const cf = new CloudflarePlatform();  // reads env
```
