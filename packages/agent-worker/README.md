# @conclave-ai/agent-worker

Worker agent for Conclave AI. Consumes `ReviewResult[]` from the council and emits a unified-diff `WorkerOutcome` ready to be applied with `git apply` and committed back to the PR branch.

Pure with respect to the filesystem — it never reads files or shells out to git. The caller (typically the `conclave rework` CLI) is responsible for reading file snapshots, applying the returned patch, and committing.

## Usage

```ts
import { ClaudeWorker } from "@conclave-ai/agent-worker";
import { EfficiencyGate } from "@conclave-ai/core";

const worker = new ClaudeWorker({
  apiKey: process.env.ANTHROPIC_API_KEY,
  gate: new EfficiencyGate({ perPrUsd: 5 }),
});

const outcome = await worker.work({
  repo: "acme/service",
  pullNumber: 42,
  newSha: "abc123",
  reviews: councilOutcome.results,
  fileSnapshots: [
    { path: "src/auth.ts", contents: fs.readFileSync("src/auth.ts", "utf8") },
  ],
});

// outcome.patch  → unified diff
// outcome.message → commit subject
// outcome.appliedFiles → ["src/auth.ts"]
```

## Why a separate package

The worker uses the same LLM plumbing as `agent-claude` (tool-use, efficiency gate, pricing table) but emits a fundamentally different artifact — a patch, not a review. Keeping them separate means the `Agent` interface in `@conclave-ai/core` stays clean (review-only) and the worker's commit-loop concerns don't leak into the council.

## Guard integration

The worker itself does not wrap calls in `LoopGuard` / `CircuitBreaker` — the caller is expected to do that, because the "did we already try this" signal lives at the PR/sha level that only the orchestrator can see. Pattern:

```ts
const loopGuard = new LoopGuard();
const breaker = new CircuitBreaker();

loopGuard.check(`${ctx.repo}#${ctx.pullNumber}:${ctx.newSha}`);
const outcome = await breaker.guard("worker", () => worker.work(ctx));
```

See `@conclave-ai/core` `guards.ts` for the API.
