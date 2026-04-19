# @conclave-ai/agent-openai

OpenAI agent for Conclave AI council review. Implements the `Agent`
interface from `@conclave-ai/core`. Uses strict JSON Schema response
format (decision #12) for guaranteed well-formed `ReviewResult` output.

## Install

```bash
pnpm add @conclave-ai/agent-openai @conclave-ai/core
```

## Usage

```ts
import { OpenAIAgent } from "@conclave-ai/agent-openai";
import { ClaudeAgent } from "@conclave-ai/agent-claude";
import { Council, EfficiencyGate } from "@conclave-ai/core";

const gate = new EfficiencyGate();
const council = new Council({
  agents: [new ClaudeAgent({ gate }), new OpenAIAgent({ gate })],
});
```

## Models

Default: `gpt-5-mini`. Override via `new OpenAIAgent({ model: "gpt-5" })`.

Pricing table covers `gpt-4.1` / `gpt-4.1-mini` / `gpt-5` / `gpt-5-mini` /
`o5` — revisit on publish in case OpenAI changes prices.
