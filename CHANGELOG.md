# Changelog

## Unreleased

### Added
- Monorepo skeleton (pnpm workspaces + turbo).
- `@ai-conclave/core`: `Agent` / `Council` interfaces + Zod schemas.
- `@ai-conclave/agent-claude`: Claude agent skeleton implementing `Agent`.
- `@ai-conclave/cli`: `conclave` binary with `init` and `review` commands (skeleton).
- `ARCHITECTURE.md`: locked 7-layer design for the council, efficiency gate,
  self-evolve substrate (정답지 + 오답지), and migration path from solo-cto-agent.
- GitHub Actions CI: typecheck + build + test on push/PR.
- **Efficiency Gate** (`@ai-conclave/core/efficiency`) per decision #22 —
  first-class from day 1. Every LLM call must route through
  `EfficiencyGate.run(...)`; direct SDK calls are forbidden by contract.
  - `PromptCache` — Anthropic 5-min TTL aware scheduler (sha256-keyed, LRU-evicted).
  - `BudgetTracker` — $0.50 default per-PR cap (decision #20), throws
    `BudgetExceededError` on reserve-beyond-cap, warning handler at 80% default.
  - `triageReview` — lite (single agent) vs full (3-round council) classification.
    Risky paths (schema / migrations / auth / payments / `.sql` / prisma) always
    force full regardless of size.
  - `selectModel` — input-size routing: Haiku ≤ 8k tokens → Sonnet ≤ 50k →
    Gemini 2.5 Pro for long-context slot (override-able).
  - `compact` — round-to-round context compression (summarizer injected;
    pinned-message preservation; newest-first fit under budget).
  - `buildRelevanceContext` — diff + test-file + direct-import graph walk
    under a token budget (safe defaults when `readFile` / `importsOf` omitted).
  - `MetricsRecorder` — per-call cost / tokens / latency / cache-hit with
    per-agent + per-model aggregation; pluggable external sink for Langfuse.
  - `EfficiencyGate.run(...)` — orchestrates reserve → route → cache-check →
    execute → mark → commit → record in a single call.
- Test coverage (`node --test`): 9 files, 45+ test cases across all
  efficiency modules and Council outcome logic.
- **Real Claude review loop** in `@ai-conclave/agent-claude`:
  - `ClaudeAgent.review(ctx)` now issues a real `messages.create` call via
    the injected (or lazy-loaded) `@anthropic-ai/sdk` client.
  - Single-tool pattern (`tool_choice: { type: "tool", name: "submit_review" }`)
    forces structured output — no free-form parsing.
  - System prompt + RAG prefix sent as a cache-controlled ephemeral block
    so repeat calls within 5 minutes hit Anthropic's prompt cache (~90%
    input-cost savings on the prefix).
  - All SDK calls route through `EfficiencyGate.run(...)`: pre-flight budget
    reserve (throws before the network call), cache-liveness tracking,
    actual-cost metering via `actualCost(model, usage)`, per-call metrics.
  - `PRICING` table covers Sonnet 4.6 / Haiku 4.5 / Opus 4.7 with standard,
    cache-write, and cache-read rates. `estimateCallCost` is pessimistic
    (no cache assumed) for safe pre-flight reservation.
  - Parser tolerates malformed blockers (drops invalid entries instead of
    failing the whole review), throws on missing `submit_review` tool_use
    block or invalid verdict.
  - Agent-claude tests (16 cases): happy verdicts (approve / rework with
    blockers), invalid response shapes, budget enforcement, cache_control
    wire-format, tool_choice wire-format, missing-key constructor guard,
    metrics aggregation on shared gate.
