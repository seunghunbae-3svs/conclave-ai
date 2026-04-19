# @ai-conclave/platform-netlify

Netlify adapter. Mirrors the `Platform` contract from
`@ai-conclave/platform-vercel`; same API pattern.

## Env

| Var | Required |
|---|---|
| `NETLIFY_TOKEN` | ✓ |
| `NETLIFY_SITE_ID` | ✓ |

```ts
import { NetlifyPlatform } from "@ai-conclave/platform-netlify";
const netlify = new NetlifyPlatform({
  token: process.env.NETLIFY_TOKEN,
  siteId: process.env.NETLIFY_SITE_ID,
});
```
