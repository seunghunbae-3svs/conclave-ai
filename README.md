# Ai-Conclave

**AI drafted. Council refined.**

A multi-agent council reviews your AI-generated code and design, debates
issues across rounds until it reaches consensus, auto-fixes blockers, and
learns your preferences over time. Built for solo makers who ship with AI.

> **Status**: pre-alpha scaffolding. The architecture is locked; the
> monorepo skeleton is landing in stages. See `ARCHITECTURE.md` for the
> full 7-layer design.

## Who this is for

Users of Cursor, Claude Code, Windsurf, v0, Lovable, or Bolt whose
AI-generated output is mediocre, off-style, or needs human polish — but
who don't want to hire a reviewer.

This is **not** a tool for seasoned engineers polishing code they wrote
themselves. It is a council for code that came out of an AI.

## The core idea

```
You ship AI-generated code
  ↓
Council (N pluggable agents) debates it (up to 3 rounds, early-exit on agreement)
  ↓
Blockers → auto-rework commits back to your PR
  ↓
Merge → success pattern → answer-keys (정답지)
Reject → failure pattern → failure-catalog (오답지)
  ↓
Next review reads both catalogs as RAG context → gets smarter over time
```

Two substrates (정답지 + 오답지) seed the self-evolve loop. Most systems
use one signal (positive OR negative). Here both are first-class.

## Packages

| Package | Purpose |
|---|---|
| `@ai-conclave/core` | Agent interface, council orchestration, self-evolve substrate, efficiency gate |
| `@ai-conclave/agent-claude` | Claude agent wrapper (built on `@anthropic-ai/claude-agent-sdk`) |
| `@ai-conclave/cli` | `conclave` binary — `init` / `review` / `migrate` |

More agents (`agent-openai`, `agent-gemini`, …) and infrastructure packages
(`scm-github`, `platform-vercel`, `integration-telegram`, …) land in
subsequent PRs per `ARCHITECTURE.md`.

## Quickstart (once published)

```bash
pnpm add -g @ai-conclave/cli
conclave init            # wire up your repo
conclave review          # run a council review on the current branch
```

## Development

```bash
pnpm install
pnpm build               # compile all packages
pnpm dev                 # watch-mode
pnpm test
```

Requires Node >= 20 and pnpm >= 9.

## Relation to solo-cto-agent

`solo-cto-agent` is the v1 predecessor. It stays at
[npm](https://www.npmjs.com/package/solo-cto-agent) in maintenance mode
(security fixes only). Ai-Conclave is a clean-slate rewrite under a new
npm scope (`@ai-conclave`) with a multi-agent architecture. A
`conclave migrate` CLI command will be provided at v2.0 RC.

## License

MIT © 2026 Seunghun Bae
