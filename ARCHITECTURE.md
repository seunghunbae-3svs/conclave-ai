# Conclave AI Architecture

**Status:** architecture finalized 2026-04-19. Decisions 1–34 are locked; do
not re-litigate without explicit reopen. This document is the source of
truth for scaffolding.

## Product

- **Brand**: Conclave AI (hero display may be stylized `Con{claude}ve`)
- **npm scope**: `@conclave-ai` (fallbacks: `conclaveai`, `conclave-ai-io`)
- **CLI binary**: `conclave`
- **Positioning (α)**: *"AI drafted. Council refined."*
- **Tagline**: *A multi-agent council reviews your AI-generated code and
  design, debates issues, auto-fixes blockers, and learns your preferences
  over time. Built for solo makers who ship with AI.*
- **Target persona**: anyone shipping AI-generated output without a
  dedicated reviewer. Three concentric circles:
  1. **AI coding assistants** (Cursor / Claude Code / Windsurf /
     Copilot) — review AI-written diffs alongside human-written ones.
  2. **App-from-prompt builders** (v0 / Lovable / Bolt / Base44) —
     the output is an entire app; council reviews each generated PR.
  3. **Autonomous agents** (Manus AI / Devin / general task-runners) —
     the output is a task result with code + config side-effects.
  Not seasoned engineers polishing their own code.

## 7-Layer Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 1 — USER SURFACE (equal weight, any subset)          │
│  CLI · Web · VSCode · Telegram · Discord · Slack · Email    │
└───────────────────────────┬─────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│  Layer 2 — EFFICIENCY GATE (every LLM call routes through)  │
│  cache · triage · budget · compact · route · metrics        │
└───────────────────────────┬─────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│  Layer 3 — DECISION CORE                                    │
│  Council (Mastra graph, N pluggable agents)                 │
│  Tool-use loops (Claude Agent SDK + OpenAI Agents SDK)      │
│  Structured I/O (Zod schemas, MCP protocol)                 │
│  Scoring (Build 40% / Review 30% / Time 20% / Rework 10%)   │
└────────┬────────────────────────────────┬───────────────────┘
         ↕                                ↕
┌────────────────────────┐  ┌────────────────────────────────┐
│  Layer 4 — AGENTS      │  │  Layer 5 — INFRASTRUCTURE      │
│  @conclave-ai/agent-*  │  │  scm / platform / integration  │
│  (pluggable npm pkgs)  │  │  packages                      │
│  claude, openai,       │  │  GitHub/Vercel/Netlify/...     │
│  gemini, grok,         │  │  Telegram/Discord/Slack/Email  │
│  deepseek, qwen,       │  │                                │
│  bedrock, vertex,      │  │                                │
│  cheetah (Triton),     │  │                                │
│  ollama (local),       │  │                                │
│  custom user-authored  │  │                                │
└────────────────────────┘  └────────────────────────────────┘
         ↕                                ↕
┌────────────────────────┐  ┌────────────────────────────────┐
│  Layer 6 —             │  │  Layer 7 — OBSERVABILITY       │
│  SELF-EVOLVE           │  │  Langfuse self-hosted          │
│  (정답지 + 오답지)     │  │  per-PR trace                  │
│  episodic (90d)        │  │  cache hit rate                │
│  answer-keys (∞)       │  │  cost + tokens per call        │
│  failure-catalog (∞)   │  │  precision/recall per category │
│  semantic rules        │  │  agent scores over time        │
│  procedural playbooks  │  │  budget compliance             │
│  federated baseline    │  │                                │
│  (hash+cat, DP)        │  │                                │
└────────────────────────┘  └────────────────────────────────┘
```

## Self-Evolve Substrate (정답지/오답지 duality — the moat)

```
packages/core/src/memory/
├── episodic/                      # raw event log, 90d TTL
│   └── YYYY-MM-DD/pr-{n}.json
├── answer-keys/ (정답지)          # ★ SUCCESS PATTERNS
│   ├── code/{by-pattern,by-user,by-repo}/
│   └── design/{by-pattern,by-component}/
├── failure-catalog/ (오답지)      # ★ FAILURE PATTERNS
│   ├── code/by-category/{type-errors,missing-tests,regression,security,...}
│   └── design/{accessibility-fails,contrast-fails,...}
├── semantic/rules.json            # extracted rules (nightly Haiku compression)
├── procedural/playbooks.md        # promoted how-to (weekly)
└── federated-sync/                # cross-user (hash+category ONLY)
    ├── answer-keys-baseline/
    └── failure-baseline/
```

**Training loop:**
- Merge → write to answer-keys (positive)
- Reject → write to failure-catalog (negative)
- Rework → failure (1st version) + answer-key (final accepted)
- Every review READS: top-K answer-keys + top-K failures + procedural
  rules + federated baseline signal (RAG into system prompt)
- Nightly: episodic → classify into catalogs (Haiku, cheap)
- Weekly: catalog → semantic rules
- Monthly: semantic → procedural + federated sync

## Efficiency Gate (day-1 requirement)

```
packages/core/src/efficiency/
├── cache.ts        # Anthropic prompt-cache 5-min TTL aware scheduling
├── compact.ts      # Round-to-round context compression (Haiku summary)
├── triage.ts       # Small/simple PR → lite path (single agent)
│                   # Complex PR → full council (3-round)
├── budget.ts       # Hard cost caps: per-PR default $0.50
├── relevance.ts    # Selective context (diff + import graph)
├── router.ts       # Model by input size (Haiku / Sonnet / Gemini 2.5 Pro)
└── metrics.ts      # Per-call cost/tokens/latency → Langfuse
```

**All LLM calls route through efficiency gate. Direct SDK calls forbidden.**

Expected (compounded): $0.50 default PR budget → $0.08–0.15 actual average.

## Scoring (ported from solo-cto-agent)

Rolling weighted score per agent:
- Build pass rate: 40%
- Review approval rate: 30%
- Time to resolution: 20%
- Rework frequency: 10%

Plus new metrics:
- Precision / recall per blocker category (per agent)
- Cache hit rate (efficiency)
- Cost per PR (budget compliance)

## Tech Stack (locked)

| Purpose | Tech |
|---|---|
| Language | TypeScript (strict) |
| Monorepo | pnpm workspaces + turbo |
| Orchestration | **Mastra** (TS-native multi-agent) |
| Claude agent loop | `@anthropic-ai/claude-agent-sdk` (official TS) |
| OpenAI agent loop | `@openai/agents` v0.8.x (official TS) |
| Gemini | `@google/genai` with 2.5 Pro (long-context slot) |
| Structured output | Zod → JSON Schema + per-provider adapter |
| Tool protocol | MCP (filesystem, Figma Dev Mode, GitHub, custom) |
| Observability | **Langfuse self-hosted** |
| Workflow engine | GitHub Actions (Trigger.dev v3 fallback only if 6h hit) |
| Visual diff | `odiff` + Playwright + vision-model semantic judge |
| Plugin loading | `cosmiconfig` + dynamic `import()` |

## Monorepo Layout

```
conclave-ai/
├── package.json                  # pnpm workspace root
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
├── README.md
├── ARCHITECTURE.md               # this doc
├── LICENSE
├── packages/
│   ├── core/                     # @conclave-ai/core
│   │   └── src/
│   │       ├── agent.ts          # Agent interface
│   │       ├── council.ts        # Mastra-based N-agent graph
│   │       ├── schema/           # Zod schemas
│   │       ├── memory/           # self-evolve 정답지/오답지
│   │       ├── efficiency/       # cache/triage/budget/compact/route
│   │       ├── scoring/          # ported from solo-cto-agent
│   │       ├── guards.ts         # anti-loop + circuit breaker
│   │       └── registry.ts       # plugin registration
│   ├── agent-claude/             # wraps @anthropic-ai/claude-agent-sdk
│   ├── agent-openai/             # wraps @openai/agents          (v2.1)
│   ├── agent-gemini/             # (v2.1)
│   ├── agent-{grok,deepseek,qwen,bedrock,vertex,cheetah,ollama}/ (v2.1)
│   ├── scm-github/               # v2.0
│   ├── scm-{gitlab,bitbucket,gitea}/                              (v2.1)
│   ├── platform-{vercel,netlify,railway,cloudflare,fly,render,
│   │              replit,vertex-deploy,docker-local,
│   │              deployment-status}/
│   ├── integration-{telegram,discord,slack,email}/
│   ├── cli/                      # @conclave-ai/cli, binary `conclave`
│   └── orchestrator-template/    # GitHub Actions YAML templates
├── apps/
│   ├── web-dashboard/            # v2.1 — cost/trace viz
│   └── vscode-extension/
└── docs/
```

## End-to-End Pipeline

1. **Intent Capture** — CLI / Telegram / Discord / Web / IDE → raw NL
2. **Intent Parse** — router agent (Haiku) → structured Intent (Zod)
3. **Work Dispatch** — SCM labeled issue OR direct dispatch
4. **Worker Execution** — tool-use loop → PR with commits (reads
   answer-keys + procedural memory for style)
5. **Council Consensus** — 3-round debate (or early-exit). Each agent
   reads answer-keys + failure-catalog + federated baseline as RAG
6. **Rework Loop** — on blocker: rework agent → commits → re-review
   (bounded by maxRounds + circuit breaker)
7. **Visual Verify** — resolve preview URL (any platform) → Playwright +
   odiff → vision-model semantic judgment → attach to PR + notifications
8. **Delivery** — consolidated message to configured channels, action
   buttons
9. **Merge + Final Notify** — GitHub auto-merge on CI green
10. **Learning** — outcome writes to episodic → nightly classify → weekly
    extract rules → monthly federate

## Migration From solo-cto-agent

Port directly (no redesign):
- `failure-catalog.json` (ERR-001~) → seed `failure-catalog/code/`
- Agent scoring weights → `scoring/` package
- Anti-loop 7-layer guards → `guards.ts` middleware
- Circuit breaker → `guards.ts`
- `diff-guard.js` secret detection → new `secret-guard/` package
- Orchestrator workflow templates → `orchestrator-template/`

solo-cto-agent 1.4.x stays on npm in maintenance (security fixes only).
`conclave migrate` CLI at v2.0 RC.

## Novelty Self-Assessment (locked)

- Individual features: 4.5/10 (prior art exists)
- Architectural sophistication: **8.5/10**
- Self-evolve as moat (정답지/오답지 duality + federated): **9/10**
- Overall product thesis: **8.5/10**
- Execution risk pulls shipped value: TBD

**Differentiators (priority order):**
1. 정답지 + 오답지 dual catalog as RLHF-like substrate without fine-tuning
2. Efficiency gate built in from day 1 (most multi-agent systems die from cost)
3. Architectural coherence (all 7 layers woven, not bolted-on)
4. Pluggable agents including self-hosted Triton-based + local Ollama
