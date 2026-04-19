# @ai-conclave/agent-claude

Claude agent for Ai-Conclave council review. Implements the `Agent`
interface from `@ai-conclave/core`.

Skeleton status: interface correct, review stub returns `approve`. Real
tool-use loop (via `@anthropic-ai/claude-agent-sdk`) with RAG over
answer-keys + failure-catalog and efficiency-gate cost metering lands in
a later PR.

## Install

```bash
pnpm add @ai-conclave/agent-claude @ai-conclave/core
```

## Usage

```ts
import { ClaudeAgent } from "@ai-conclave/agent-claude";
import { Council } from "@ai-conclave/core";

const agent = new ClaudeAgent({ apiKey: process.env.ANTHROPIC_API_KEY });
const council = new Council({ agents: [agent] });
```
