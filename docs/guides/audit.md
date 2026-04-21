# `conclave audit` — full-project health check

`conclave audit` is the first command you should run after `conclave init`.
Unlike `conclave review`, which grades a PR diff, `audit` walks the
current state of the repo and returns a prioritized list of real issues
a human should fix this week — no PR required.

## When to use it

- Right after `conclave init`, to get an immediate value signal from
  the existing codebase.
- Weekly or monthly on your main branch to catch drift.
- Before a major version bump, as a pre-release pass.
- After migrating a codebase from another reviewer tool, to baseline
  what the council thinks of the current state.

Do NOT use it as a substitute for `conclave review` on PRs. The two
commands complement each other: `review` is per-change; `audit` is
point-in-time health.

## Quickstart

```bash
conclave audit
```

Defaults: scope=all, budget=$2, max-files=40, domain=auto, output=issue.
The command opens a GitHub issue titled `Conclave Project Audit —
YYYY-MM-DD` with the structured findings.

## Common flags

```bash
# preview which files would be audited — no LLM calls, no spend
conclave audit --dry-run

# only audit UI code, print to terminal
conclave audit --scope ui --output stdout

# larger budget for a deep-scan on a bigger repo
conclave audit --budget 5 --max-files 80

# design-only pass (DesignAgent alone)
conclave audit --domain design --scope ui

# cheap, fast — single round, no tier-2 debate
conclave audit --tier-1-only --budget 1
```

## Output shape (GitHub issue)

```
## Conclave Project Audit — 2026-04-20

**Repo:** acme/my-app
**SHA:** aabbccddeeff
**Scope:** all (domain: mixed)
**Coverage:** 40 audited / 120 in scope  _(sampled)_
**Batches:** 5/5

### Summary
| Severity | Count |
|---|---|
| Blocker | 3 |
| Major | 7 |
| Minor | 12 |
| Nit | 4 |

### Top blockers (by severity)
- **BLOCKER** `a11y` — `src/Hero.tsx:12`
  img missing alt attribute on a content image
- **BLOCKER** `security` — `src/api/users.ts:47`
  SQL interpolation of unsanitized user input
...

### Grouped by category
<details><summary><code>a11y</code> — 5 findings</summary>
...

### Grouped by subsystem
<details><summary><code>ui</code> — 12 findings</summary>
...

### Per-agent verdicts
| Agent | Approve | Rework | Reject |
|---|---|---|---|
| claude | 2 | 3 | 0 |
| openai | 1 | 4 | 0 |

### Cost + latency
- **Spend:** $1.8200 of $2.00 budget
- **Calls:** 15
- **Latency:** 42000ms
```

## Cost examples

| Repo size | Scope | Budget | Est. spend |
|---|---|---|---|
| ~40 files | all | $2 | $0.30 – $0.80 |
| ~100 files | all (sampled to 40) | $2 | $0.60 – $1.50 |
| ~500 files | code, --tier-1-only | $1 | $0.40 – $0.90 |
| ~500 files | all | $5 | $2 – $4 |

Prompt caching + Anthropic's sliding context usually keep cost well
below the budget ceiling. **Hard ceiling is $10** regardless of
`--budget` value — even if you pass `--budget 50`, the CLI clamps to
$10 and warns. Real users will forget.

## What gets excluded automatically

- `node_modules`, `dist`, `build`, `.next`, `out`, `.turbo`, `.cache`
- lockfiles (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`)
- source maps and minified bundles (`*.map`, `*.min.js`)
- binaries (images, fonts, audio, video, executables)
- test files (unless you pass `--scope test` — not supported in v0.6)
- everything in `.gitignore`
- everything in `.conclaveignore` (optional, same format as gitignore)

Add a `.conclaveignore` at the repo root to override on a per-project
basis.

## Scope categories

- **ui** — `.tsx / .jsx / .vue / .svelte / .astro / .css / .scss /
  .html`, `tailwind.config.*`, `theme.*`, anything under
  `tokens/` / `design-system/`.
- **code** — `.ts / .js / .py / .go / .rs / .rb / .java / .kt /
  .swift / .php / .c / .cpp / .cs` and friends.
- **infra** — `Dockerfile`, `docker-compose.*`, `*.yml`, `wrangler.toml`,
  `vercel.json`, `netlify.toml`, anything under `.github/workflows/`,
  `terraform/`, `*.tf`, `Makefile`.
- **docs** — `*.md`, `*.mdx`, `*.rst`, `*.txt`.

Test files are always excluded from audit (tests that fail aren't a
"codebase health" signal; failing CI is).

## Budget enforcement

Budget is enforced MANDATORILY. Before each batch, the command checks
remaining budget; if the next call can't be afforded under the cap, the
audit stops and returns a PARTIAL result labeled `budget exhausted
after N/M batches`. The GitHub issue body and stdout both call this
out clearly — no silent truncation.

## Config

Add an `audit` section to `.conclaverc.json` to set project defaults:

```json
{
  "version": 1,
  "audit": {
    "defaultBudgetUsd": 2,
    "defaultMaxFiles": 40,
    "defaultScope": "all"
  }
}
```

CLI flags always win over config.

## Exit codes

- `0` — no findings, or only minor / nit findings.
- `1` — at least one `major` finding (codebase has notable issues).
- `2` — at least one `blocker` finding (fix immediately).

Useful for wiring audit into CI as a periodic health check.
