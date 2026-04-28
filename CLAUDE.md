# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository

Conclave AI — a multi-agent council that reviews AI-generated code, debates blockers across up to 3 rounds, auto-fixes via a worker agent, and learns from merge/reject outcomes. pnpm + Turbo monorepo, TypeScript strict, ESM-only (`"type": "module"`), Node ≥ 20, pnpm ≥ 9.

## Common commands

Run from repo root unless noted. Turbo handles build ordering across the 24 workspace packages.

```bash
pnpm install
pnpm build          # turbo run build  (compiles every package)
pnpm dev            # turbo run dev    (watch mode, persistent)
pnpm test           # turbo run test   (node --test in every package)
pnpm typecheck
pnpm lint
pnpm clean          # turbo run clean + rm -rf node_modules
```

Single-package work — use Turbo's `--filter`:

```bash
pnpm turbo run build    --filter @conclave-ai/core
pnpm turbo run test     --filter @conclave-ai/cli
pnpm turbo run typecheck --filter @conclave-ai/agent-claude
```

Single test file — drop into the package and run node directly:

```bash
cd packages/core && node --test test/council.test.mjs
```

Tests use `node --test` only — **never add Jest or Vitest**. Mock at the seam (inject `fetch`, `spawn`, LLM clients) so tests don't hit the network.

## Releases

**Never run `npm publish` from a laptop.** All 24 packages bump + publish in lockstep via `.github/workflows/release.yml` (Actions → release → Run workflow, on `main`, choose patch/minor/major). The workflow gates `workflow_dispatch` to `main` and fails fast otherwise. See `docs/release-process.md`.

## Central plane (Cloudflare Worker)

`apps/central-plane/` is a Hono-on-Workers app with D1 backing. Has its own scripts:

```bash
cd apps/central-plane
pnpm dev                # wrangler dev
pnpm ship               # preflight + wrangler deploy
pnpm migrate:apply      # wrangler d1 migrations apply --remote
```

## Architecture

`ARCHITECTURE.md` is the source of truth. The 34 decisions locked on 2026-04-19 should not be re-litigated casually — to diverge, cite the decision number in the PR description. Current divergences are tracked in `docs/decision-status.md` (notable: tier-2 cross-review by Opus 4.7 + GPT-5.4 supersedes the original 3-round Mastra debate; the verdict enum is unchanged but tier-1 verdicts are no longer binding once escalated).

**7 layers** (see `ARCHITECTURE.md` for the full diagram):

1. **User surface** — CLI / Telegram / Discord / Slack / Email / Web / VSCode. All notifiers are equal-weight; any subset works.
2. **Efficiency gate** (`packages/core/src/efficiency/`) — cache · triage · budget · compact · route · metrics. **Every LLM call routes through this gate. Direct SDK calls are forbidden.** Per-PR budget defaults are enforced before any LLM call fires.
3. **Decision core** — Council (Mastra graph, N pluggable agents), tool-use loops, Zod-validated I/O, MCP, scoring (Build 40 / Review 30 / Time 20 / Rework 10).
4. **Agents** — `packages/agent-{claude,openai,gemini,grok,ollama,design,worker}`. Pluggable; missing API keys skip cleanly.
5. **Infrastructure** — `packages/scm-github`, `platform-*` (vercel, netlify, cloudflare, railway, render, deployment-status), `integration-*` (telegram, discord, slack, email).
6. **Self-evolve substrate** — `packages/core/src/memory/`. Dual catalogs: `answer-keys/` (success patterns from merges, ∞ TTL) and `failure-catalog/` (failure patterns from rejects, ∞ TTL). Episodic raw log has 90-day TTL. Every review reads top-K from BOTH catalogs as RAG context. This duality is the moat (decision #17).
7. **Observability** — self-hosted Langfuse via `packages/observability-langfuse`.

**Autonomous pipeline (v0.13.x)**: blocker → worker agent rewrites → push commit tagged `cycle:N` → review re-runs without user click. Bounded by `autonomy.maxReworkCycles` (default 3, hard ceiling 5). Patch-apply has a GNU `patch -p1 --fuzz=3` fallback after `git apply` so worker-miscount hunk headers don't reject — see `recountHunkHeaders` in core/autonomy.

## Conventions (these reflect non-obvious project rules)

- **One package, one responsibility.** No `utility/` or `common/` packages — they become dumping grounds. New behavior either extends an existing package's responsibility or gets its own package. When adding a platform adapter, mirror `packages/platform-railway`.
- **Zod at every external boundary.** Anything crossing a wire (HTTP body, file format, CLI input, LLM tool-use response) is parsed through Zod. Don't trust `as` casts at the edge.
- **Tests alongside the code.** Every `packages/X/src/*` change lands with the corresponding `packages/X/test/*.test.mjs`. Use `node --test`. Mock at the seam.
- **Lockstep versioning.** All publishable packages bump together (pre-1.0 policy). Don't hand-edit a single package's version — let the release workflow do it.
- **TypeScript strict + `noUncheckedIndexedAccess`.** Array/object indexing returns `T | undefined`; handle it.
- **Memory format is git-tracked.** `.conclave/answer-keys/` and `.conclave/failure-catalog/` ARE checked in (clones inherit learned patterns). `.conclave/episodic/`, `.conclave/federated/`, `.conclave/visual/` are gitignored.
- **The CLI dogfoods itself.** PRs to this repo are reviewed by `conclave review --pr <N>`; council blockers carry weight alongside human feedback.

## CLI surface

`packages/cli` ships the `conclave` binary with 17 commands: `init`, `audit`, `review`, `autofix`, `doctor`, `repos`, `watch`, `record-outcome`, `poll-outcomes`, `config`, `seed`, `migrate`, `scores`, `sync`, `mcp-server`. The MCP server (stdio) is how IDEs (Claude Desktop, Cursor, Windsurf) integrate — there are no IDE-specific extensions beyond the v2.1 VSCode app.

## Config

Per-repo: `.conclaverc.json` at the repo root, loaded via `cosmiconfig`. Tier-2 escalation models default to `claude-opus-4-7` and `gpt-5.4`; design domain has `alwaysEscalate: true`.

## Federated sync (decision #21)

`conclave sync` is **opt-in**. Only `{kind, domain, category, severity, normalized tags, day bucket, sha256}` leaves the machine — never code, diffs, titles, repo names, user names, or commit messages. See `docs/federated-sync.md` for the wire format.
