# @ai-conclave/agent-gemini

Gemini agent for Ai-Conclave council review. Implements the `Agent`
interface from `@ai-conclave/core`. Uses Gemini's `responseSchema`
structured output (decision #10, long-context slot).

## Install

```bash
pnpm add @ai-conclave/agent-gemini @ai-conclave/core
```

## Usage

```ts
import { GeminiAgent } from "@ai-conclave/agent-gemini";
import { Council, EfficiencyGate } from "@ai-conclave/core";

const gate = new EfficiencyGate();
const council = new Council({ agents: [new GeminiAgent({ gate })] });
```

## Models

Default: `gemini-2.5-pro` (long-context slot — 1M token window).

Alternatives via `new GeminiAgent({ model: "gemini-2.5-flash" })` for
cheap triage. Pricing table covers `gemini-2.5-pro`, `gemini-2.5-flash`,
and `gemini-3.0-flash`.

## Env

Reads `GOOGLE_API_KEY` first, falls back to `GEMINI_API_KEY`.
