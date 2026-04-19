# Decision status — where each locked decision lives in code

34 decisions were locked on 2026-04-19 (see `ARCHITECTURE.md`). This
document maps each one to its current implementation state. The goal is
to keep "what we decided" honest against "what we built" — without
re-litigating the decisions themselves.

Legend:
- ✅ **Implemented** — landed and test-covered.
- 🟡 **Partial / skeleton** — structure exists, behavior incomplete.
- 🔄 **Diverged** — implementation chose a different path from the
  doc. Rationale recorded below.
- ⏳ **Deferred** — intentionally not built yet; trigger for revisit
  documented.
- 📄 **Doc-only** — the decision is a principle or scope statement,
  not a code artifact.

| # | Topic | Status | Lives in |
|---|---|---|---|
| 1 | Product naming | 📄 | `ARCHITECTURE.md` |
| 2 | 7-layer architecture | ✅ | all `packages/` |
| 3 | Equal-weight user surfaces | ✅ | 4 notifier packages |
| 4 | Target persona | 📄 | `ARCHITECTURE.md`, `README.md` |
| 5 | Name registration plan | 📄 | `ARCHITECTURE.md` |
| 6 | License + repo | 📄 | `package.json`, GitHub repo |
| 7 | 3-round debate (Mastra label) | 🔄 | superseded by 2-tier council (reopened 2026-04-19 by Bae, see below) |
| 8 | Claude agent loop → `@anthropic-ai/claude-agent-sdk` | 🔄 | see below |
| 9 | OpenAI agent loop → `@openai/agents` | 🔄 | see below |
| 10 | Gemini SDK → `@google/genai` | ✅ | `packages/agent-gemini` |
| 11 | MCP tool protocol | ✅ | `packages/cli/src/commands/mcp-server.ts` |
| 12 | Zod → JSON Schema | ✅ | `packages/core/src/schema.ts` + per-agent `review-schema.ts` |
| 13 | Observability → self-hosted Langfuse | ✅ | `packages/observability-langfuse` |
| 14 | Workflow engine → GitHub Actions | ✅ | `.github/workflows/` |
| 15 | Native pixel diff → odiff | ✅ | `packages/visual-review/src/odiff-diff.ts` (opt-in) |
| 16 | Config loader → cosmiconfig | ✅ | `packages/cli/src/lib/config.ts` |
| 17 | Memory dual substrate (정답지 + 오답지) | ✅ | `packages/core/src/memory/` |
| 18 | Seed from solo-cto-agent catalog | ✅ | `packages/core/src/memory/seeder.ts` |
| 19 | Agent scoring weights | ✅ | `packages/core/src/scoring.ts` |
| 20 | Visual review CLI flag | ✅ | `conclave review --visual` |
| 21 | Federated sync | ✅ | `packages/core/src/federated/` + `conclave sync` |
| 22 | Efficiency gate first-class | ✅ | `packages/core/src/efficiency/` |
| 23 | Vision judge (semantic classification) | ✅ | `packages/visual-review/src/judge.ts` |
| 24 | Equal-weight notifiers | ✅ | `integration-{telegram,discord,slack,email}` |
| 25 | Cost per PR target | 📄 | `ARCHITECTURE.md`; `BudgetTracker` enforces |
| 26 | Council verdicts (approve/rework/reject) | 🔄 | verdict enum unchanged, but tier-1 verdict is no longer binding — tier-2 (Opus 4.7 + GPT-5.4) produces the authoritative verdict after escalation |
| 27 | v2.0 launch scope | 📄 | `ARCHITECTURE.md` |
| 28 | v2.0 agent set (Claude + OpenAI + Gemini) | 🔄 | retained at tier-1; tier-2 cross-review couple (Opus 4.7 + GPT-5.4) is the new authoritative layer. Grok / Ollama optional at tier-1 |
| 29 | Architecture coherence > feature novelty | 📄 | `ARCHITECTURE.md` |
| 30 | Migration path from solo-cto-agent | ✅ | `conclave migrate` |
| 31 | v2.0 platform set (5/5) | ✅ | 5 `platform-*` packages |
| 32 | v2.1 agents + platforms | 🟡 | in progress — Deepseek + Ollama + Grok landed; Qwen / Bedrock / Vertex / Cheetah queued |
| 33 | Tier model (Maker / Builder / CTO) | 📄 | `ARCHITECTURE.md`, README tier lines |
| 34 | Self-evolve loop | ✅ | `outcome-writer.ts` + classifier + seeder |

---

## 🔄 #8 + #9 — Agent SDK migrations (diverged, not deferred)

**Decision text**:
- #8: Claude agent loop → `@anthropic-ai/claude-agent-sdk` — "saves
  rolling our own tool_use loop; bundles MCP + compaction."
- #9: OpenAI agent loop → `@openai/agents` v0.8.x — "supersedes
  Assistants API; TS-native."

**What we built instead**: each agent (`agent-claude`, `agent-openai`,
`agent-gemini`) is a **one-shot reviewer**, not an agent loop. It
receives a `ReviewContext`, makes one structured-output call via the
provider's base SDK (`@anthropic-ai/sdk`, `openai`, `@google/genai`),
and returns a single `ReviewResult`. The multi-round debate lives in
`Council.deliberate()` (decision #7, one level up).

**Why this is a divergence, not a deferral**: the rationale for #8/#9
was "saves rolling our own tool_use loop." The current implementation
has no loop to save — agents call `submit_review` (Claude) or respond
with strict JSON (OpenAI / Gemini) **once** per invocation. The
agent-SDK wrappers are designed for autonomous multi-step agents
(Claude Code-style), which is both out of scope for a reviewer and
adds real weight:

- `@anthropic-ai/claude-agent-sdk` — 3.9 MB, bundles MCP + subagent
  system, designed for long-running autonomous loops.
- `@openai/agents` — pulls `@openai/agents-core`, `@openai/agents-openai`,
  `@openai/agents-realtime` as transitive deps.

**What would trigger migration**: if a future requirement puts
per-agent tool use inside a single review — e.g., an agent that calls
an MCP server mid-review to look up external context, or that iterates
after seeing its own failed proposals — the SDK abstractions start
earning their weight. At that point, #8/#9 become the right answer.

**Concretely**:
- If `agent-claude` starts needing tool orchestration beyond
  `submit_review`, migrate.
- If OpenAI adds a feature (computer-use, structured tool workflows)
  that we need and the base SDK doesn't expose cleanly, migrate.
- Until then, the base SDKs are the smaller, honest, testable choice.

The lock on #8/#9 is respected: we did not revisit the tradeoff
casually. We implemented the use case they anticipated (one-shot
structured review, with multi-round debate handled at the Council
layer) and found the SDKs don't fit that shape.

---

## 🔄 #7 + #26 + #28 — 2-tier council (reopened 2026-04-19 by Bae)

**Locked text (2026-04-19):**
- #7: Council (Mastra graph, N pluggable agents) — 3-round debate
- #26: Council verdicts `approve / rework / reject`
- #28: v2.0 agent set = Claude + OpenAI + Gemini

**Reopen rationale** (explicit, per Bae 2026-04-19):
Flat 3-round debate made every review pay top-tier cost. Dogfood runs
showed a typo-fix PR burning the same spend as a schema migration
review. Moving to a tiered council keeps the cheap agents doing the
bulk of the drafting and reserves the expensive cross-review (Opus
4.7 ↔ GPT-5.4) for escalated cases.

**New shape:**

```
Tier 1 (draft, 1-round, parallel):
  Claude Sonnet 4.6  +  GPT-5 mini  +  Gemini 2.5 Pro
  (+ Grok and/or Ollama opt-in when keys/daemon are available)
                      │
                      ▼
Escalation rule:
  - code:   blockers >= MAJOR present → escalate; else tier-1 verdict ships
  - design: always escalate (mid-tier misses visual polish per research)
                      │
                      ▼
Tier 2 (authoritative, up to 2-round cross-review):
  Claude Opus 4.7  +  GPT-5.4
  Final verdict is binding.
```

**What survives unchanged:**
- The verdict enum (`approve / rework / reject`) — semantics preserved.
- The memory substrate (answer-keys + failure-catalog) — tier-2's final
  verdict is what gets written.
- Agent scoring (#19) — weights unchanged; per-tier attribution via
  `ReviewContext.tier` landing in PR 1.
- Per-agent prompt caching and efficiency gate — every call still
  routes through the gate.

**What's new:**
- `ReviewDomain = "code" | "design"` on `ReviewContext`
- `config.council.domains.{code,design}` — per-domain tier-1 / tier-2
  agent lists, maxRounds, always-escalate flag, optional model overrides
- `TieredCouncil` class (PR 2, following this one)
- CLI `--domain` flag (PR 3)

**Explicitly dropped (also 2026-04-19, Bae):**
- **Idea domain.** Not in scope for the review council. If idea/
  brainstorm workflow lands it ships as a separate skill/package, not
  part of `conclave review`.
- **Deepseek from default agent list.** Still published at
  `@conclave-ai/agent-deepseek@0.1.0` (npm 72-hour window passed,
  can't unpublish and don't need to), but removed from the default
  tier-1 config. User can opt back in via explicit `agents` entry.

**Trigger for a future reopen:**
If tier-2 gets called on >60% of reviews (meaning tier-1 isn't
catching enough), rebalance — either stronger tier-1 models, or
a third intermediate tier. If tier-2 gets called on <10% (tier-1 is
too permissive), tighten the escalation rule.

---

## ⏳ Intentionally deferred

| # | Topic | Trigger |
|---|---|---|
| 32 | v2.1 agent set (Grok / Deepseek / Qwen / Bedrock / Vertex / Cheetah / Ollama) | v2.0 published + at least one user request for an agent outside the v2.0 set |

## Anything not in this table

…is either a principle/scope statement from `ARCHITECTURE.md` (counted
as 📄) or landed before this document existed and is visible in the
code. If you find something you think is missing, grep for the
decision number in commit messages — every merged PR references the
decisions it implements.
