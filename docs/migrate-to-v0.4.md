# Migrating from v0.3 to v0.4

Conclave AI v0.4 replaces the distributed "copy 4 YAMLs per repo" pattern from v0.3 with a central control plane + a 3-line wrapper workflow. One-time install per repo, one central bot for notifications, a shared federated memory pool. See [`docs/architecture-v0.4.md`](./architecture-v0.4.md) for the decision record.

**v0.4 is breaking.** We picked that path (D9) because no production tenants exist yet — pushing a `conclave migrate` CLI wasn't worth the ongoing maintenance. Follow the steps below and your repo is on v0.4 in under 5 minutes.

---

## Before you start

You need:
- `gh` CLI installed and authenticated (`gh auth status` should show your account).
- Node 20+ and pnpm installed.
- Access to the repo you're migrating (push rights).

---

## Step 1 — Remove v0.3 workflow files

In v0.3, installs scattered these files in `.github/workflows/`:

- `conclave-review.yml`
- `conclave-rework.yml`
- `conclave-merge.yml`
- `conclave-reject.yml`
- `conclave-telegram-bot.yml`

Delete all of them:

```powershell
cd /path/to/your/repo
Remove-Item .github/workflows/conclave-*.yml
git add .github/workflows/
git commit -m "chore: remove v0.3 conclave workflows (migrating to v0.4)"
```

## Step 2 — Remove v0.3 repo secrets that v0.4 replaces

v0.4 needs exactly one conclave-owned secret on your repo: `CONCLAVE_TOKEN`. The others are either user-owned LLM keys (keep them) or v0.3 leftovers (drop them).

**Drop if present:**
- `ORCHESTRATOR_PAT` — v0.4's central bot fires dispatches server-side using the GitHub token captured during OAuth
- `TELEGRAM_BOT_TOKEN` — **fully unused from v0.4.4 onward.** v0.4.4 routes all Telegram notifications through the central `@Conclave_ai_bot` using your `CONCLAVE_TOKEN`. Earlier v0.4.0–v0.4.3 still consulted this secret for the notifier; from v0.4.4 the reusable workflow no longer sets it, and the CLI notifier prefers the central path when `CONCLAVE_TOKEN` is present. Safe to delete.
- `TELEGRAM_CHAT_ID` — same reason.

```powershell
gh secret delete ORCHESTRATOR_PAT   --repo owner/repo
gh secret delete TELEGRAM_BOT_TOKEN --repo owner/repo
gh secret delete TELEGRAM_CHAT_ID   --repo owner/repo
```

> **Self-hosted Conclave?** If you run a private central plane, the CLI notifier still honours `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` when `CONCLAVE_TOKEN` is absent. See `packages/integration-telegram` for the dual-path implementation; the reusable workflow above assumes the public central plane.

**Keep:**
- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` — still user-owned in v0.4 (D6). `conclave init` will remind you to set these if they're missing.

## Step 3 — Remove the v0.3 local memory store

v0.4 pushes memory to the federated central pool. Your repo's `.conclave/` directory is no longer consulted at review time.

```powershell
Remove-Item -Recurse -Force .conclave
git add .conclave 2>$null
git commit -m "chore: drop local .conclave/ — v0.4 uses federated memory pool"
```

If you care about preserving any answer-keys or failure-catalog entries you hand-edited, back them up first and re-enter them via the flow once v0.4 is running (or wait for a bulk-import utility in v0.5).

## Step 4 — Run `conclave init`

From the repo root:

```powershell
npm install -g @conclave-ai/cli
conclave init
```

The wizard will:
1. Detect your repo from `git remote`.
2. Write `.conclaverc.json` with v0.4 defaults (2-tier council, `sharing.mode: hashes` per D4, $2/PR budget).
3. Write `.github/workflows/conclave.yml` — a 3-line wrapper that calls `conclave-ai/conclave-ai/.github/workflows/review.yml@v0.4`.
4. Run GitHub OAuth device flow — open a URL, enter a code, authorize. On success, `CONCLAVE_TOKEN` is installed as a repo secret via `gh secret set`.
5. Print the exact `/link <CONCLAVE_TOKEN>` command for the central Telegram bot.
6. Remind you which LLM API keys still need `gh secret set`.

## Step 5 — Link your Telegram chat

Open Telegram, DM `@Conclave_ai_bot`, send:

```
/link <the token printed at the end of step 4>
```

Bot replies "✅ Linked this chat to owner/repo". From now on review notifications go here, and 🔧 / ✅ / ❌ button clicks dispatch real actions.

## Step 6 — Commit + open a test PR

```powershell
git add .conclaverc.json .github/workflows/conclave.yml
git commit -m "chore: migrate to conclave-ai v0.4"
git push
```

Open any PR against the default branch. Within ~2 minutes:
- GitHub Actions runs the reusable v0.4 review workflow.
- Council comments on the PR with a verdict.
- Telegram posts the same verdict with action buttons.

---

## What changed for you behind the scenes

| Surface | v0.3 | v0.4 |
|---------|------|------|
| Install steps | ~28 (4 YAMLs + 5 secrets + bot registration + tokens) | 4 prompts via `conclave init` |
| Telegram bot | Per-repo, user creates via BotFather | One central `@Conclave_ai_bot` |
| Memory | Each repo's own `.conclave/` JSON | Federated pool on the central plane (hashes only by default; full content opt-in per D4) |
| Workflow files | Copy 4 to each repo | One 3-line wrapper |
| Repo secrets owned by conclave | ORCHESTRATOR_PAT + TELEGRAM_* | `CONCLAVE_TOKEN` |
| Cost to run the bot | You host | Runs on conclave.ai's central Cloudflare Worker (free tier) |

---

## Rollback

If v0.4 doesn't work for you and you need to revert:

```powershell
gh secret delete CONCLAVE_TOKEN --repo owner/repo
Remove-Item .github/workflows/conclave.yml
Remove-Item .conclaverc.json
# Then: checkout the v0.3 install from a prior commit, or re-copy the 4 YAMLs
# from https://github.com/seunghunbae-3svs/conclave-ai/tree/v0.3.3/examples/github-workflows
```

The v0.3 workflow templates are frozen at tag `v0.3.3` and will remain installable indefinitely — we just stop shipping updates to that branch.

---

## Troubleshooting

**"conclave: could not read git remote"** — run `conclave init --repo owner/name` to override.

**OAuth returns denied** — the user authorising must have push access to the repo. If you're on a client repo, ask the owner to run `conclave init` instead.

**`gh secret set` fails** — either `gh` isn't installed or isn't authenticated for this repo. Install, run `gh auth login`, then re-run `conclave init --reconfigure`.

**Telegram bot doesn't reply to `/link`** — the bot is at `@Conclave_ai_bot`. Double-check the handle; if your DM gets no reply within 10 seconds, the central plane's webhook might be down — ping the conclave-ai repo issues.

**Review doesn't fire on PR** — confirm `.github/workflows/conclave.yml` exists on the PR's base branch (not just the PR itself). Reusable workflows only dispatch when the call-side workflow is on the default branch.
