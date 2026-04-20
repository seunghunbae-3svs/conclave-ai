# Conclave AI v0.4 — Central Control Plane

**Status:** LOCKED (2026-04-20) — all 12 decisions below are resolved. Implementation starts with `conclave init` wizard; milestone schedule in §5 governs.
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

## 4. Twelve decisions — LOCKED 2026-04-20

| ID | Decision | Choice (LOCKED) |
|----|----------|-----------------|
| D1 | Distribution | **A: Reusable workflow + CLI** for v0.4. **B (GitHub App + LLM proxy) planned for v1.0** as the paid SaaS tier. |
| D2 | Central host | **Cloudflare Workers + D1 (SQLite).** |
| D3 | Auth | **GitHub OAuth + CONCLAVE_TOKEN.** |
| D4 | Data sharing | **Hashes default, full-content opt-in.** This is the **core enterprise-sales differentiator** — emphasised in landing copy, docs, and SaaS transition messaging. Decision #21's federated-baseline skeleton ships verbatim. |
| D5 | Telegram | **Central `@conclave_ai` bot, users DM `/link <token>`.** Per-user bots removed from docs. Cost breakdown: §4b below. |
| D6 | LLM keys | **User-owned for v0.4.** SaaS transition (v1.0) switches paid-tier users to Conclave-proxied. Free tier keeps user-owned. |
| D7 | Wrapper workflow | 3 lines + `secrets: inherit`. Named-secrets alternative documented. |
| D8 | `conclave init` | 8-step interactive wizard + `--yes` for CI/IaC. `--reconfigure` to re-run on existing installs. |
| D9 | v0.3 migration | **Breaking + 1-page migration doc.** Until public release, keep the cheapest path — no automatic migrate CLI. |
| D10 | Deploy-status in ReviewContext | **a + b ship in v0.4:** add `deployStatus` field + agent prompts treat "deploy failed" as auto-non-approve. **c (central polling of Vercel/Netlify webhooks) deferred to v0.5.** |
| D11 | Cost / quota | **v0.4: local `perPrUsd` only.** Central plane keeps a lightweight usage counter (increment only, no rate-limit). v0.5 transition triggers: §4c below. |
| D12 | v0.5 deferrals | Dashboard UI · LLM proxy (paid tier per D6) · self-hosted enterprise · i18n (per `feedback_conclave_ux_i18n.md`) · nightly memory classification scheduler · central deploy-status polling (D10c) · `conclave migrate` CLI (D9). |

---

### 4b. D5 follow-up — central Telegram bot cost

Bae asked: if Conclave runs a single `@conclave_ai` bot for all users, does that create recurring cost on my side?

**Short answer: $0/month at any realistic v0.4 volume.** Breakdown:

| Component | Free tier | v0.4 projected | Headroom |
|-----------|-----------|----------------|----------|
| Telegram Bot API itself | Unlimited, free forever | — | n/a |
| Cloudflare Workers (bot runner) | 100,000 requests/day | long-poll every 5 min = 288 req/day | 346× |
| Cloudflare Workers (sendMessage on notifications) | Same 100K/day | ~5 sends per PR × thousands of PRs = still well under | 10× |
| D1 SQLite (chat_id ↔ repo_id mapping) | 5 GB, 25M row reads/day | kilobytes, thousands of reads/day | millions× |
| Telegram outbound rate limits | 30 msg/sec global, 1 msg/sec per chat | far below | n/a |

Conclave stops being free only when it crosses **~80K Telegram events/day**, which at current projections = tens of thousands of concurrent active users. At that point the revenue-side (SaaS tier per D6) is already live.

**One caveat:** if a user opts in to verbatim content sharing (D4), their notification bodies get larger. Still fits in CF Workers' 10ms CPU / 128MB budget per request. No impact.

---

### 4c. D11 follow-up — v0.5 transition triggers

Bae asked for a concrete signal that says "it's time to build billing/quota."

**Trigger — when any 3 of these hit, start the v0.5 spec PR:**

1. **20+ distinct repos registered** via `conclave init`
2. **Average monthly LLM spend per user > $10** (pulled from the `metrics.totalCostUsd` reported back to the central plane)
3. **2+ inbound enterprise-sized requests** (via dashboard contact form, GitHub issues, or direct email — "can we get a managed-billing option?")
4. **Any single user reports their Anthropic bill surprise** (explicit signal that self-managed quota isn't enough)
5. **Central CF Worker hits 80% of free-tier daily limit** for any rolling 7-day average

I'll add a lightweight metrics dashboard (just a terminal command, `conclave metrics`, that reads the counter) so Bae can eyeball these numbers without infrastructure work. Alert email when threshold crossed is a v0.5 feature.

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
