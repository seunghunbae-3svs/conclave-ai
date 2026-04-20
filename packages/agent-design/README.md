# @conclave-ai/agent-design

Design-specialist agent for Conclave AI — implements the `Agent` interface
from `@conclave-ai/core` and reviews design changes by reasoning over
before/after screenshot pairs supplied on `ReviewContext.visualArtifacts`.

This agent is **primary**: it returns a standard `ReviewResult` (verdict +
blockers + summary) so the Council debate loop treats it identically to the
text-based `ClaudeAgent` / `OpenAIAgent` / `GeminiAgent`. It complements
`@conclave-ai/visual-review`'s `ClaudeVisionJudge` (a helper that classifies
pixel-diff regions), not replaces it.

When no `visualArtifacts` are present on the context, the agent returns a
graceful `approve` verdict with a summary noting the missing artifacts —
never throws. This keeps the v0.5.0-alpha useful even before the screenshot
capture pipeline is wired into the review command.

## Install

```bash
pnpm add @conclave-ai/agent-design @conclave-ai/core
```

## Usage

```ts
import { DesignAgent } from "@conclave-ai/agent-design";
import { TieredCouncil } from "@conclave-ai/core";

const design = new DesignAgent({ model: "claude-opus-4-7" });
const council = new TieredCouncil({
  tier1Agents: [design],
  tier2Agents: [design],
});
```
