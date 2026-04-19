# @conclave-ai/agent-deepseek

Conclave AI Deepseek agent. Wraps Deepseek's OpenAI-wire-compatible API
via the `openai` SDK pointed at `https://api.deepseek.com`.

## Install

Pulled in automatically by `@conclave-ai/cli` when `"deepseek"` is in
`.conclaverc.json` → `agents`.

Standalone:
```bash
pnpm add @conclave-ai/agent-deepseek
```

## Why Deepseek

~20× cheaper than GPT-5 on input, ~10× cheaper on output. Cache-hit
rate gets you to ~$0.01 per PR review at Deepseek's per-1M prices
(0.27 input / 1.1 output / 0.07 cached-input) vs ~$0.05-0.20 on
Anthropic/OpenAI. Useful when you want a high-frequency reviewer
that can burn through draft PRs without draining the budget.

`deepseek-reasoner` (R1) is available for harder reviews where
chain-of-thought matters — the pricing table + CLI factory pick it
up automatically once routed.

## Env

| Var | Required | Notes |
|---|---|---|
| `DEEPSEEK_API_KEY` | yes | Get one at https://platform.deepseek.com |

Missing key → CLI factory skips this agent with a stderr notice, like
any other agent. No hard throw.

## Usage

```typescript
import { DeepseekAgent } from "@conclave-ai/agent-deepseek";

const agent = new DeepseekAgent({ gate: efficiencyGate });
const result = await agent.review(ctx);
```

Same `Agent` contract as `@conclave-ai/agent-claude` /
`agent-openai` / `agent-gemini`. Review output shape is
`ReviewResult` from `@conclave-ai/core`.
