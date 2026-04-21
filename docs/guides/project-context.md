# Project + design context

Conclave reviews a diff well. It reviews a diff + **intent** better.

Starting in v0.6.4 the CLI auto-injects a small, bounded slice of your
repo's own docs into every review and audit call. Agents see "what this
repo is FOR" before they see the hunks, so they can judge the diff
against product intent instead of a generic code-review rubric.

No config required. Drop the files below and every review picks them
up on the next run.

## The four sources

Listed in the order the CLI reads them:

| Source | Purpose | Who sees it |
|---|---|---|
| `README.md` (head, 500 chars) | What the repo is | every agent |
| `.conclave/project-context.md` (full) | Product intent, conventions | every agent |
| `.conclave/design-context.md` (full) | Brand, tone, a11y target, persona | DesignAgent only |
| `.conclave/design-reference/*.png` (≤ 4, ≤ 500KB) | Visual "brand good" examples | DesignAgent only (Mode A / vision) |

Sources are loaded only from these four paths. No globbing, no remote
fetch, no arbitrary file scan.

When a source is missing, Conclave silently skips it — absence is the
normal case for most repos.

## When to write a `project-context.md`

Write one when your repo has conventions a reviewer can only catch by
reading prose, not code. Typical wins:

- **Reusable workflows.** "We pass `cli-version: latest` on purpose — it
  references our own reusable workflow, not a random action." This is
  the failure mode the feature shipped to fix (eventbadge PR #20).
- **Intentional patterns.** "Our API routes use `~/routes/` imports via
  a Remix-style alias — they are not broken paths."
- **Product-specific tolerances.** "This is a prototype — test coverage
  is not a blocker."
- **Non-obvious tech choices.** "We use Bun for local dev, Node for
  production builds — don't flag `bunfig.toml`."

### Example `.conclave/project-context.md`

```markdown
# eventbadge

**What it is:** Printable badge generator for small conferences (~300
attendees). Next.js frontend, Supabase backend, deployed on Vercel.

**Intentional patterns:**

- `.github/workflows/review.yml` calls our OWN reusable workflow at
  `seunghunbae-3svs/conclave-ai/.github/workflows/review.yml@v0.4`.
  The `cli-version: latest` input is a reusable-workflow parameter,
  NOT a GitHub Actions `uses: foo@latest` pin. Do not flag it.
- All user-facing strings go through `t()` for i18n. Hardcoded strings
  in non-UI files (API routes, error messages) are fine.
- Supabase service-role key is only loaded on server components; never
  flag its presence in `app/api/**`.

**What NOT to block on:**

- Missing CHANGELOG entries on dependency bumps.
- Snapshot-test churn on unrelated components when a shared primitive
  changes.

**Who this is for:** small-conference organizers, not developers. UI
copy must avoid jargon.
```

## When to write a `design-context.md`

Write one when the DesignAgent needs to know what "on-brand" means
before it can judge whether a UI change is a regression or an
intentional refresh.

### Example `.conclave/design-context.md`

```markdown
# Brand + UX target

**Brand:** Calm, print-forward, utilitarian. Think "Herman Miller
catalog", not "SaaS landing page". No gradients, no animation beyond
100ms transitions, no illustrated characters.

**Typography:** Inter (UI), IBM Plex Mono (badge numbers). Headings
are never ALL CAPS. Body text 15px min.

**Color:** Two brand colors (navy `#0B2545`, sand `#EFE8D8`) +
semantic tokens (success/warn/error/info). Flag hardcoded hex outside
that set.

**A11y target:** WCAG AA. Focus ring must be visible on every
interactive element. Do not rely on color alone for state.

**Persona:** A high-school teacher running registration on a borrowed
laptop. She is NOT a developer. UI copy avoids jargon; errors explain
what to do next, not what broke internally.

**Recent deliberate direction:** We moved from a bottom-nav to a
top-nav in Feb 2026. If a PR re-introduces a bottom-nav, that's a
regression, not a new idea.
```

## Design reference images

DesignAgent's Mode A (vision) call can see brand reference images
alongside the PR's before/after pair. Use this when words can't
substitute for the visual target — e.g., a specific grid density, a
particular photo treatment, a signature layout.

```
.conclave/design-reference/
├── 01-homepage-target.png   (≤ 500KB)
├── 02-badge-layout.png
├── 03-empty-state.png
└── 04-dashboard-density.png
```

Rules:

- **PNG only.** Other formats are skipped.
- **≤ 500KB each.** Oversize files are dropped silently.
- **≤ 4 images (default).** Configurable via `context.maxDesignReferences`.
- **Filename prefix controls order.** `01-*` sorts first. The model
  sees them in name order.
- **Not for before/after.** The PR's own before/after pair still
  comes from the visual-review pipeline — reference images are the
  "target", not the comparison baseline.

## Config knobs

Everything is optional. Defaults preserve pre-v0.6.4 behavior (nothing
gets injected if you don't drop files).

```json
{
  "version": 1,
  "context": {
    "readmeMaxChars": 500,
    "maxDesignReferences": 4,
    "maxDesignImageBytes": 512000,
    "includeDesignReferences": true
  }
}
```

- `readmeMaxChars` — head-slice length for `README.md`. Lower this if
  your README is huge; raise it if your intent only shows up past the
  badge row.
- `maxDesignReferences` — cap on reference images. Set to `0` to load
  the text design context but skip images entirely.
- `maxDesignImageBytes` — per-image size cap. Images over this are
  dropped silently.
- `includeDesignReferences` — master switch for the reference-image
  path. `false` disables it even when images exist on disk.

## What changed in the review prompt

Each agent's user-prompt now looks roughly like:

```
# Review target
repo: owner/repo
pull: #42
sha: abc

# Project context                   ← NEW in v0.6.4
## README (head)
<first 500 chars>

## .conclave/project-context.md
<full content>

# Design intent                     ← NEW, DesignAgent only
<full .conclave/design-context.md>

# Deploy status
deploy: success

# Diff
```diff
...
```
```

When no sources are present, the `# Project context` / `# Design intent`
sections are omitted entirely — existing prompts are unchanged.

## Debugging

Run with `conclave review --help` to confirm the CLI is v0.6.4+.

To verify your context was picked up, run with `--verbose` (coming in a
follow-up) or inspect the exported `.conclave/review-logs/*.json`
trace file — look for `projectContext`, `designContext`, and
`designReferences` keys on the persisted `ReviewContext`.
