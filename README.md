# Ai-Conclave

**AI drafted. Council refined.**

A multi-agent council reviews your AI-generated code, debates blockers
across up to 3 rounds until it reaches consensus, and learns from every
merge + rejection so future reviews match your repo's real tolerance for
"blocker" vs "nit". Built for solo makers who ship with AI.

> **Status**: v2.0 development. Architecture locked; 29/34 decisions
> implemented across 28 PRs. Not yet published to npm — see `ARCHITECTURE.md`
> for the full 7-layer design.

## Who this is for

Anyone shipping AI-generated code or AI-built apps but not hiring a
reviewer. Concretely:

- **AI coding assistants** — Cursor, Claude Code, Windsurf, Copilot
- **App-from-prompt builders** — v0, Lovable, Bolt, Base44
- **Autonomous agents** — Manus AI, Devin, Cognition-style task runners

This is **not** a tool for seasoned engineers polishing code they wrote
themselves. It is a council for code that came out of an AI.

## How it works

```
You push AI-generated code
  ↓
Efficiency gate (cache / triage / budget / compact / route)
  ↓
Council — up to 3 rounds of debate across N agents
  Round 1: independent review
  Round 2: each agent sees the others' blockers, can revise
  Round 3: final vote; early-exit the moment all approve OR any reject
  ↓
Merged  → success pattern → answer-keys  (정답지)
Rejected → failure pattern → failure-catalog (오답지)
  ↓
Next review reads BOTH catalogs as RAG context → the council gets smarter
```

Both signals are first-class. Most ML systems use one (positive OR
negative); here `정답지 ∥ 오답지` is the primitive — decision #17.

## The numbers

- **18 workspace packages** — core + 3 agents (Claude/OpenAI/Gemini) +
  4 notifiers (Telegram/Discord/Slack/Email) + 5 platform adapters
  (Vercel/Netlify/Cloudflare Pages/Railway/GitHub deployment_status) +
  SCM + observability + visual review + CLI.
- **9 CLI commands** covering init → review → outcome capture →
  seeding → migration → scoring → federated sync.
- **Cost per PR**: ~$0.05-$0.20 at current pricing with caching + triage,
  capped by a per-PR budget that the efficiency gate enforces before any
  LLM call fires.
- **Privacy-first federation**: `conclave sync` exchanges k-anonymous
  baseline signal (category + severity + tag vector + hash) with other
  users — no code, diffs, titles, or repo names ever leave your machine.
  OFF by default.

## Packages

| Package | Purpose |
|---|---|
| `@ai-conclave/core` | Agent interface, Council (3-round debate), efficiency gate, memory substrate (정답지 + 오답지), scoring (decision #19), federated sync (decision #21) |
| `@ai-conclave/agent-claude` | Claude reviewer — tool-use with `submit_review` + prompt caching |
| `@ai-conclave/agent-openai` | OpenAI reviewer — strict JSON schema + cached-token discount |
| `@ai-conclave/agent-gemini` | Gemini reviewer — long-context routing tier |
| `@ai-conclave/cli` | `conclave` binary — 9 commands |
| `@ai-conclave/scm-github` | `gh`-CLI wrapper + `conclave poll-outcomes` |
| `@ai-conclave/platform-vercel` · `-netlify` · `-cloudflare` · `-railway` · `-deployment-status` | Preview URL resolution for visual review (decision #31) |
| `@ai-conclave/integration-telegram` · `-discord` · `-slack` · `-email` | Equal-weight notifiers (decision #24) |
| `@ai-conclave/observability-langfuse` | `LangfuseMetricsSink` for the efficiency gate |
| `@ai-conclave/visual-review` | Playwright capture + pixelmatch diff + `ClaudeVisionJudge` |

## CLI commands

```
conclave init                              # scaffold config + .conclave/ in repo
conclave review [--pr N] [--visual]        # run the 3-round council review
conclave record-outcome --id <ep-id> --result merged|rejected|reworked
conclave poll-outcomes [--quiet]           # auto outcome capture via gh
conclave seed [--from <path>]              # bootstrap failure-catalog
conclave migrate [--from <solo-cto-agent>] # port a v1 install
conclave scores [--json]                   # per-agent weighted performance
conclave sync [--dry-run|--push-only|--pull-only]  # federated baseline (opt-in)
```

## Quickstart (from source, pre-publish)

```bash
git clone https://github.com/seunghunbae-3svs/ai-conclave
cd ai-conclave
pnpm install
pnpm build

# Set at least one agent key:
export ANTHROPIC_API_KEY=sk-ant-...
# Optional additional agents:
export OPENAI_API_KEY=...
export GOOGLE_API_KEY=...

# Drop into a repo you want to review:
cd /path/to/your-repo
node /path/to/ai-conclave/packages/cli/dist/bin/conclave.js init
node /path/to/ai-conclave/packages/cli/dist/bin/conclave.js review --pr 42
```

Once published: `pnpm add -g @ai-conclave/cli`.

Full walkthrough: [docs/getting-started.md](docs/getting-started.md).

## Configuration

`.conclaverc.json` at your repo root. Minimal:

```json
{
  "version": 1,
  "agents": ["claude", "openai", "gemini"],
  "budget": { "perPrUsd": 0.5 },
  "council": { "maxRounds": 3, "enableDebate": true }
}
```

Full reference: [docs/configuration.md](docs/configuration.md).

## Privacy & federated sync

`conclave sync` is **opt-in**. Full privacy model + the exact wire format:
[docs/federated-sync.md](docs/federated-sync.md).

TL;DR: only `{kind, domain, category, severity, normalized tags, day
bucket, sha256(those fields)}` leaves — never the lesson text, title,
body, snippet, repo name, user name, diff, or commit message.

## Development

```bash
pnpm install
pnpm build               # compile all packages
pnpm dev                 # watch-mode
pnpm test                # node --test across every package
```

Requires Node ≥ 20 and pnpm ≥ 9. Monorepo is [Turbo](https://turbo.build/repo).

## Roadmap

See [CHANGELOG.md](CHANGELOG.md) for what's shipped. Current state per
locked decision: [docs/decision-status.md](docs/decision-status.md).

Locked design decisions (do not reopen without explicit reason) live in
`ARCHITECTURE.md`.

## Relation to solo-cto-agent

`solo-cto-agent` is the v1 predecessor, still on
[npm](https://www.npmjs.com/package/solo-cto-agent) in maintenance mode
(security fixes only). Ai-Conclave is a clean-slate rewrite under a new
`@ai-conclave` scope with a multi-agent architecture. `conclave migrate`
ports an existing solo-cto-agent install — config + failure-catalog +
per-step checklist.

## License

MIT © 2026 Seunghun Bae
