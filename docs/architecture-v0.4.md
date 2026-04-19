# Conclave AI v0.4 — Central Control Plane

**Status:** DRAFT — awaiting Bae's decisions on the checkboxes below.
**Supersedes for distribution only:** `ARCHITECTURE.md` (v2.0) stays the source of truth for pipeline / council / efficiency-gate / memory substrate. This doc only redefines how users *install and operate* conclave.
**Tracks:** dogfood feedback from 2026-04-20 eventbadge session (see `memory/project_conclave_known_bugs.md` for the six failure modes that drove this rewrite).

---

## 1. Why v0.4 — the distribution problem

v0.3 ships a CLI (`@conclave-ai/cli`) that each repo installs individually and drives via GitHub Actions. Adoption requires:

- Copying 4–5 workflow YAMLs into `.github/workflows/`
- Provisioning 5+ secrets (ANTHROPIC / OPENAI / GEMINI / TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID / ORCHESTRATOR_PAT)
- Running `pnpm publish` correctly (not `npm`) — see ERR-017
- Knowing to persist `.conclave/episodic/` back to the default branch
- Creating a Telegram bot from scratch per repo

**Observed during dogfood:** this took ~8 PRs and ~4 hours, produced 6 distinct failure modes, and still left each repo's memory isolated from every other repo's. No knowledge crosses repo boundaries. That's the opposite of the self-evolve moat.

v0.4's purpose: **collapse the install path to a single CLI command, and move memory aggregation / integrations / trust surface into a central control plane so every install contributes to and benefits from a shared pool.**

---

## 2. Target user journey

```
  one time, roughly 2 minutes:

  $ npm install -g @conclave-ai/cli
  $ conclave init
    - detects git remote (e.g. acme/service)
    - opens browser, GitHub OAuth, conclave.ai registers the repo
    - prompts for ANTHROPIC_API_KEY plus optional OPENAI / GEMINI
    - prompts for Telegram chat link (one-tap via central @conclave_ai
      bot; user DMs /link <token>)
    - writes ONE wrapper file: .github/workflows/conclave.yml
      (3 lines — just `uses: conclave-ai/conclave-ai/.github/workflows/
       review.yml@v0.4` plus secrets passthrough)
    - done.

  then, forever:
    PR opens -> council reviews -> worker patches -> notifications routed
    through central @conclave_ai bot -> every outcome silently contributes
    to the federated answer-key / failure-catalog pool that THIS AND
    EVERY OTHER CONCLAVE INSTALL retrieves at review time.
```

v0.3 had roughly 28 install steps; v0.4 has 4 prompts.

---

## 3. Architecture — two layers

```
+----------------------------------------------------------------+
|  User repo (acme/service)                                      |
|  ----------------------------------------------------------    |
|  - .conclaverc.json              (config)                      |
|  - .github/workflows/conclave.yml  — 3 lines, calls reusable   |
|  - Secrets: ANTHROPIC / OPENAI / GEMINI / CONCLAVE_TOKEN       |
|    (the last one is THE ONLY conclave-owned secret, minted by  |
|     `conclave init` via OAuth, rotatable from the dashboard)   |
+----------------+-----------------------------------------------+
                 |  repository_dispatch + HTTPS API
                 v
+----------------------------------------------------------------+
|  Central Control Plane — conclave.ai                           |
|  ----------------------------------------------------------    |
|  - Reusable workflow host (`.github/workflows/review.yml`)     |
|  - Registry of installed repos                                 |
|  - Federated memory aggregator (episodic -> answer-key /       |
|    failure-catalog pool; cross-repo retrieval at review time)  |
|  - @conclave_ai Telegram bot (one bot, per-user channels)      |
|  - Dashboard (web UI — secrets, usage, scores, opt-outs)       |
|  - Deploy-status hook (reads Vercel / Netlify / Cloudflare and |
|    feeds it into ReviewContext — closes the gap Bae flagged)   |
+----------------------------------------------------------------+
```

The council and worker agents **still run on the user's Actions runner**, using the user's API keys. The central plane handles everything around them — distribution, memory, integrations, trust.

---

## 4. The twelve open decisions

Each is a branch point. Many lock downstream code shape, so they need Bae's call before implementation starts.

### D1. Distribution model
- [ ] **A. Reusable workflow + CLI** — user repo has one 3-line workflow that calls `conclave-ai/conclave-ai/.github/workflows/review.yml@v0.4`. CLI + Actions only. Zero hosted infra.
- [ ] **B. GitHub App + hosted runner** — user installs an App; conclave runs everything on its own infra. Zero YAMLs in user repo. Needs real hosting + billing.
- [ ] **C. Hybrid** — A for now, B layered on top once we have paid tier.
- **Recommended: A for v0.4, path to C for v1.0.** A ships in 2–3 weeks; B needs a month of infra work + ongoing ops.

### D2. Where does the central service live?
- [ ] **Cloudflare Workers** (free tier generous, fast cold start, good for webhooks)
- [ ] **Vercel** (ergonomic, $20/mo, same stack as most users)
- [ ] **Railway / Fly** (more control, Postgres easy)
- [ ] **GitHub Pages + GitHub Actions only** (free, but no real server; rules out webhook)
- **Recommended: Cloudflare Workers + D1 (SQLite).** Zero ops until >100k reviews/mo.

### D3. Auth model
- [ ] **GitHub OAuth + CONCLAVE_TOKEN** — `conclave init` opens browser, user authorises conclave.ai GitHub App, we mint a scoped token stored as a repo secret. One token per repo.
- [ ] **Personal API key from dashboard** — user signs in, creates a token, pastes it into `conclave init`.
- **Recommended: OAuth.** Zero-friction install; revocable from GitHub settings; standard pattern.

### D4. What data crosses the central plane?
- [ ] **Episodic entries pushed verbatim** — simplest, but leaks diff content + blocker text across orgs.
- [ ] **Pattern hashes only** (already the decision #21 baseline) — k-anonymous, safe, but loses rich context.
- [ ] **Hashes by default, full content opt-in** per repo.
- **Recommended: hashes by default, full-content opt-in.** A single repo opting in contributes labelled data; everyone else gets aggregated frequencies.

### D5. Telegram centralization
- [ ] **A. Keep per-user bots** (current) — simple, zero central infra, but every user creates a bot.
- [ ] **B. Central `@conclave_ai` bot, users DM `/link <token>`** — one global bot, per-user channels.
- [ ] **C. Both — central is default, per-user is an override.**
- **Recommended: B.** Kills the bot-creation step entirely. Infra cost: one Cloudflare Worker running getUpdates long-poll.

### D6. How do users provide LLM API keys?
- [ ] **A. User-owned (current)** — they pay Anthropic/OpenAI directly. Conclave never sees the key.
- [ ] **B. Conclave-proxied** — we proxy the LLM call, aggregate billing, charge subscription.
- [ ] **C. A now, B as future paid tier.**
- **Recommended: A for v0.4.** B is a billing/legal lift worth its own quarter.

### D7. Reusable workflow shape
v0.4's user wrapper file should be about 3 lines. Everything else lives in the reusable workflow we publish:
```yaml
# Proposed user wrapper (.github/workflows/conclave.yml):
on: { pull_request: { types: [opened, synchronize, reopened] } }
jobs:
  conclave:
    uses: conclave-ai/conclave-ai/.github/workflows/review.yml@v0.4
    secrets: inherit
```
- [ ] Confirm this is the target shape
- [ ] Confirm `secrets: inherit` is acceptable (alternative: named `secrets:` block)

### D8. `conclave init` wizard — what does it actually do?
Proposed steps, in order:
1. Detect `git remote get-url origin` -> infer repo
2. Detect existing `.conclaverc.json` -> skip / upgrade / replace prompt
3. Open browser -> OAuth -> mint CONCLAVE_TOKEN -> GitHub API write as repo secret
4. Prompt for ANTHROPIC_API_KEY (required); OPENAI / GEMINI (optional, gate agent selection)
5. Prompt for Telegram link step (`/link <token>` generated locally, user taps)
6. Write `.conclaverc.json` with sensible defaults (tier1: claude+openai+gemini, budget: $2/PR)
7. Write `.github/workflows/conclave.yml` (3 lines)
8. Print "Open a PR to test"
- [ ] Confirm this is the sequence
- [ ] Any step you want gated by explicit `--yes` vs interactive?

### D9. Migration from v0.3
- [ ] **A. `conclave migrate`** — existing distributed installs run this; it detects .conclave/ + old workflows and offers to consolidate.
- [ ] **B. Breaking change** — v0.3 installs continue working on their own until they re-init.
- [ ] **C. Dual-mode forever** — users pick per-repo.
- **Recommended: B + doc'd migration path.** Most real installs are eventbadge-style hand-rolled; forcing migration will hurt no one because there ARE no production installs yet.

### D10. Deploy-status integration (Bae's explicit ask)
Council should read Vercel / Netlify / Cloudflare deploy status as context. Currently the `@conclave-ai/platform-*` packages exist but aren't wired into `ReviewContext`.
- [ ] Add `deployStatus` field to `ReviewContext`
- [ ] Central plane polls deploys on dispatch; passes result into the workflow env
- [ ] Agent prompts updated to treat "deploy failed" as an automatic non-approve signal

### D11. Cost / quota
In v0.3, the user's `perPrUsd` budget is local-only. In v0.4:
- [ ] Central plane tracks cumulative spend per repo
- [ ] Rate-limits dispatches if the user's API account hits a threshold (based on LLM provider billing webhooks — complex)
- [ ] Or: leave it local, only track free-tier requests against central infra

### D12. What slides to v0.5
Things tempting to pile in but explicitly OUT of v0.4 scope:
- Dashboard web UI (table stakes eventually; not in v0.4 — CLI is enough)
- Paid subscription tier
- Self-hosted control plane (enterprise)
- Multi-language / i18n (per the `feedback_conclave_ux_i18n.md` memory — v0.5 work)
- Scheduler for nightly memory classification (decision #25, still pending)

---

## 5. Implementation milestones (assuming D1=A, D2=Cloudflare Workers, D3=OAuth)

| Week | Milestone |
|------|-----------|
| 1 | Central service skeleton (CF Worker + D1). `/register`, `/episodic/push`, `/memory/pull`. OAuth flow end-to-end. |
| 1 | `conclave init` wizard (CLI side). Writes wrapper workflow + .conclaverc. |
| 2 | Reusable workflow published on `conclave-ai/.github/workflows/review.yml`. Tag v0.4.0-rc.1. |
| 2 | Central `@conclave_ai` Telegram bot (long-poll CF Worker). `/link` + callback handler replaces per-repo bot. |
| 3 | Federated memory flow — episodic push -> aggregated answer-key pool -> retrieval on review start. |
| 3 | Deploy-status integration wired into ReviewContext. |
| 4 | v0.4.0 stable. Migration doc for v0.3 users. Deprecate per-repo YAML pattern from docs. |

4 weeks to ship v0.4.0 if decisions D1–D12 resolve quickly. 6 weeks if D5/D10 surface surprises.

---

## 6. Out of this PR

This is the design doc. **No code changes.** Once Bae signs off on D1–D12, each milestone becomes its own implementation PR. This doc becomes a living reference — update it as decisions lock in.

Follow-ups tracked but not in scope:
- Deprecating the `examples/github-workflows/` copy-paste pattern in favour of the reusable workflow
- Removing the dogfood-era assumption of per-repo Telegram bot tokens
- Seeding the central answer-key pool with the first wave of real merges (bootstrap)
