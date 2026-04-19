# @conclave-ai/agent-ollama

Conclave AI Ollama agent. Routes reviews to a local or self-hosted
Ollama instance via its OpenAI-compatible endpoint.

## Install

Pulled in automatically by `@conclave-ai/cli` when `"ollama"` is in
`.conclaverc.json` → `agents`.

Standalone:
```bash
pnpm add @conclave-ai/agent-ollama
```

## Why Ollama

- **Zero API cost.** Compute is user-paid hardware; the wire is free.
- **Zero API key.** Nothing leaves the machine if the Ollama instance
  is local.
- **Any model you've pulled.** `ollama pull llama3.3`, `qwen3`,
  `deepseek-r1`, `gpt-oss`, etc. — whatever your hardware runs.

## Prerequisites

```bash
# Install Ollama: https://ollama.com/download
ollama serve                 # starts daemon on localhost:11434
ollama pull llama3.3         # or whichever model the config names
```

## Env / options

| Var / option | Default | Notes |
|---|---|---|
| `OLLAMA_BASE_URL` env / `baseURL` ctor opt | `http://localhost:11434/v1` | Override to point at a remote / container / non-default port |
| `model` ctor opt | `llama3.3` | Any model `ollama list` shows |

No API key required. The underlying `openai` SDK gets the literal
string `"ollama"` as a placeholder so its constructor doesn't throw.

## Usage

```typescript
import { OllamaAgent } from "@conclave-ai/agent-ollama";

const agent = new OllamaAgent({ gate: efficiencyGate });
const result = await agent.review(ctx);
// result.costUsd === 0 always — local inference is not metered
```

## Caveats

- `actualCost` always returns `0`. If you want wall-clock or kWh
  accounting, layer it on top of `MetricsRecorder.latencyMs`; that
  lives outside v0.1 scope.
- `deepseek-r1` and other reasoning models emit far more output tokens
  than the default `maxTokens: 8192` estimate. Bump `maxTokens` via
  constructor if you route reasoning-heavy reviews through Ollama.
- Structured JSON output depends on the model. Smaller models may
  fail the strict schema; the CLI surfaces parse errors like any
  other agent.
