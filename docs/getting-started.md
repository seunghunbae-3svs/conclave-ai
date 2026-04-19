# Getting started with Conclave AI

Step-by-step from zero to a real council review.

## Prerequisites

- Node ≥ 20 (24.x tested)
- pnpm ≥ 9 (10.x tested; install via `corepack prepare pnpm@10 --activate`)
- At least ONE LLM API key. The council runs on whatever subset of
  agents you have keys for; missing agents skip cleanly.

## 1. Install the CLI

```bash
pnpm add -g @conclave-ai/cli
# or: npm install -g @conclave-ai/cli
```

This installs the `conclave` binary. Verify:

```bash
conclave --version
```

(Prefer building from source? See the [Contributing guide](../CONTRIBUTING.md).)

## 2. Set agent API keys

| Agent | Env var |
|---|---|
| Claude | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Gemini | `GOOGLE_API_KEY` (or `GEMINI_API_KEY` as fallback) |

```bash
export ANTHROPIC_API_KEY=sk-ant-...
# Optional:
export OPENAI_API_KEY=sk-proj-...
export GOOGLE_API_KEY=...
```

## 3. Initialize the target repo

```bash
cd /path/to/your-repo
conclave init
```

This writes `.conclaverc.json` at the repo root and creates
`.conclave/` for the memory substrate. Edit `.conclaverc.json` to enable
only the agents you set keys for:

```json
{
  "version": 1,
  "agents": ["claude"],
  "budget": { "perPrUsd": 0.5 },
  "council": { "maxRounds": 3, "enableDebate": true }
}
```

## 4. First review

For a PR:

```bash
conclave review --pr 42
```

For the current branch against its base:

```bash
conclave review --base main
```

From a diff file:

```bash
git diff main... > /tmp/change.diff
conclave review --diff /tmp/change.diff
```

Exit codes:
- `0` — approve
- `1` — rework
- `2` — reject

## 5. Record the outcome when the PR lands

Either automatic (recommended — cron the `poll-outcomes` command):

```bash
conclave poll-outcomes --quiet
```

This checks every pending episodic entry against live GitHub state
(`gh pr view`) and classifies into answer-keys / failures.

Or manual:

```bash
conclave record-outcome --id ep-... --result merged
```

Both paths write the distilled pattern into the memory substrate, where
the next review picks it up as RAG context.

## 6. (Optional) Bootstrap from failure-catalog

If you want the council to inherit lessons from an existing
solo-cto-agent installation:

```bash
conclave migrate --from ../path/to/solo-cto-agent --dry-run
conclave migrate --from ../path/to/solo-cto-agent
```

Or seed from the bundled default catalog (~15 failure patterns
harvested from v1's incident log):

```bash
conclave seed
```

## 7. (Optional) Visual review for UI work

Enable in `.conclaverc.json`:

```json
{
  "visual": {
    "enabled": true,
    "platforms": ["vercel", "netlify", "cloudflare", "railway", "deployment-status"]
  }
}
```

Set whichever platform env vars apply to your deploy target (see
[configuration.md](configuration.md) for the full matrix). Then:

```bash
conclave review --pr 42 --visual
```

## 8. (Optional) Agent performance tracking

```bash
conclave scores
conclave scores --json | jq .
```

After a few merges, each agent's rolling score shows who's carrying
the council. Weights per decision #19: build-pass 40%, review-approval
30%, time 20% (not yet tracked), rework 10%.

## 9. (Optional) Federated baseline signal

OFF by default. See [federated-sync.md](federated-sync.md) before
enabling. Privacy model is strict: only hash + category + severity +
normalized tag vector leaves.

## Troubleshooting

- **"no agents available"** — no agent API key is set. Export at least
  `ANTHROPIC_API_KEY` or update `agents` in `.conclaverc.json`.
- **"conclave review: visual platform X skipped — TOKEN not set"** —
  expected; the platform factory skips adapters with missing creds. If
  no platforms resolve, visual review silently disables.
- **Build fails with "module does not provide export"** — a downstream
  package lost its `dist/`. Run `pnpm build` from the monorepo root.
- **`gh` CLI prompts for auth** — `gh auth login` once. `poll-outcomes`
  and `deployment-status` platform both require it.
