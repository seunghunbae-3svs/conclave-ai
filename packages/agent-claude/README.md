# @conclave-ai/agent-claude

Claude agent for Conclave AI council review. Implements the `Agent`
interface from `@conclave-ai/core`.

Skeleton status: interface correct, review stub returns `approve`. Real
tool-use loop (via `@anthropic-ai/claude-agent-sdk`) with RAG over
answer-keys + failure-catalog and efficiency-gate cost metering lands in
a later PR.

## Install

```bash
pnpm add @conclave-ai/agent-claude @conclave-ai/core
```

## Usage

```ts
import { ClaudeAgent } from "@conclave-ai/agent-claude";
import { Council } from "@conclave-ai/core";

const agent = new ClaudeAgent({ apiKey: process.env.ANTHROPIC_API_KEY });
const council = new Council({ agents: [agent] });
```
