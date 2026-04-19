# @conclave-ai/agent-grok

Conclave AI Grok agent. Wraps xAI's OpenAI-wire-compatible API at
`https://api.x.ai/v1` via the `openai` SDK.

## Install

Pulled in automatically by `@conclave-ai/cli` when `"grok"` is in
`.conclaverc.json` → `agents`.

Standalone:
```bash
pnpm add @conclave-ai/agent-grok
```

## Models

| Model | Use |
|---|---|
| `grok-code-fast-1` | Default — code-tuned, cheapest per call (~$0.20/M input, $1.50/M output) |
| `grok-3-mini` | General lightweight tier |
| `grok-3` | Reasoning-capable general purpose |
| `grok-4` | Flagship reasoning model |

## Env

| Var | Required | Notes |
|---|---|---|
| `XAI_API_KEY` | yes | Get one at https://console.x.ai |

## Usage

```typescript
import { GrokAgent } from "@conclave-ai/agent-grok";

const agent = new GrokAgent({ gate: efficiencyGate });
const result = await agent.review(ctx);
```

Same `Agent` contract as the other council members. Prompt-cache
discount applies on supported models (reflected in the pricing table).
