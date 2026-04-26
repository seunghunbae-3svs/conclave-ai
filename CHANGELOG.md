# Changelog

## v0.13.12 — 2026-04-27

### Fixed
- **Apply-step fuzz fallback diagnostics (cli@0.13.12).** When BOTH
  `git apply --recount` AND `patch -p1 --fuzz=3` reject a worker
  patch (the autofix.ts post-loop apply step), the conflict report
  now includes:
  - the patch(1) failure reason (stderr/stdout, capped at 800c) —
    pre-fix this was silently swallowed
  - the recounted patch (the post-fixup version that was actually
    fed to git/patch), if it differed from the worker's raw output
  - on a successful fuzz fallback, patch(1)'s "Hunk #N succeeded at
    NN with fuzz Z" line is surfaced so operators can see the actual
    offset patch had to apply

  Live RC source: eventbadge#29 cycle 3 with cli@0.13.10 — the
  per-blocker validate's fuzz fallback succeeded (autofix-worker.ts
  uses `--dry-run`) but the apply step's fuzz fallback rejected
  silently, leaving operators with only the original `git apply`
  error. The new diagnostics expose what patch(1) actually said.

  Pure additive: no behaviour change for successful applies. Adds
  ≤800 chars to the conflict reason on dual failure.

### Tooling (no cli version impact)
- **Release: per-package bumping (release commit v0.11.12).**
  `release.yml` no longer advances every internal package's version
  on every release. The new `scripts/release/bump-changed-packages.mjs`
  walks `packages/*`, runs `git diff --name-only $PREV_TAG..HEAD --
  packages/<pkg>` for each, and only bumps packages with at least one
  changed file. The driver package (`core`) always bumps so the
  `vX.Y.Z` tag advances every release — preserves the existing
  tag-and-publish flow.

  Live-verified on this release: only `packages/cli` and
  `packages/core` bumped (2 files changed in the release commit
  vs. 24 in the prior lockstep release).

  16 hermetic unit tests cover `nextVersion`, `packageChangedFromList`,
  and the `planBumps` orchestrator. Pure functions — no git, no fs.

## v0.13.11 — 2026-04-27

### Added
- **`conclave doctor` Telegram webhook check (v0.13.11).** Adds a 5th
  diagnostic line that verifies the Telegram bot's registered webhook
  URL matches what the central-plane Worker expects. The doctor never
  sees the bot token: it hits a new `GET /admin/webhook-status`
  endpoint on the Worker (Bearer-`CONCLAVE_TOKEN` auth, same gate as
  every other authed route) which calls `getWebhookInfo` server-side
  and returns `{ url, expected, matches, outcome, ... }`.

  Outcome → severity:
  - `bound` (matches=true) → OK
  - `dropped` (Telegram cleared the webhook) → FAIL with hint to wait
    for the self-heal cron or re-bind manually
  - `wrong-url` (some other consumer is calling getUpdates and
    stealing the webhook) → FAIL with "find + stop the offender" hint
  - `no-bot-token` / `telegram-unreachable` / 401 / 404 → WARN (the
    worker isn't in a state where it can answer; doctor's job is
    diagnostic, not infrastructure surgery)

  Total checks now: env (4) + central-plane /healthz (1) + workflow
  pins (1) + npm version (1) + telegram webhook (1) = 8 lines.

  **Tests:** 7 cases in `apps/central-plane/test/admin.test.mjs`
  (auth gate + each outcome shape) + 8 cases in
  `packages/cli/test/doctor.test.mjs` (each severity branch + token
  not-leaked-in-URL). 466/466 cli, 142/142 central-plane tests pass.

## v0.13.10 — 2026-04-27

### Fixed
- **Programmatic patch fixup: `recountHunkHeaders` (v0.13.10).** Live
  cycle-2 attempt on eventbadge#29 sha `279cb22` with cli@0.13.9
  exposed the next failure mode: the worker emitted
  `@@ -14,7 +14,6 @@` but the body contained only 5 source lines and
  4 result lines. `git apply --recount` only recomputes counts when
  the body is structurally complete; a *truncated* hunk (B=7 with 5
  source lines) trips the parser with "corrupt patch at line 10"
  before --recount can do its job. The v0.13.8 `patch -p1 --fuzz=3`
  fallback also rejected the malformed input.

  New helper `recountHunkHeaders(patch)` walks every hunk body, counts
  the actual source (` ` + `-`) and result (` ` + `+`) lines, and
  rewrites the `@@ -A,B +C,D @@` header so B and D match the body
  exactly. Idempotent on already-correct patches. Runs before the
  first `git apply --check --recount` in BOTH apply paths:
  - `runPerBlocker` (per-blocker validate, autofix-worker.ts)
  - the post-loop apply step (autofix.ts)
  Start line A is NOT modified — the existing fuzz fallback handles
  modest A offsets.

  **Tests:** 9 cases in `patch-fixup.test.mjs` cover the eventbadge#29
  shape, idempotence, single-add / single-delete edges, multi-hunk
  multi-file walks, `@@` context-suffix preservation, the "no newline
  at end of file" marker, and degenerate input.

## v0.13.9 — 2026-04-27

### Fixed
- **Worker prompt: require 2-3 lines of leading + trailing context per
  hunk (v0.13.9).** Live re-attempt of eventbadge#29 sha `279cb22` with
  cli@0.13.8 surfaced the next layer: the v0.13.8 GNU `patch -p1
  --fuzz=3` fallback ALSO rejected, because the worker emitted a hunk
  with only one line of leading context (`export function ...` followed
  immediately by the deletions). With one line of context, neither
  `git apply --recount` nor `patch -p1 --fuzz=3` can disambiguate the
  anchor on stricter installations.

  `WORKER_SYSTEM_PROMPT` now spells this out:
  - the @@ start line A is verified against the actual file even with
    `--recount` (only B is recomputed) — match A to where the first
    context line really lives in the source snapshot.
  - every hunk MUST include 2-3 lines of unchanged context BEFORE the
    first changed line and 2-3 lines AFTER the last changed line.
  Locks-in via two snapshot tests on the prompt string (regression
  guard) — assert the new wording is present and the old "DO NOT need
  to be exact" phrase is gone.

  The v0.13.8 fuzz fallback is retained as defense-in-depth for cases
  where the worker still slips through with thin context; v0.13.9 just
  reduces how often that fallback has to fire.

## v0.13.8 — 2026-04-27

### Fixed
- **Autofix patch-apply: GNU `patch -p1 --fuzz=3` fallback (v0.13.8).**
  The first live closing-cycle attempt on eventbadge#29 (sha `279cb22`)
  surfaced a real RC: the worker emitted a unified diff with the hunk
  header line number off by one — `@@ -17,...` against an actual
  deletion target at line 18. `git apply --check --recount` rejected
  on the Linux runner ("patch failed: ...:17 — patch does not apply"),
  blocking the autonomy loop at step 2/7. Locally the same patch +
  same blob applied cleanly because git apply's offset tolerance
  forgave the off-by-one; on the CI runner (same git 2.53.0) it did
  not. `--recount` only recomputes line COUNTS, not start positions.

  Both apply paths in autofix now fall back to GNU `patch -p1
  --fuzz=3 -F 3` when `git apply` rejects:
  1. `runPerBlocker` (the per-blocker validation step) — uses
     `--dry-run` to mirror `git apply --check` semantics.
  2. The post-loop apply step in `autofix.ts` — actually writes the
     fix when fuzz-tolerant apply succeeds.
  Both must succeed for a fix to land. If `patch(1)` is unavailable
  (Windows runners) or also rejects, the existing
  conflict-with-diagnostic path runs and surfaces the original `git
  apply` error so the failure mode stays debuggable from CI logs.

  **Tests:** 2 new `runAutofix` cases — fallback-success-path and
  both-fail-path. Existing `makeGit` helper updated so
  `applyCheckFails`/`applyFails` overrides also reject the patch(1)
  fallback (otherwise the fuzz path would mask "patch is bogus"
  test scenarios).

## v0.13.7 — 2026-04-27

### Added
- **`conclave doctor` (v0.13.7).** New top-level command that runs four
  fixed checks and prints one line per check (`[OK]` / `[WARN]` /
  `[FAIL]` + remediation hint), no LLM calls:
  1. env keys — `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` /
     `GEMINI_API_KEY` (or `GOOGLE_API_KEY` fallback) / `CONCLAVE_TOKEN`
  2. central-plane `/healthz` — verifies the Cloudflare Worker is up +
     surfaces version + D1 binding status
  3. `.github/workflows/` — locates any workflow that pins
     `seunghunbae-3svs/conclave-ai/.github/workflows/...@<ref>` and
     warns when the ref drifts from the expected floating tag
  4. installed CLI version vs latest on npm — semver compare, suggests
     `npm i -g @conclave-ai/cli@<latest>` when behind
  Returns exit 1 only on a real `FAIL` (missing env, dead worker);
  warnings are informational. Fully testable — all I/O (`fetch`,
  `readDir`, `readFile`) injectable. **22 doctor tests** added.
- **Autofix can now patch design-domain blockers that name a `file`
  (v0.13.7 follow-up to the v0.7.1 TODO).** Pre-fix, every
  design-tagged blocker (categories `contrast`, `accessibility`,
  `layout-regression`, `style-drift`, `cropped-text`, `missing-state`,
  `overflow`, plus the `design-*` / `ui-*` / `visual-*` prefixes) was
  hard-skipped on the assumption that visual judgment requires a human.
  In practice most design-agent blockers DO name a source file
  (Tailwind utility class swap, color token bump, aria-* prop edit) —
  the worker can produce a clean unified diff against it. New rule:
  skip only when no `file` is set; otherwise fall through to the
  worker and let the downstream patch-validation handle non-fixable
  cases as `worker-error` / `no-patch`. Hard-skips still apply for
  fileless visual surfaces (route labels, screenshot ids).

### Fixed
- **Autofix: post-push deploy preview wait (v0.13.7).** After a
  successful autofix push, the next review could fire before
  Vercel/Netlify finished redeploying — visual review then captured
  the STALE preview that didn't reflect the fix. Autofix now polls
  `fetchDeployStatus` (the `gh api .../check-runs` reader from
  `@conclave-ai/scm-github`) for the new commit's deploy status:
  - **`success`** → continue to next iteration
  - **`failure`** → log warning + continue (re-review may flag the
    broken UI; better to surface than hide)
  - **`pending`** → poll every 15 s up to 5 min, then proceed anyway
    (better stale-preview review than hung autofix loop)
  - **`unknown`** → no deploy platform attached; skip the wait
    immediately (no-op for non-deploy repos)
  All thresholds (`deployWaitTimeoutMs`, `deployWaitIntervalMs`),
  the status fetcher, and the `sleep` helper are deps-injectable so
  the loop runs synchronously in tests. **4 deploy-wait tests** added.

### Internal
- **Hermetic regression tests for the v0.13.5-era root causes.**
  Pre-this-session, last session's burnt-credit dogfood surfaced 14
  root causes; the in-progress regression tests in `autofix.test.mjs`
  had a variable-mismatch bug and were reverted to keep the suite
  green. Re-implemented cleanly:
  - **RC #10 — multi-agent same-bug → 1 worker call.** Runs the full
    `runAutofix` flow with 3 agents (claude / openai / gemini) tagging
    the same console.log under different categories. Asserts
    `worker.calls.length === 1` (collapsed by dedupe).
  - **RC #7 — scoped staging never uses `git add -A` or `git add .`.**
    Asserts every `git add` invocation in the post-commit staging path
    is the scoped form (`git add -- <files>`) and that the worker's
    `appliedFiles` actually drives the file list.
  - **RC #13 — `defaultSpawnReview` passes `--no-notify`.** Drives the
    real `defaultSpawnReview` against a fake conclave binary that
    captures its argv to stderr; asserts `--no-notify` is in the call.
  All 3 tests run from a `dist/` build, no live network, no LLM.

### Removed
- **`runAutofix: design-domain blockers are skipped in v0.7`** —
  superseded by the two new design-blocker tests (no-file → skipped,
  with-file → worker invoked).

## v0.13.0 — 2026-04-26

### Added
- **Visual review zero-config (v0.13).** Removed the manual opt-in
  step. Pre-v0.13 a user had to either pass `--visual` or flip
  `visual.enabled: true` in `.conclaverc.json` to get screenshot-aware
  design review on UI PRs. v0.13 flips the default: when the auto-
  detected domain is `design` or `mixed` AND `visual.enabled` isn't
  EXPLICITLY false, visual fires automatically. Code-only PRs still
  skip — no surprise vision-token bills on backend-only diffs.
  Precedence ladder unchanged at the user-input level (5 knobs):
  `--no-visual` > `--visual` > config `enabled: true` > config
  `enabled: false` > config unset (v0.13 default = on iff UI domain).
- **Playwright auto-install (v0.13).** Pre-v0.13, a fresh machine
  without `chromium` saw `Cannot find module 'playwright'` on first
  visual-capture invocation and the user had to manually run
  `npx playwright install chromium`. v0.13's `PlaywrightCapture`
  catches the import error, runs the install once via
  `npx -y playwright install chromium --with-deps`, and retries the
  import. Air-gapped CI opts out via `autoInstall: false` (or by
  passing `--no-visual`). New `installRunner` test seam injects a
  controllable runner.
  - **Tests:** 5 new `auto-install.test.mjs` cases covering option
    plumbing, install-runner contract, log sink, opt-out path, and
    explicit-factory bypass.

### Fixed
- **Bug A (v0.11 leftover): rework workflow can't find local-only
  episodics.** Closed via the new episodic anchor service.
  - **Central plane:** new `POST /episodic/anchor` (Bearer auth, body
    = `{episodic_id, repo_slug, pr_number?, payload}`) and
    `GET /episodic/anchor/:id` (Bearer auth → returns the persisted
    episodic). New D1 table `episodic_anchors` keyed on
    `(install_id, episodic_id)` with `repo_slug + pr_number` for
    diagnostics; cross-install isolation enforced at the storage
    layer (install A's anchor is invisible to install B). 256KB
    payload cap. Migration `0007_episodic_anchors.sql`.
  - **CLI:** new `lib/episodic-anchor.ts` with `pushEpisodicAnchor` +
    `fetchEpisodicAnchor`. `conclave review` calls push after
    `OutcomeWriter.writeReview` succeeds (best-effort — a failure
    NEVER kills a review). `conclave rework`'s `resolveEpisodic`
    falls back to `fetchEpisodicAnchor` when the local store misses.
    No CLI flag changes — the fallback is automatic when
    `CONCLAVE_TOKEN` is set in env.
  - **Tests:** 7 new `apps/central-plane/test/episodic-anchor.test.mjs`
    cases (POST/GET happy path, validation, cross-install isolation,
    payload size cap); 8 new `packages/cli/test/episodic-anchor.test.mjs`
    cases (skip-when-token-absent, push happy path, HTTP 5xx no-throw,
    network-error no-throw, fetch happy path, 404, payload_raw
    fallback).
  - **Operational fix shipped, not in code:** Worker re-deployed +
    migrations 0006 (progress_messages) and 0007 (episodic_anchors)
    applied to remote D1.
- **Bug B (v0.11 leftover): `conclave-telegram-bot` cron HTTP 409.**
  Operational fix only (no code change). Generated a fresh
  `TELEGRAM_WEBHOOK_SECRET` (64-hex), uploaded as Cloudflare Worker
  secret via `wrangler secret put`, and called Telegram's
  `setWebhook` to bind `@BAE_DUAL_bot` →
  `https://conclave-ai.seunghunbae.workers.dev/telegram/webhook`.
  Then disabled `conclave-telegram-bot.yml` on
  `seunghunbae-3svs/eventbadge` via `gh workflow disable`. Inbound
  callback_query routing now goes through the central plane's
  webhook handler — action buttons (✅/🔧/❌) are no longer inert.

### Notes
- `@conclave-ai/cli@0.13.0`, `@conclave-ai/visual-review@0.13.0`,
  `@conclave-ai/central-plane@0.13.0`. core /
  integration-telegram stay on 0.11.0 (no changes).
- Worker live at `https://conclave-ai.seunghunbae.workers.dev`
  (version 0.13.0 per /healthz). Both new routes verified via curl
  401-on-no-auth probes.
- Webhook live: `getWebhookInfo` reports
  `url=conclave-ai.seunghunbae.workers.dev/telegram/webhook`,
  `pending_update_count=0`, `max_connections=40`.

## v0.12.0 — 2026-04-26

### Added
- **Multi-repo watch — local daemon (v0.12.0).** Fires `gh workflow run`
  on every newly-appeared PR (and on every head-SHA change of an
  already-watched PR) across a configurable list of repos. The "wire
  one repo, then forget about adding new ones" experience that was
  previously per-repo install setup.
  - **`conclave repos`** (`add`/`list`/`remove`/`path`) — manages a
    single per-user watch list at:
    - Windows: `%USERPROFILE%\.conclave\repos.json`
    - macOS / Linux: `~/.config/conclave/repos.json` (XDG-ish)
    File mode 0600 / Windows ACL — sits next to credentials.json so
    one perm posture covers both. Schema v1 with optional
    `pollIntervalSec` per-repo override slot (the cadence-per-repo
    feature itself is a v0.12.x follow-up).
  - **`conclave watch [--interval N] [--workflow yml] [--once]
    [--include-drafts] [--include-bots]`** — polls each watched repo
    via `gh api repos/:slug/pulls?state=open`, diffs against the
    in-process snapshot, and dispatches a workflow on:
    - new open PRs
    - existing PRs whose head SHA changed (force-push or new commit)
    Default cadence 30s (min 5s — Telegram-rate-limit-ish guardrail).
    Defaults to `conclave-review.yml` as the dispatched workflow.
    Drafts and bot-authored PRs (dependabot/renovate/copilot/
    conclave-autofix) are SKIPPED unless the matching `--include-*`
    flag is passed. SIGINT cleanly drains the in-flight cycle and
    exits 0.
  - Failure posture: per-repo poll failures and per-PR dispatch
    failures are logged + tolerated. One bad repo never breaks the
    cycle for the others. The watch loop has no on-disk seen-set —
    daemon restart re-fires on currently-open PRs (intentional;
    persistence stays in scope of v0.12.x).
  - **Tests:** 17 new `repos.test.mjs` cases (slug validation, on-disk
    round-trip, idempotent add, defensive parse of malformed entries,
    argv parser, runner exit codes); 13 new `watch.test.mjs` cases
    (argv parsing, `diffPolls` semantics, `pollOpenPrs` happy path
    + ENOENT, `dispatchReviewWorkflow` arg shape, full `runWatch`
    loop with mocked `gh` — covers draft skip, bot skip,
    `--include-drafts` override, head-sha-change re-dispatch, no-op
    on stable head, per-repo failure isolation). 47/47 turbo tasks
    green; 394 cli tests (was 358, +36 new across repos + watch).
  - **Live verified** against `seunghunbae-3svs/eventbadge` —
    `conclave repos add` + `conclave watch --once` polled 6 open PRs,
    skipped #12 (draft), attempted dispatch on the other five.
    Dispatch failures (HTTP 422 — `Workflow does not have
    'workflow_dispatch' trigger`) are correctly treated as
    consumer-repo workflow config issues, surfaced per-PR with the
    exact gh error, and don't poison the cycle.

### Notes
- `@conclave-ai/cli@0.12.0`. core / integration-telegram / central-
  plane stay on 0.11.0 (no functional changes — watch is CLI-only,
  no protocol or persistence changes outside the CLI).
- v0.11 left two pre-existing bugs flagged but unfixed; both have
  follow-up shape now:
  - **Bug A (rework episodic-not-found):** the v0.8 autonomy loop
    assumes the original review ran on CI so the rework workflow can
    re-load the episodic from `.conclave/episodic/...`. When a user
    runs `conclave review` LOCALLY (as in v0.11 dogfood), the
    episodic only exists on the local machine and the dispatched
    rework workflow exits 1 with `episodic ... not found in store`.
    Fix candidate for v0.12.x: have `conclave review` push the
    episodic to central plane (`/episodic/push`) so CI rework can
    fetch it. Out of scope for v0.12.0 — the watch flow naturally
    re-anchors review on CI.
  - **Bug B (telegram-bot-runner cron HTTP 409):** legacy polling
    bot conflicts with itself / with another `getUpdates` consumer.
    Operational fix: setWebhook to central-plane
    `/telegram/webhook` and disable the cron workflow. No code
    change needed — documented in the PR body so the owner can
    apply it.

## v0.11.0 — 2026-04-26

### Added
- **Telegram progress streaming (v0.11.0).** Reviews are no longer silent
  for 3 minutes — the council's progress is reported live as a single
  Telegram message that updates in place via `editMessageText`. Eight
  phase boundaries are emitted: `review-started` → `visual-capture-
  started/done` (when applicable) → `tier1-done` → `escalating-to-tier2`
  → `tier2-done` → `autofix-iter-started/done` (per autofix iteration).
  - **Core:** new `Notifier.notifyProgress(input)` optional method,
    `ProgressStage` / `ProgressPayload` / `NotifyProgressInput` types
    on the public surface. `Notifier` consumers without the method
    silently no-op (forward-compat for Discord/Slack/Email).
  - **integration-telegram:** `TelegramNotifier.notifyProgress` keeps
    an in-process chain map keyed by `(episodicId, pullNumber)`. First
    emit → `sendMessage` (captures `message_id`); subsequent emits →
    `editMessageText` of the same message. Identical re-renders are
    short-circuited locally to dodge Telegram's "message is not
    modified" 400. New `TelegramClient.editMessageText`. New
    `renderProgressLine` / `renderProgressMessage` exports.
  - **central-plane:** `POST /review/notify-progress` (Bearer-auth'd
    twin of `/review/notify`). Persists `(install_id, episodic_id,
    chat_id) → message_id` in a new `progress_messages` D1 table
    (migration `0006_progress_messages.sql`). Fans out per linked chat;
    each chat owns its own message_id. The renderer is duplicated from
    integration-telegram with a sync-by-policy comment — keeps Worker
    bundle independent of the Node-only client. New
    `apps/central-plane/src/db/progress.ts` + `progress-format.ts`.
  - **CLI:** `commands/review.ts` and `commands/autofix.ts` emit
    progress through a new `lib/progress-emit.ts` helper. The notifier
    factory was extracted to `lib/notifier-factory.ts` so notifiers
    can be built BEFORE deliberation (was: after) — that's what makes
    `visual-capture-started` and `tier1-done` fire in real time.
    Episodic id is now pre-generated via `newEpisodicId()` and threaded
    through `OutcomeWriter.writeReview`, so the Telegram timeline
    message and the on-disk episodic entry share the same id. Autofix
    extracts the upstream review's `episodicId` from the verdict JSON
    so iter-started/iter-done lines append onto the SAME message that
    the review started — full council-to-autofix continuity in chat.
  - **Tests:** 12 new `progress-streaming.test.mjs` cases (renderer
    purity, edit-chain semantics, central path, no-modified guard,
    HTML escaping); 6 new `review-notify-progress.test.mjs` cases
    (route happy path, validation, healthz up/down); 5 new
    `progress-emit.test.mjs` cases (no-throw policy, parallel fan-out,
    legacy-notifier skip). Total: 47/47 turbo tasks green; central-
    plane 121, telegram 63, cli 358 (+ 1 unrelated skip).
  - **Live E2E:** `scripts/e2e-progress-stream.mjs` fires the full
    timeline through the real Bot API. Verified against
    `@BAE_DUAL_bot` → chat 394136249 — 1 sendMessage + 7
    editMessageText, single chat message updated 8 times in place.
- **`/healthz` endpoint (v0.11).** Adds the K8s/uptime-monitor
  convention for monitoring central-plane. Pings D1 (`SELECT 1`) and
  reports `db: up | down`; the worker still returns 200 on a DB-down
  read so monitors can distinguish "edge runtime broken" from "DB
  binding broken". `/health` (v0.4 path) preserved for any wired
  monitoring.

### Fixed
- **`credentials.test.mjs` env-leak (v0.11).** Tests around
  `resolveKey: trims whitespace from env values` now inject `stored:
  {}` explicitly so dev machines with a populated
  `~/.conclave/credentials.json` no longer leak the stored anthropic
  key into the assertion path. CI was unaffected; this only ever bit
  local dev.

### Notes
- `@conclave-ai/cli@0.11.0`, `@conclave-ai/core@0.11.0`,
  `@conclave-ai/integration-telegram@0.11.0`,
  `@conclave-ai/central-plane@0.11.0`. Other packages stay on 0.10.0
  (no functional changes); the broader version-drift cleanup tracked
  in the v0.14 polish line is unchanged.
- After merge: deploy central-plane (`pnpm -C apps/central-plane
  ship`) — without the deploy `/review/notify-progress` returns 404
  and CLI v0.11 falls back to the direct path (no error, just no
  central-plane fan-out).
- Migration `0006_progress_messages.sql` runs through the standard
  `wrangler d1 execute` pipeline.

## v0.7.4 — `conclave config` (released as part of v0.10 train)

### Added
- **`conclave config` — persistent per-user credential storage (v0.7.4).**
  Eliminates the daily API-key-paste friction in fresh shells. One-time
  `conclave config` writes keys to `%USERPROFILE%\.conclave\
  credentials.json` (Windows, ACL-restricted to the current user via
  `icacls`) or `~/.config/conclave/credentials.json` (Unix, chmod 0600).
  Subcommands: `set` (programmatic, accepts stdin via `-`), `get`
  (masked by default, `--show-raw` for the full value), `list`
  (length + last-4 chars, never full secret), `unset`, `path`,
  `migrate` (imports current env-var values into storage). Resolution
  order: **env var first** (CI unchanged), stored fallback, then nothing
  (agent skipped). CLI entry-point hydrates `process.env` from storage
  for any env var that isn't already set, so subprocess spawns
  (`autofix` → `review --json`) and packages that read
  `process.env` directly (`integration-telegram` CONCLAVE_TOKEN) pick
  up stored values without per-package changes. All CLI call sites
  (`review.ts` / `audit.ts` / `autofix.ts` / `rework.ts` /
  `plain-summary-llm.ts`) migrated to `resolveKey()`. Supported keys:
  `anthropic`, `openai`, `gemini` (accepts `GOOGLE_API_KEY` alias),
  `conclave-token`, `xai`. No encryption at rest in v0.7.4 (file-mode
  0600 / Windows ACL); master-password + OS Keychain integration
  tracked for v0.8+. 33 new CLI tests; total 309 cli tests,
  all 47 turbo tasks green. Bumps `@conclave-ai/cli` 0.7.3 → 0.7.4.
  See `docs/releases/v0.7.4.md`.

### Fixed
- **Telegram webhook Illegal-invocation + autofix exit-code handling (v0.7.2).**
  Two P0 bugs caught via live dogfood on `seunghunbae-3svs/eventbadge#21`.
  (1) `apps/central-plane` `/telegram/webhook` crashed on every inbound
  update with `TypeError: Illegal invocation: function called with
  incorrect 'this' reference`. Root cause: `TelegramClient` stored
  global `fetch` on `this.fetchImpl` and called it via `this.fetchImpl(...)`
  — Cloudflare Workers rejects native-method invocations where
  `this !== globalThis`. Fix: bind the default to `globalThis` at store
  time and pull the impl into a local before call. (2) `conclave autofix`
  treated `conclave review`'s non-zero exit as a crash. `conclave review`
  uses 0=approve/1=rework/2=reject — all three carry a valid verdict JSON
  on stdout. `defaultSpawnReview` now returns `{code:0|1|2, stdout}`
  instead of throwing; only exit ≥ 3 (or no exit at all) re-throws.
  Autofix also now refuses to fix a reject verdict (prints a clear
  message + exits 1). 11 new regression tests (3 central-plane, 8 cli);
  total 76 + 255 = 331 tests, 0 failing. Bumps
  `@conclave-ai/central-plane` 0.6.1 → 0.7.1 (first bump since v0.6.1
  — Bae needs to `corepack pnpm ship` post-merge to deploy) and
  `@conclave-ai/cli` 0.7.1 → 0.7.2. See `docs/releases/v0.7.2.md`.

### Added
- **`conclave review --json` + `conclave autofix` auto-spawn (v0.7.1).**
  `conclave autofix --pr N` now works with ONLY `ANTHROPIC_API_KEY` set
  — no more hand-crafted verdict JSON file. When `--verdict` is
  omitted, autofix spawns `conclave review --pr N --json` as a
  subprocess, parses its structured JSON stdout, and feeds the verdict
  into the existing fix loop. Closes the v0.7.0 dogfood gap on
  `seunghunbae-3svs/eventbadge#21`, where hand-crafting verdict JSON
  on PowerShell hit UTF-16 BOM issues on temp files. Three
  complementary paths: (a) auto-spawn (default), (b) `--verdict <file>`
  (preserved for CI / air-gapped), (c) `--verdict -` (reads stdin, lets
  users pipe `gh api ... | conclave autofix --pr N --verdict -`). New
  `--json` flag on `conclave review` emits a single newline-terminated
  JSON object with a **pinned v0.7.1 schema** (verdict / domain / tiers
  / agents / metrics / episodicId / sha / repo / prNumber / optional
  plainSummary); exit code preserved (0 approve / 1 rework / 2 reject);
  diagnostics routed to stderr. Pure emitter at
  `packages/cli/src/lib/review-json-output.ts` (`buildReviewJson` +
  `serializeReviewJson`). `parseVerdictFile` now accepts all three
  shapes (episodic / standalone / `--json`) and normalizes `agents[]`
  → `reviews[]` internally. Subprocess failure, non-zero exit (outside
  0/1/2), unparseable stdout, and timeout each surface a clear error
  with the fallback suggestion. 19 new tests across 2 new files
  (247 total, 0 failing). Bumps `@conclave-ai/cli` 0.7.0 → 0.7.1. No
  other package changes. See `docs/releases/v0.7.1.md`.

- **`conclave autofix` — autonomous fix loop (v0.7.0).** Council verdicts
  now become committed, build-verified, test-verified patches. For each
  blocker, `ClaudeWorker` from `@conclave-ai/agent-worker` generates a
  unified-diff patch; every patch runs through `git apply --check
  --recount` validation + secret-guard + a default deny-list
  (`.env*` / `*.pem` / `*.key` / `*secret*` / `*.credentials*`) + a
  500-line cross-patch diff budget before any apply. Applied iterations
  run auto-detected build + test commands (`pnpm`/`cargo`/`pytest`);
  failure reverts via `git reset --hard HEAD` and bails. On pass,
  commit authored as `conclave-autofix[bot]`, push, meta-review. L2
  (default) prints "awaiting Bae approval"; L3 runs `gh pr merge
  --squash`. Hard rails: 3 iterations, $10 budget, 500 lines. Design-
  domain blockers skipped (v0.7.1 follow-up). 17 new tests; bumps
  `@conclave-ai/cli` 0.6.4 → 0.7.0, `@conclave-ai/core` 0.6.4 → 0.7.0
  (adds `BlockerFix` / `AutofixResult` / `isFileDenied` /
  `summarizeAutofixPatches` / `dedupeBlockersAcrossAgents`),
  `@conclave-ai/agent-worker` 0.4.0 → 0.7.0 (first real CLI consumer).
  Closes the eventbadge#21 dogfood gap. See `docs/releases/v0.7.0.md`
  and `docs/guides/autofix.md`.

- **Auto-injected project + design context (v0.6.4).** Every `conclave review` and `conclave audit` run now loads a bounded slice of the repo's own docs and passes them into every agent — so the council sees product intent alongside the diff, not just the hunks in isolation. Sources (priority order, silent-skip when absent): `README.md` (first 500 chars), `.conclave/project-context.md` (full), `.conclave/design-context.md` (full, DesignAgent only), `.conclave/design-reference/*.png` (≤ 4 × 500KB, DesignAgent vision mode). Fixes the class of false-positives eventbadge PR #20 hit: council called `with: cli-version: latest` a "CI config error" because it couldn't see the reusable-workflow `uses:` line just above the diff. With a project-context file present, agents understand the convention and correctly don't flag it. New `packages/cli/src/lib/project-context.ts` loader; 25 new tests; optional `context` config section; no `.conclaverc.json` regeneration required. Bumps: cli, core, agent-claude, agent-openai, agent-gemini, agent-design → 0.6.4. See `docs/releases/v0.6.4.md` and `docs/guides/project-context.md`.

### Fixed
- **P1: DesignAgent verdict silently dropped from mixed-domain output (v0.6.2).** On any `conclave review` that auto-detected to `mixed` (code + UI signals in the diff), users only saw `claude` / `openai` / `gemini` sections even though the diff included `.jsx` / `.css` / other UI files. Dogfooded on `seunghunbae-3svs/eventbadge#20`. Root cause: the tier-1 merge in `review.ts` unioned `domains.code.tier1 ∪ domains.design.tier1`, but for any `.conclaverc.json` written by `conclave init` pre-v0.5.0-alpha.1 (PR #84) the design list was `["claude","openai","gemini"]` — no `"design"` entry — so `buildAgent("design", …)` was never called, the Council never got a DesignAgent, and the renderer (which was correctly iterating `results`) had no design section to emit.
  - **Fix 1 — stale-config safety net.** When `resolvedDomain === "mixed"` and the merged tier-1 list doesn't include `"design"`, inject it at the head. Same for tier-2 when non-empty (design's `alwaysEscalate: true` makes tier-2 the binding verdict on mixed runs). Legitimate tier-1-only configs (empty tier-2 on both domains) are left alone. Handles legacy configs without requiring a migration.
  - **Fix 2 — tier-resolver extraction.** Moved the tier-1/tier-2 merge + safety-net logic out of `review.ts` into `packages/cli/src/lib/tier-resolver.ts` as a pure `resolveTierIds(...)` function so the merge is unit-testable. 10 new tests cover pure-code, pure-design, mixed-current-config, mixed-stale-config (the exact eventbadge#20 shape), model-override precedence (design over code), empty-tier-2 edge, and missing-config edges.
  - **Diagnostic logging.** `conclave review` now prints `tier-1 agents: [...]` (and `tier-2 agents: [...]` when relevant) before the council runs so users can immediately tell whether DesignAgent made the cut. Prints actually-built agent ids, so credential-skipped agents drop out of the list.
  - **Regression coverage.** 2 new renderer tests assert the `design → ...` section renders alongside `claude → ...` / `openai → ...` in mixed-domain output, and that it still renders when another agent errored mid-round (verifies the synthetic `agent-failure` rework result doesn't crowd out the design section).
  - `@conclave-ai/cli` bumped to 0.6.2. No other packages touched. No schema changes. See `docs/releases/v0.6.2.md`.

### Security
- **Reusable review workflow hardening (v0.5.2).** Three fixes to `.github/workflows/review.yml`, all flagged by Conclave's own council on `seunghunbae-3svs/eventbadge#19`:
  - **Workflow-security:** secret-bearing steps (LLM keys, `CONCLAVE_TOKEN`, `GH_TOKEN`, `ORCHESTRATOR_PAT`) now gated to non-fork, owner-authored PRs. Fork PRs + external-contributor PRs get a friendly "install locally" fallback comment that uses only the ambient `GITHUB_TOKEN`. Closes the same-repo-branch-PR vector where attacker-controlled PR code would execute inside the secret-bearing step.
  - **Supply-chain:** `inputs.cli-version.default` changed from `latest` to a pinned `0.4.3` (current latest stable). Header comment documents the "intentional bumps only" policy. Consumers can still override per-call.
  - **Secrets-exposure:** review stdout now passes through a `sed -E` redaction step (Anthropic/OpenAI/Google/GitHub/Telegram token shapes) before being posted as a public PR comment. The unredacted copy is kept runner-side for debug logs; only the public comment is filtered.
  - **Breaking for external-contributor workflow only:** fork PRs no longer auto-review — they get the install-locally notice. All same-repo, owner-authored PRs (99% of installs) behave identically. After merge, re-tag `v0.4` to pick up the fix. See `docs/releases/v0.5.2.md`.

### Added
- **`@conclave-ai/core/guards` — `LoopGuard` + `CircuitBreaker` (architecture spec layer 3, now shipped).** Two in-memory primitives with clock-injection for tests:
  - **`LoopGuard`** — bounded-frequency counter on `(repo, pr, sha)` or any user-chosen key. Throws `LoopDetectedError` when the same key is reviewed more than `threshold` times inside a rolling `windowMs`. Defaults: threshold 5, window 60 min. Prevents the "rework → re-review → rework → …" loop that'll happen once the Worker/Rework agent lands (planned).
  - **`CircuitBreaker`** — per-provider consecutive-failure counter with cooldown. Wrap each external call with `breaker.guard(providerId, fn)`. After `failureThreshold` consecutive failures (default 3), refuses calls for `cooldownMs` (default 5 min) with `CircuitOpenError`. Success between failures resets the counter. Half-open on next call after cooldown. Providers track independently — Gemini 429 doesn't throttle Claude + OpenAI. Complements the `Promise.allSettled` fix in PR #53: allSettled survives one-round failures; CircuitBreaker stops repeated offenders before they burn budget.
  - Neither wired into Council / EfficiencyGate by default — callers opt-in through the orchestrator template. Keeps primitives unit-testable and the gate free of deployment-shape assumptions.
  - 13 tests: threshold math, rolling-window eviction, independent keys/providers, diagnostic error fields, cooldown expiry → half-open → re-open path.

### Changed
- **Telegram notification rewritten for non-developer readability (dogfood feedback).** The old per-agent wall-of-technical-jargon format buried the actual action items in paragraphs and repeated the same file:line blocker once per agent. New format:
  - **Plain-language verdict label** — `APPROVE` / `REWORK` / `REJECT` → `Approved` / `Needs changes` / `Rejected`.
  - **Cross-agent blocker deduplication** — blockers pointing at the same `file:line` merge into one entry with an `"Claude + OpenAI agree"` marker so consensus is obvious.
  - **Humanized category labels** — `workflow-security` → `CI workflow security`, `secrets-exposure` → `Possible secret leak`, `supply-chain` → `Supply-chain risk`, `type-error` → `Type mismatch`, plus ~10 more. Unknown categories pass through verbatim so custom tags aren't rewritten.
  - **Top-3 distinct blockers** across all agents (was: top-3 per agent, so 9 with 3 agents and massive overlap). Remainder shown as `"+ N more issues"`.
  - **Compact footer** — `💰 $0.37 · agents: 3` instead of `cost: 0.3664 · episodic: ep-abc…`. Episodic id kept on its own line for ops lookup.
  - `approve` verdict gets a friendly single-line blessing (`All agents agreed the change is ready to ship`) instead of empty per-agent blocks.
  - 11 tests cover verdict labels, category humanization, cross-agent merge, severity ordering, truncation at the 4096-char Telegram limit, HTML escape.

### Fixed
- **P0: `Council.deliberate()` no longer dies when one agent throws.** `Promise.all` → `Promise.allSettled`. Previously, any single agent 4xx/5xx/network error (e.g. Gemini free-tier 429, provider timeout, invalid key) killed the entire round and surfaced as a top-level CLI crash. Now failed agents drop out of the tally with a synthesized `rework` result carrying a `category: "agent-failure"` blocker explaining the cause. Only throws when ALL agents fail (aggregated reasons in the message). Dogfood on eventbadge PR surfaced this: Gemini 429 crashed Claude + OpenAI's otherwise-successful tier-1 pass. 3 new regression tests.

### Added
- **`@conclave-ai/platform-render` — first v2.1 platform adapter.** Ranked #1 in the 2026-04 adapter-scope study (solo-maker default outside the v2.0 five). REST API at `api.render.com/v1` — GET service for canonical URL, GET deploys filtered client-side by `commit.id === sha` AND `status === "live"`. Pattern mirrors `platform-railway` (Bearer-token + URL-encode serviceId), so the next v2.1 platforms (Fly / Firebase if ranked in) plug in the same shape. 12 unit tests use the shared `mockFetch` harness. `RENDER_API_TOKEN` + `RENDER_SERVICE_ID` env vars; missing either → factory skips with reason. CLI `visual.platforms` default list adds `"render"` so it participates automatically once the user configures credentials. Service Previews caveat documented in the README — for per-PR preview URLs, point the adapter at the preview service's `srv-...` id rather than the main one.

### Added
- **CLI wiring for 2-tier council (part 3/3 of decisions #7/#26/#28 reopen).** `conclave review` now selects `TieredCouncil` when `config.council.domains[<domain>]` is set, and the legacy flat `Council` otherwise. New CLI flag `--domain code|design` (default `code`). Per-tier agent model override is pulled from config (`models.tier1` / `models.tier2`); absent entries fall back to each agent's default. `output.ts` `renderReview` adds a "Tiers" line summarizing the escalation path (`1 (1r) → 2 (2r) — domain=design`). Agent-builder logic refactored into `buildAgent(id, modelOverride?)` so tier-1 and tier-2 share one credential-check code path. Dogfood `.conclaverc.json` switched to the 2-tier shape with flagship-model overrides for tier 2 (`claude-opus-4-7`, `gpt-5.4`). `docs/configuration.md` gets a new "(b) 2-tier council" subsection documenting the shape + the escalation rule. Added `gpt-5.4` to `agent-openai` pricing table (placeholder matching gpt-5 rates; budget cap enforces spend regardless).

### Added
- **`TieredCouncil` class — 2-tier escalation flow (part 2 of decision #7/#26/#28 reopen).** Composes two `Council` instances (reuses all of #7's round/priors/early-exit logic) into a tier-1 draft → escalation → tier-2 authoritative pipeline. Escalation reason is deterministic: design domain, any `major`/`blocker` severity, non-approve verdict, or `alwaysEscalate: true` each force tier-2. Tier-2 agents see tier-1 priors injected into their first-round `ctx.priors`. Output `TieredCouncilOutcome` extends `CouncilOutcome` with `escalated`, `tier1Outcome`, `tier2Outcome?`, and `escalationReason` (string, surfaced to ops dashboards). Tier-1-only mode allowed — emits a clear "would-escalate but no tier-2 configured" reason and ships tier-1. 19 unit tests cover: empty-tier guards, all escalation paths, priors + `tier` field propagation, per-tier round counts, backward-compat output shape. No CLI wiring yet — that's PR 3. Full suite 39/39.

### Changed (breaking prep — no runtime change yet)
- **Schema prep for 2-tier council (reopens decisions #7 / #26 / #28).** This PR lays the foundation — next PRs bring the `TieredCouncil` class and CLI wiring.
  - `ReviewContext` gains `domain: "code" | "design"` (optional; absent ≡ `"code"` for backward compat) and `tier: 1 | 2` (set by `TieredCouncil` at call time; legacy flat-Council callers leave it undefined).
  - `ConclaveConfig.council.domains.{code,design}` — Zod schema with tier-1/tier-2 agent lists, per-tier maxRounds, `alwaysEscalate`, and optional per-tier model overrides. The legacy flat fields (`maxRounds`, `enableDebate`) stay in place as a fallback so existing `.conclaverc.json` files keep working.
  - Dogfood `.conclaverc.json` drops `"deepseek"` from the agent list. The npm package `@conclave-ai/agent-deepseek@0.1.0` stays published (72-hour unpublish window passed, no need to burn it); users can opt it back in explicitly if they want.
  - `docs/decision-status.md` records the reopen + the rationale + the explicit dropped items (idea domain, Deepseek default) + the trigger for a future revisit.

### Added
- **`@conclave-ai/agent-grok` — xAI agent (decision #32).** Third v2.1 agent. OpenAI-wire-compatible; routes to `https://api.x.ai/v1` via the `openai` SDK. Default model `grok-code-fast-1` (code-tuned, cheapest at $0.20/M input, $1.50/M output); pricing table also covers `grok-3`, `grok-3-mini`, `grok-4`. `XAI_API_KEY` required. Missing key skips cleanly.

- **`@conclave-ai/agent-ollama` — local inference agent (decision #32).** Routes reviews to a local Ollama daemon via its OpenAI-compatible endpoint at `http://localhost:11434/v1`. Zero API key (placeholder "ollama" string satisfies the SDK), zero wire cost (`actualCost` returns 0). Default model `llama3.3`, override via constructor or pick any model `ollama list` shows. `OLLAMA_BASE_URL` env var supports self-hosted / remote Ollama instances. CLI factory adds `"ollama"` with no credential gating — user is responsible for the daemon being up. 11 unit tests use a stub client (no network).

- **`@conclave-ai/agent-deepseek` — first v2.1 agent (decision #32).** OpenAI-wire-compatible; reuses the `openai` SDK pointed at `https://api.deepseek.com`. Supports `deepseek-chat` (V3, general) and `deepseek-reasoner` (R1, chain-of-thought). Pricing ~20× cheaper than GPT-5 input (0.27/M vs 5.0/M) with a deep cache discount (0.07/M — ~26% of standard). Wired into the CLI factory alongside `"claude" / "openai" / "gemini"`; missing `DEEPSEEK_API_KEY` skips cleanly like the others. `docs/configuration.md` + Zod config enum both updated. 18 tests mirror the agent-openai suite (16 agent + 8 pricing).

### Docs
- **Public-launch prep.** README install path switched from "clone + build" to `pnpm add -g @conclave-ai/cli` now that packages are live on npm. Added npm version / scope / license / node badges. `docs/getting-started.md` updated the same way — every `node /path/to/conclave-ai/packages/cli/dist/bin/conclave.js ...` collapsed to plain `conclave ...`. New `CONTRIBUTING.md` at the repo root — setup, ground rules (architecture lock, one package per responsibility, Zod at boundaries, tests alongside code, lockstep versioning), PR flow, and release flow pointer.

### Ops
- **`ci.yml` hardening.** Switched to `pnpm install --frozen-lockfile` now that `pnpm-lock.yaml` is committed; added `cache: pnpm` to the Node setup action for faster installs; added Node 20 + 22 matrix so we catch breaks on newer runtimes before users do. No test or behavior change, just faster and stricter.

### Fixed
- **`release.yml` safety hardening (dogfood feedback)** — OpenAI's review of PR #37 flagged five workflow correctness issues during the first real E2E run. Three land as real fixes, two are intentional and now documented:
  - **Fixed:** bump+commit step now idempotent (skips when there are no staged changes, covers no-op re-runs).
  - **Fixed:** tag creation idempotent (checks for existing `vX.Y.Z` ref before creating + pushing).
  - **Fixed:** manual (`workflow_dispatch`) runs gated to `main` — fast-fail with actionable error when dispatched from a feature branch, prevents accidentally pushing a non-main branch into `main` via the release pipeline.
  - **Kept as-is with rationale in code:** `cancel-in-progress: false` is deliberate. A running release is already publishing tarballs; cancelling mid-flight leaves the registry split. Concurrency group keeps at most one pending run, so there is no race.
  - **Deferred:** workspace-level atomic versioning (vs per-package `npm version -r`) — `pnpm -r --filter` runs sequentially from a common starting version, so drift only occurs on mid-loop failure. Revisit when/if Changesets lands.

- **Agents' default `maxTokens` 2,048 → 8,192** across Claude, OpenAI, and Gemini. Surfaced during the first real `conclave review` run against PR #37 — OpenAI returned `finish_reason=length` because a medium-sized review prompt + structured JSON output + reasoning tokens exceeded the old cap. 2k was a fixture-friendly default that never tripped in unit tests (mocks don't emit real tokens). Budget reservation math still fits comfortably under the default `$1.00/PR` cap even at 8k × 3 agents × 3 rounds.

### Ops
- **`.github/workflows/release.yml` — automated release pipeline.** Two triggers: (1) `workflow_dispatch` with a `patch | minor | major` bump input, runs build + test, bumps every `packages/*` version in lockstep, commits + tags + pushes, then publishes via `pnpm publish -r --access public` with npm provenance. (2) `push: tags: ["v*"]` — skips the bump step (tag is truth) and goes straight to publish. `docs/release-process.md` covers both paths, the one-time secrets setup (`NPM_TOKEN`), and the lockstep-versioning pre-1.0 policy.

### Docs
- **`docs/decision-status.md`** — ground-truth table mapping each of the 34 locked decisions to its current implementation state.
  - #8 + #9 (Agent SDK migrations to `@anthropic-ai/claude-agent-sdk` / `@openai/agents`) marked **🔄 Diverged** with explicit rationale: our agents are one-shot reviewers, not loops. The agent-SDK wrappers target autonomous multi-step flows — real weight (3.9 MB Claude SDK + 3-package OpenAI chain), zero behavioral win for our shape. Migration trigger documented: if per-agent tool use lands inside a single review (MCP lookups, iterative proposals), revisit #8/#9 then.
  - ARCHITECTURE.md left untouched (locked). This document is purely a map from locked decisions → code, not a revision of the decisions themselves.

### Added
- **MCP stdio server (decision #11)** — `conclave mcp-server` starts a stdio-transport MCP server that exposes read-only views of the local memory substrate. Designed to be launched by an MCP client (Claude Desktop / Cursor / Windsurf) via their config. Three tools:
  - `conclave_scores` — per-agent weighted performance (decision #19).
  - `conclave_retrieve { query, k?, domain?, repo? }` — BM25-style retrieval over local answer-keys + failures.
  - `conclave_list_episodic { limit?, outcomeFilter? }` — recent review events + outcomes.
  - Deliberately read-only: running a full review (multi-agent + debate rounds + LLM spend) stays on `conclave review`. MCP clients can inspect what the council has learned; they don't trigger new reviews through the protocol.
  - Tool handlers extracted to pure functions (`retrieveReadOnly`, `listEpisodic`) so unit tests cover semantics without spinning up the MCP transport. +6 CLI tests (52 total).
  - SDK loaded lazily so CLI startup cost stays unchanged for users who never run the MCP server.

- **odiff native adapter (decision #15)** — `OdiffDiff` wraps [odiff-bin](https://www.npmjs.com/package/odiff-bin) (Zig port, ~6-8× faster on large images than pixelmatch) behind the same `VisualDiff` interface as `PixelmatchDiff`. Opt-in; shipping default remains pixelmatch because odiff is out-of-process and the fork + file I/O overhead eats the speed win for small diffs.
  - `odiff-bin` declared as optional peer dependency — users opt in with `pnpm add odiff-bin` and approving its postinstall.
  - Size-mismatched inputs padded with opaque magenta before invocation (matches `PixelmatchDiff` behavior) so `DiffResult` shapes are interchangeable.
  - Maps odiff's exit codes (0 = identical, 21 = different, 22 = size mismatch) to `DiffResult`; parses `"N diff pixels"` from stdout with comma-tolerance. Defaults `diffPixels = 0` if the output format drifts.
  - Constructor accepts `{ binaryPath, spawner }` for tests; 11 new tests use a mock spawner so the suite doesn't require odiff-bin installed on CI.

- **Retrieval-side merge of federated baselines (decision #21)** — closes the gap the sync skeleton left. `conclave sync` now persists pulled baselines to `.conclave/federated/baselines.jsonl` (JSONL, deduped by `contentHash`); `conclave review` reads that cache when `federated.enabled = true` and boosts retrieval proportionally.
  - `computeBaselineHash` / `hashAnswerKey` / `hashFailure` exported from `core/federated` so retrieval-time code can recompute the hash a local doc would produce.
  - `buildFrequencyMap(baselines)` aggregates by `contentHash`; `rerankByFrequency(scored, map, hashDoc, { boost, saturationAt })` applies a logarithmic boost — `factor = 1 + min(1, log2(1+freq) / log2(1+saturationAt)) * (boost - 1)`. Default `boost = 2.0`, `saturationAt = 256`. Docs with zero matches keep their score.
  - `FileSystemFederatedBaselineStore` — JSONL on disk, `read` / `write` / `append` (dedupe by hash) / `clear`. Malformed lines are skipped silently to survive partial writes.
  - `MemoryReadQuery` gains optional `federatedFrequency?: ReadonlyMap<string, number>`; `FileSystemMemoryStore.retrieve` reranks answer-keys + failures when it's set. No-op when absent — legacy callers unaffected.
  - `conclave sync` output adds a `cached: N` field (baselines written to local cache).
  - 21 new core tests (9 frequency + 8 baseline-store + 4 fs-store rerank). Full suite: 33/33 tasks, core 159 → 180.

- **Cosmiconfig loader (decision #16)** — `.conclaverc.json` still works; now accepts any of `.conclaverc[.json|.yaml|.yml|.js|.cjs|.mjs]`, `conclave.config.{js,cjs,mjs}`, and a top-level `conclave` field in `package.json`. Search strategy "global" walks from cwd to filesystem root (matches the original manual walker). searchPlaces reorders cosmiconfig's defaults so an explicit rc file wins over an incidental `conclave` field in package.json. Four new loader tests (YAML, package.json field, cjs, rc-vs-package.json precedence); `docs/configuration.md` gets a Config Discovery section with YAML / JS / package.json examples.

### Docs
- **README rewrite + `docs/` directory** for public-launch readiness.
  README now reflects actual state (18 packages, 9 CLI commands, 29/34
  decisions implemented, 28 PRs merged) instead of the pre-alpha
  scaffolding text it opened with.
- `docs/getting-started.md` — zero-to-review walkthrough with env
  vars, init, review, outcome recording, optional visual + federated
  paths, troubleshooting.
- `docs/configuration.md` — full `.conclaverc.json` schema reference
  with every env var mapped to the feature it enables.
- `docs/federated-sync.md` — the privacy model, exact wire format,
  three independent off-switches, and an audit pointer into the four
  files that define the entire redaction + transport flow.

### Added
- **Council 3-round debate (decision #7)** — Council now runs up to 3 rounds of review before verdict. Round 1 is independent; rounds 2+ pass each agent the other agents' results (`ctx.priors`) so they can update their verdict on arguments they missed, or hold firm. Consensus (all approve OR any reject) triggers early exit at any point.
  - `ReviewContext` gets two optional additive fields: `round?: number` + `priors?: PriorReview[]`. Backward compat: agents that ignore them stay valid; the three in-repo agents (claude, openai, gemini) all render priors into their prompts so they actually use the debate signal.
  - `CouncilOutcome` gains two optional fields: `roundHistory?: RoundOutcome[]` + `earlyExit?: boolean`. The legacy-shape fields (`verdict`, `rounds`, `results`, `consensusReached`) are unchanged, so existing consumers (notifiers, memory writer, CLI renderer) keep working without knowing debate happened.
  - New `Council` options: `maxRounds` (default 3, cap 5) + `enableDebate` (default true; set false to preserve legacy 1-round behavior).
  - New config block: `council.maxRounds` + `council.enableDebate` in `.conclaverc.json`, defaults match.
  - CLI `conclave review` renders `Rounds: N (early exit on consensus)` in the output when debate ran.
  - 13 Council tests (up from 6) cover: early exit on round 1, full 3-round fallthrough, scripted verdict changes reaching consensus mid-debate, priors + round wiring, `enableDebate=false` preserves legacy, `maxRounds` cap, consensus-in-final-round, roundHistory shape, blockers-in-priors end-to-end.

- **Federated sync skeleton (decision #21)** — `@conclave-ai/core/federated` subpath + `conclave sync` CLI command. Opt-in cross-user baseline exchange that carries ONLY category + severity + normalized tag vector + day bucket + a deterministic sha256 hash. The `lesson` text, `title`, `body`, `snippet`, `seedBlocker`, `repo`, `user`, `pattern`, and `episodicId` are stripped before anything touches the wire.
  - `redactAnswerKey` / `redactFailure` — pure, synchronous, deterministic. Same (domain, tags) across users produce the same `contentHash`, which is the aggregation key a federation server uses for counts.
  - `HttpFederatedSyncTransport` — thin JSON contract (`POST /baselines`, `GET /baselines?since=…`) so community aggregators can implement the endpoint without a vendor SDK. `NoopFederatedSyncTransport` for disabled/test paths.
  - `runFederatedSync({ transport, answerKeys, failures, dryRun, since, pushDisabled, pullDisabled })` — the orchestrator. All redaction happens here; the transport never sees raw memory entries.
  - **Default OFF.** Must set `federated.enabled = true` + `federated.endpoint = "https://…"` in `.conclaverc.json` to opt in. Optional `AI_CONCLAVE_FEDERATION_TOKEN` env var for bearer auth.
  - `conclave sync --dry-run` prints the exact payload that would be uploaded so you can audit before opting in.
  - Schema is v1; servers MUST reject unknown versions. Bumping the version is the breaking-change lever.
  - 29 core tests (11 redact + 11 transport + 7 sync). Retrieval-side merge of pulled baselines is DEFERRED — no live endpoint exists yet and the read path stays local-only until one does. CLI command is wired but not test-covered yet; it's thin enough that the underlying core tests carry the guarantees.

- **`@conclave-ai/platform-railway`** — completes decision #31 v2.0
  platform set (Vercel + Netlify + Railway + Cloudflare Pages +
  `deployment-status`).
  - Resolves preview URL for a commit SHA via Railway's GraphQL API
    (`POST https://backboard.railway.com/graphql/v2`).
  - Fetches the latest 20 deployments for a project (optionally
    narrowed by `RAILWAY_ENVIRONMENT_ID`), filters client-side by
    `meta.commitHash === sha` AND `status === "SUCCESS"`, picks newest
    by `createdAt`.
  - Prefers `staticUrl` (`*.up.railway.app`); falls back to `url` for
    custom domains; returns null when neither is present.
  - 404 → null, 401/403 → throws (auth), 5xx → throws, GraphQL
    `errors[]` → throws with the message.
  - Env: `RAILWAY_API_TOKEN` + `RAILWAY_PROJECT_ID` required;
    `RAILWAY_ENVIRONMENT_ID` optional.
  - Wired into `buildPlatforms` factory as `PlatformId = "railway"`
    and into the CLI default visual platform list.
  - 12 test cases mirror the Cloudflare adapter shape: missing envs,
    newest-SUCCESS-wins, non-matching commit, non-SUCCESS status,
    GraphQL errors, bearer auth + POST body shape, environmentId
    forwarding, 401/404/500 handling, staticUrl fallback, no-URL
    deployments → null.

### Fixed
- **Four test failures surfaced by fresh `pnpm build && pnpm test`
  runs after PR #25 landed:**
  - `core/memory/retrieval`: tag-only matches (text overlap = 0) now
    contribute a base score so the tag boost can promote them past
    `minScore`.
  - `core/test/scoring`: tolerance compare for
    `AGENT_SCORE_WEIGHTS` sum — IEEE 754 returns `0.9999999999999999`
    for `0.4 + 0.3 + 0.2 + 0.1`, so strict equality was wrong.
  - `visual-review/diff`: pad mismatched canvas with opaque magenta,
    not transparent black — pixelmatch blends transparent pixels
    against a white background and was reporting zero diff for any
    size-mismatched pair.
  - `visual-review/test orchestrator helper`: `fixedPlatform` stub now
    filters by `input.sha`, matching the real `Platform` contract so
    the preview-metadata test surfaces the correct before/after URLs.

- **Agent scoring (decision #19)** — rolling weighted per-agent
  performance metrics from memory. Weights ported from solo-cto-agent
  where they were validated in production:
  - build pass rate 40% · review approval rate 30% · time to
    resolution 20% · rework frequency 10%.
  - Missing components (time not yet tracked) renormalize so agents
    aren't penalized for data we don't collect yet.
  - `computeAgentScore(agent, entries)` operates on a flat episodic
    list. `computeAllAgentScores(store)` one-pass over every agent.
  - Review approval rate = agent's `approve` votes / total reviews.
  - Build pass proxy = of the PRs an agent approved, fraction that
    eventually merged. Counts as a signal that the agent's judgment
    aligned with final outcome.
  - Rework-friendly = 1 - (reworked / resolved). Pending entries
    excluded from both buildPass and rework calcs.
  - Time component currently `null` — needs resolution timestamps
    beyond createdAt, tracked separately.
  - Score rounded to 4 decimals for stable CLI output.
  - **New CLI command `conclave scores [--json]`** prints per-agent
    score + component breakdown, or JSON for piping.
  - 12 test cases: weights sum to 1.0, empty history → 0, all-merged
    → near-1.0, all-reworks → 0, pending excluded, other-agent
    entries ignored, mixed verdicts fractional, approved-but-rejected
    drops buildPass, time always null placeholder, componentsUsed
    lists contributors, score rounding, computeAllAgentScores picks
    up every agent + sorted alphabetically.

### Added
- **Vision judge for visual review** — semantic classification of
  before/after diff (intentional / regression / accessibility / mixed /
  unreviewable) via Claude multimodal. `VisionJudge` interface +
  `ClaudeVisionJudge` default ship in `@conclave-ai/visual-review`.
  `runVisualReview` takes optional `judge` + `judgeContext`; CLI
  `--visual` flag auto-enables when `ANTHROPIC_API_KEY` is present.
  Judgment + structured concerns printed in review output. 15 test
  cases (judge parsing + orchestrator integration).
- **CLI `conclave migrate`** (decision #27) — brings an existing
  solo-cto-agent install over to conclave-ai without deleting the
  legacy install:
  - Auto-detects the legacy root by walking up from cwd or checking
    sibling `solo-cto-agent/` folder. `--from <path>` override.
  - Ports `failure-catalog.json` into conclave-ai's memory store (same
    heuristic mapper as `conclave seed`); tags entries with
    `["legacy", "solo-cto-agent", "migrated"]`.
  - Reads `.solo-cto/tracked.json` if present and prints tracked repo
    names for manual migration (tokens are NOT copied — audit required).
  - Writes `.conclaverc.json` with defaults if none exists.
  - Prints an env checklist (ANTHROPIC_API_KEY / OPENAI_API_KEY /
    GOOGLE_API_KEY / Telegram / Discord / Slack / Email / platform
    tokens / Langfuse) so users know what to carry over.
  - `--dry-run` flag to preview without writing.
  - 11 test cases: arg parsing (3), detectLegacy (3: happy / empty dir
    / tracked.json surfacing), findLegacyUpwards (2: sibling folder
    detection, null on isolated tree), buildPlan (3: willWriteConfig
    true on fresh cwd, false when config exists, trackedRepoNames
    surfaced), applyPlan (3: writes config + seeds 2 failures, skips
    config write when present, seeded=0 when no legacy catalog).
- **CLI `--visual` / `--no-visual` on `conclave review`** — completes the
  visual-diff story end-to-end from the CLI.
  - Config block `visual.{enabled, platforms[], width, height, fullPage,
    waitSeconds, diffThreshold}` in `.conclaverc.json`.
  - Flags override config for the run.
  - `buildPlatforms(ids)` factory lazy-imports adapters; missing env →
    skipped with stderr warning, never fatal. `deployment-status`
    always resolves (gh auth only).
  - Output block appended: severity / diff ratio / before+after URLs /
    local paths to the 3 PNGs.
  - Failure-tolerant: visual errors never affect the verdict exit code.
  - 6 platform-factory test cases.
- **`@conclave-ai/platform-cloudflare`** — Cloudflare Pages adapter via
  `GET /accounts/{id}/pages/projects/{name}/deployments`. Filters
  client-side by `deployment_trigger.metadata.commit_hash`; picks newest
  `latest_stage.status: "success"`. URL-encodes project name for
  projects with spaces. API `success: false` → throw with first error
  message. Env: `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` +
  `CLOUDFLARE_PROJECT_NAME`.
- **`@conclave-ai/platform-deployment-status`** — generic GitHub
  Deployments API adapter. Works with **any** host that posts back to
  GitHub (Render / Fly / Railway / Replit / Docker / custom CI) without
  a dedicated package. Uses `gh api /repos/{repo}/deployments?sha=<sha>`
  then resolves each candidate's status. Picks newest in an accepted
  state (default `["success"]`). URL fallback chain:
  `environment_url` → `target_url`. Optional `environment` filter.
  Intended LAST in platform chain — dedicated adapters come first.
- 19 test cases across Cloudflare + deployment-status covering env
  validation, commit matching, state filtering, URL fallback, newest-
  wins, error surfaces, URL encoding, empty results.
- **`@conclave-ai/visual-review`** — before/after visual diff package
  (decision #15 partial — pixelmatch default; odiff for v2.x speed
  upgrade):
  - `ScreenshotCapture` interface + `PlaywrightCapture` default
    implementation. Reuses a single Chromium across captures in the
    same process; fresh context per capture for isolation. Playwright
    is an OPTIONAL peer dep — users who never run visual review don't
    pay the ~300MB Chromium cost.
  - `VisualDiff` interface + `PixelmatchDiff` default implementation
    (pure JS, no native binary). `classifyDiffRatio(ratio)` maps into
    5 severity bands: identical / minor / significant / major /
    total-rewrite. Swap in an `odiff` adapter for 6–8× speed.
  - Size-mismatched images pad to max dimensions instead of throwing.
    Diff PNG shares inputs' dimensions; changed pixels highlighted red
    (configurable).
  - `runVisualReview({ platforms, repo, beforeSha, afterSha, … })`
    orchestrator:
    - Resolves before + after preview URLs via the Platform adapters
      from PR #17 (Vercel / Netlify / …). Walks platforms first-non-
      null-wins.
    - Captures both URLs sequentially via the configured capture
      engine.
    - Diffs via the configured diff engine.
    - Writes `before.png` / `after.png` / `diff.png` to
      `<outputDir>/` (default `.conclave/visual/<afterSha>/`).
    - Returns structured result: before/after PreviewResolution,
      paths, capture metadata, diff metrics + severity.
    - Missing before URL → throws with `beforeSha=...`. Missing after
      → throws with `afterSha=...`. Caller catches + logs + skips —
      visual failure never poisons the code review verdict.
    - Closes the default-created `PlaywrightCapture` in a `finally`
      block. User-supplied captures are the caller's responsibility.
  - 25 test cases across `diff` (identical → 0, completely different
    → 1, half-half ≈ 0.5, size-mismatch pads instead of throws, diff
    image dims, threshold sensitivity, classifyDiffRatio boundaries),
    `capture` (single launch across captures, viewport + DSF wiring,
    extraHTTPHeaders propagation, fullPage default + override,
    waitForSelector triggered, postLoadDelayMs=0 skips wait, finalUrl
    + viewport returned, close() + re-launch), and `orchestrator`
    (happy path 3 PNGs written, identical severity, missing before
    throws with actionable sha, missing after throws, default
    outputDir `.conclave/visual/<sha>`, user-supplied capture NOT
    closed by orchestrator, PreviewResolution metadata surfaced).

### Added
- **`Platform` interface in `@conclave-ai/core`** (decision #31: v2.0
  platform set). Contract: `resolve({ repo, sha, waitSeconds? })` →
  `{ url, provider, sha, deploymentId?, createdAt? } | null`. Missing
  auth / no match returns null; only auth errors and 5xx throw.
- **`resolveFirstPreview(platforms, input)`** helper — walks an ordered
  list; first non-null wins. Hard errors on one platform are logged to
  stderr but don't abort the walk (try the next one).
- **`@conclave-ai/platform-vercel`** — Vercel adapter over
  `/v6/deployments?meta-githubCommitSha=<sha>`. Picks newest READY
  deployment. Supports `VERCEL_TOKEN` + optional `VERCEL_TEAM_ID` +
  `VERCEL_PROJECT_ID`. `waitSeconds` polls every ~3s until deployment is
  ready or deadline hits.
- **`@conclave-ai/platform-netlify`** — Netlify adapter over
  `/api/v1/sites/{siteId}/deploys` filtered by `commit_ref`. URL fallback
  chain: `deploy_ssl_url` → `ssl_url` → `deploy_url`. Requires
  `NETLIFY_TOKEN` + `NETLIFY_SITE_ID`.
- 25 test cases across core (`resolveFirstPreview`: first-wins,
  throwing-platform-does-not-abort, all-null, empty list), Vercel (12:
  missing token throws, empty result → null, newest READY wins,
  BUILDING filtered, https-prefix passthrough, 401 throws, 5xx throws,
  404 null, teamId + projectId query params, bearer auth, waitSeconds
  polls until READY), and Netlify (9: missing token/siteId throws,
  newest ready matching commit_ref, non-matching ref filtered,
  non-ready filtered, URL fallback chain, bearer + siteId in URL, 401
  throws, 404 null).

### Added
- Monorepo skeleton (pnpm workspaces + turbo).
- `@conclave-ai/core`: `Agent` / `Council` interfaces + Zod schemas.
- `@conclave-ai/agent-claude`: Claude agent skeleton implementing `Agent`.
- `@conclave-ai/cli`: `conclave` binary with `init` and `review` commands (skeleton).
- `ARCHITECTURE.md`: locked 7-layer design for the council, efficiency gate,
  self-evolve substrate (answer-keys + failure-catalog), and migration path from solo-cto-agent.
- GitHub Actions CI: typecheck + build + test on push/PR.
- **Efficiency Gate** (`@conclave-ai/core/efficiency`) per decision #22 —
  first-class from day 1. Every LLM call must route through
  `EfficiencyGate.run(...)`; direct SDK calls are forbidden by contract.
  - `PromptCache` — Anthropic 5-min TTL aware scheduler (sha256-keyed, LRU-evicted).
  - `BudgetTracker` — $0.50 default per-PR cap (decision #20), throws
    `BudgetExceededError` on reserve-beyond-cap, warning handler at 80% default.
  - `triageReview` — lite (single agent) vs full (3-round council) classification.
    Risky paths (schema / migrations / auth / payments / `.sql` / prisma) always
    force full regardless of size.
  - `selectModel` — input-size routing: Haiku ≤ 8k tokens → Sonnet ≤ 50k →
    Gemini 2.5 Pro for long-context slot (override-able).
  - `compact` — round-to-round context compression (summarizer injected;
    pinned-message preservation; newest-first fit under budget).
  - `buildRelevanceContext` — diff + test-file + direct-import graph walk
    under a token budget (safe defaults when `readFile` / `importsOf` omitted).
  - `MetricsRecorder` — per-call cost / tokens / latency / cache-hit with
    per-agent + per-model aggregation; pluggable external sink for Langfuse.
  - `EfficiencyGate.run(...)` — orchestrates reserve → route → cache-check →
    execute → mark → commit → record in a single call.
- Test coverage (`node --test`): 9 files, 45+ test cases across all
  efficiency modules and Council outcome logic.
- **Real Claude review loop** in `@conclave-ai/agent-claude`:
  - `ClaudeAgent.review(ctx)` now issues a real `messages.create` call via
    the injected (or lazy-loaded) `@anthropic-ai/sdk` client.
  - Single-tool pattern (`tool_choice: { type: "tool", name: "submit_review" }`)
    forces structured output — no free-form parsing.
  - System prompt + RAG prefix sent as a cache-controlled ephemeral block
    so repeat calls within 5 minutes hit Anthropic's prompt cache (~90%
    input-cost savings on the prefix).
  - All SDK calls route through `EfficiencyGate.run(...)`: pre-flight budget
    reserve (throws before the network call), cache-liveness tracking,
    actual-cost metering via `actualCost(model, usage)`, per-call metrics.
  - `PRICING` table covers Sonnet 4.6 / Haiku 4.5 / Opus 4.7 with standard,
    cache-write, and cache-read rates. `estimateCallCost` is pessimistic
    (no cache assumed) for safe pre-flight reservation.
  - Parser tolerates malformed blockers (drops invalid entries instead of
    failing the whole review), throws on missing `submit_review` tool_use
    block or invalid verdict.
  - Agent-claude tests (16 cases): happy verdicts (approve / rework with
    blockers), invalid response shapes, budget enforcement, cache_control
    wire-format, tool_choice wire-format, missing-key constructor guard,
    metrics aggregation on shared gate.
- **Memory substrate** (`@conclave-ai/core/memory`) per decision #17 —
  answer-keys dualism as the core primitive.
  - Zod schemas for `EpisodicEntry`, `AnswerKey`, `FailureEntry`, `SemanticRule`
    with enum-validated domains (code / design), severity, and 11 failure categories.
  - `MemoryStore` interface (read + write + list) with a `FileSystemMemoryStore`
    implementation. Layout: `episodic/YYYY-MM-DD/pr-{n}.json` + `answer-keys/{domain}/{id}.json` +
    `failure-catalog/{domain}/{id}.json` + `semantic/rules.jsonl`. Lazy mkdir on
    write; missing dirs return `[]` on read.
  - Lightweight BM25-ish retrieval (keyword overlap + tag boost + repo boost)
    for the RAG path. No vector DB — corpus is O(100s), short text, keyword + tag
    ranking is sufficient to pilot the self-evolve loop. Vector embeddings slot
    in later as a pluggable scoring backend.
  - `formatAnswerKeyForPrompt` / `formatFailureForPrompt` helpers produce the
    short string form that agent-claude's `ReviewContext.answerKeys` / `failureCatalog`
    arrays expect — integration is already wired (no agent-claude change needed).
  - 23 test cases across schema validation (enum domains + categories), retrieval
    (query match, tag boost, repo boost, stop-word filter, Korean tokens,
    k respect, empty cases), and FS store round-trip (answer-keys, failures,
    rules JSONL append, episodic day-bucketing, missing-dir tolerance, domain
    filter, default k = 8).
- **`conclave review` is now end-to-end functional** — glues core + gate +
  memory + agent-claude through the CLI:
  - `conclave review --pr N` — fetches the PR diff + metadata via `gh pr diff`
    and `gh pr view`; review context includes the real repo slug, PR number,
    head SHA, and base SHA.
  - `conclave review --diff <file>` — reviews a local unified-diff file.
  - `conclave review` (no flag) — `git diff <base>..HEAD` (default base
    `origin/main`), parses the repo slug from `git remote get-url origin`.
  - Config auto-discovery: walks up from cwd looking for `.conclaverc.json`,
    validates with Zod, merges over defaults. Memory root resolved relative
    to the config directory unless absolute.
  - RAG wired: retrieves top-K answer-keys + failures from
    `FileSystemMemoryStore`, formats via `formatAnswerKeyForPrompt` /
    `formatFailureForPrompt`, threads them into `ReviewContext`.
  - Efficiency gate uses config-driven `budget.perPrUsd`; warning callback
    prints to stderr at 80% cap.
  - Output: pretty-printed per-agent verdict + blockers (severity-sorted) +
    summary + metrics block (calls / tokens / cost / latency / cache hit rate).
  - Exit codes: 0 (approve) / 1 (rework) / 2 (reject) for CI-friendly
    scripting.
  - 22 test cases across config loading (defaults, walk-up, malformed JSON,
    schema-invalid), diff-source (https/ssh/no-git URL parsing, gh pr
    happy path + missing-owner throw, git-diff with/without remote, file
    diff), and output rendering (all verdicts, severity sort, no-consensus
    tag, metrics formatting, exit-code mapping).
- **Outcome writer — self-evolve loop closure** (decision #17, write side):
  - `OutcomeWriter.writeReview(...)` persists an `EpisodicEntry` with
    `outcome: "pending"` at the end of every `conclave review` call.
  - `OutcomeWriter.recordOutcome({ episodicId, outcome })` updates the
    stored episodic entry (merged / rejected / reworked) and invokes a
    `Classifier` to produce `AnswerKey` (on merge) or `FailureEntry[]`
    (on reject/rework — one per unique blocker, nits excluded).
  - `RuleBasedClassifier` — deterministic extraction without an LLM.
    Pattern = `by-repo/<repo>`; tags derived from blocker categories;
    free-form category strings normalized to the 11 allowed enum values.
    Haiku-backed classifier is a future drop-in behind the same interface.
  - `MemoryStore.findEpisodic(id)` + FS walker so outcome can be recorded
    in a fresh process (review → close PR → merge can span sessions).
  - **CLI wired**: `conclave review` now prints the episodic id + a copy-paste
    `conclave record-outcome --id ... --result merged` instruction. New
    `conclave record-outcome` command closes the loop end-to-end.
  - 16 test cases: merged → single answer-key; rejected/reworked → one
    failure per unique blocker; nit exclusion; cross-agent dedup;
    category normalization (`"Type Error"` → `type-error`, `"a11y"` →
    `accessibility`, `"UNUSED IMPORT"` → `dead-code`); tag derivation;
    stable ids for same input; round-trip through disk; fresh-process
    reconstruction via `findEpisodic`; unknown-id throw; idempotent
    re-writes with caller-provided `episodicId`.
- **`@conclave-ai/agent-openai`** — second council voice (decision #28 —
  v2.0 launch council = Claude + OpenAI + Gemini):
  - `OpenAIAgent` wraps the `openai` SDK via a minimal `OpenAILike`
    client interface; default factory lazy-loads `openai` so tests never
    pay the SDK cost.
  - Strict `json_schema` response format (`name: "conclave_review"`,
    `strict: true`) per decision #12 — structured output is guaranteed
    well-formed without tool-use parsing.
  - Same efficiency-gate contract as agent-claude: pre-flight
    `budget.reserve`, cache-liveness mark, `actualCost(model, usage)`
    post-call, per-call metric recorded.
  - Pricing table for `gpt-4.1` / `gpt-4.1-mini` / `gpt-5` / `gpt-5-mini`
    / `o5`. Cached-input discount applied via
    `prompt_tokens_details.cached_tokens`.
  - Parser handles refusals, non-JSON content, invalid verdicts, and
    tolerates malformed blocker items (drops individually).
  - CLI `conclave review` now instantiates the agents listed in
    `config.agents`. Missing credentials for any agent skips that agent
    with a stderr warning rather than failing the review. At least one
    agent must resolve.
  - 15 test cases (`pricing.test.mjs` + `openai-agent.test.mjs`):
    pricing table coverage, cached-token discount vs fresh,
    unknown-model throw, pre-flight estimate; parse approve + rework
    flows, response_format shape assertion, refusal throw, invalid-JSON
    throw, invalid-verdict throw, no-key constructor throw, metrics
    aggregation, pre-flight budget short-circuits the network call.
- **`@conclave-ai/integration-email`** — fourth notification surface,
  completes decision #24's equal-weight set (CLI + Telegram + Discord +
  Slack + Email):
  - `EmailNotifier` implements `Notifier` using a pluggable
    `EmailTransport` interface. Default transport = `ResendTransport`
    (Resend REST API via native fetch; no SDK dependency).
  - Swap transports for SMTP (nodemailer) / SES / Postmark / SendGrid /
    Mailgun by passing `opts.transport` — the transport interface is
    `{ id, send({ from, to, subject, text, html }) }`.
  - Renders BOTH plaintext AND HTML bodies from the same source
    (`renderEmail(input)`). HTML uses inline styles only; no `<style>`
    blocks, no external stylesheets, email-client safe.
  - Subject: `[conclave] VERDICT — repo #N` (override with
    `subjectOverride`). Color-coded HTML headline (green/amber/red).
    HTML escapes `< > & "`.
  - Env: `RESEND_API_KEY` (default transport), `CONCLAVE_EMAIL_FROM`,
    `CONCLAVE_EMAIL_TO` (comma-separated multi-recipient support).
  - CLI `integrations.email.{enabled, from, to, subjectOverride}`.
    Single recipient (string) or array accepted.
  - 21 test cases across `format` (subject format with + without PR,
    text body lines, no-consensus tag, severity-sorted top-5 + `+N
    more`, footer cost + episodic id, HTML inline-styles-only
    enforcement, HTML-special-char escape, HTML PR link, color-coded
    verdict, no-blockers placeholder in both bodies) and `notifier`
    (missing RESEND_API_KEY throws, Resend POST wire shape, `to` array
    passthrough, non-200 throw; missing from + missing to throws,
    comma-separated env fallback, subjectOverride wins, custom
    transport plugs in, text + html both sent, Notifier interface
    conformance).
- **`@conclave-ai/integration-slack`** — third notification surface
  (decision #24, Block Kit format, webhook-based same as Discord):
  - `SlackNotifier` implements `Notifier`. Posts to a Slack incoming
    webhook using Block Kit layout (section + context + divider blocks).
  - URL validation restricts to `https://hooks.slack.com/services/...`.
  - Header section links to PR URL with Slack mrkdwn `<url|text>`
    syntax when supplied.
  - Per-agent sections show top-3 severity-sorted blockers + summary.
  - Footer context block carries cost + episodic id.
  - Fallback top-level `text` mirrors verdict + repo for mobile push
    notifications (where Block Kit won't render).
  - Slack-specific escaping for `< > &` on user-supplied strings.
  - Auto-truncates at Slack limits: block text 2900 chars, top-level
    text 1000 chars, ≤ 50 blocks total.
  - CLI `integrations.slack.{enabled, webhookUrl, username, iconUrl,
    iconEmoji}`. Env fallback: `SLACK_WEBHOOK_URL`. `iconUrl` wins over
    `iconEmoji` when both supplied.
  - 19 test cases across `format` (text fallback, mrkdwn link, no-
    consensus context, special-char escape, severity-sorted top-3 +
    `+N more`, footer cost+id, dividers bracket sections, 50-block cap,
    no-blockers placeholder, 2900-char truncation) and `notifier`
    (missing URL throws, non-Slack URL throws, POST + JSON shape,
    default username, iconUrl wins + iconEmoji alone, non-200 throw
    with body, SLACK_WEBHOOK_URL env fallback, Notifier interface
    conformance).
- **`@conclave-ai/integration-discord`** — second notification surface
  (decision #24, same `Notifier` pattern as Telegram):
  - `DiscordNotifier` implements `Notifier`. Posts to an incoming
    webhook — simpler than bot API (no token, no chat id — just the
    webhook URL).
  - URL validation: only accepts
    `https://discord.com/api/webhooks/…` or `discordapp.com` hosts.
  - Embed payload with color-coded verdict (green approve / amber
    rework / red reject), per-agent field showing top-3
    severity-sorted blockers + summary, footer with cost + episodic id,
    ISO timestamp. Auto-truncates title (256), description (4096),
    per-field value (1024), and caps at 24 agent-fields to stay under
    Discord's 25-field limit.
  - CLI `integrations.discord.{enabled, webhookUrl, username, avatarUrl}`.
    Env fallback: `DISCORD_WEBHOOK_URL`. Missing URL with explicit
    `enabled: true` → hard error. Otherwise skip with stderr warning.
  - 22 test cases across `format` (color per verdict, PR URL link,
    no-consensus tag, severity-sorted top-3 + `+N more`, file:line
    rendering, field-value truncation, footer cost+id, timestamp,
    no-blockers placeholder, 24-field cap with overflow) and `notifier`
    (missing URL throw, non-Discord URL throw, both discord.com /
    discordapp.com accepted, POST + JSON content-type shape, default
    username Conclave AI, username override, avatarUrl propagation,
    non-200 throws with status + snippet, DISCORD_WEBHOOK_URL env
    fallback, Notifier interface conformance).
- **Legacy failure-catalog seeding** (decision #18: port solo-cto-agent's
  `failure-catalog.json` directly; do not start from zero):
  - `LegacyCatalogSchema` + `LegacyEntrySchema` (Zod) validate the
    solo-cto-agent shape.
  - `mapLegacyCategory` — heuristic mapper from free-form legacy
    category + pattern + description to the 11 canonical enum values.
    Priority-ordered regex: type-error → missing-test → schema-drift →
    security → accessibility → contrast → performance → dead-code →
    regression → api-misuse → other.
  - `toFailureEntry(legacy, opts)` produces a canonical `FailureEntry`
    with a stable `id` (`fc-legacy-<legacyId>-<hash>` keyed on pattern),
    tags = `[legacyCategory, "legacy", "solo-cto-agent"]` by default,
    body = `<description> Fix: <fix>`.
  - `seedFromLegacyCatalog(rawJson, store, opts)` parses + derives +
    writes. `{ write: false }` returns entries without touching the
    store. `createdAt` inherits the catalog's `updated_at` normalized to
    ISO (YYYY-MM-DD → `T00:00:00.000Z`).
  - `seedFromLegacyCatalogPath(path, store, opts)` reads from disk.
  - **Bundled catalog** — `packages/core/src/memory/seeds/solo-cto-agent-failure-catalog.json`
    ships with `@conclave-ai/core`. Post-build script
    (`scripts/copy-seeds.mjs`) mirrors `src/memory/seeds/` →
    `dist/memory/seeds/` since tsc does not copy non-TS files.
  - **New CLI command `conclave seed [--from <path>]`** — zero-config
    seeding from the bundled catalog, or custom path. Prints
    per-category count (type-error=X, schema-drift=Y, ...) for auditing.
  - 15 test cases (`seeder.test.mjs`): 7 mapping rules (type-error,
    schema-drift, performance, dead-code, security, api-misuse, other
    fallback), id stability across calls, tag merge with legacy
    category + extras, body format, LegacyCatalogSchema accepts real
    shape + rejects wrong version, write round-trip + byCategory
    correctness, `{ write: false }` no-op, createdAt normalization from
    YYYY-MM-DD to ISO, bundled catalog smoke test (15 entries all tagged
    "solo-cto-agent").
- **`@conclave-ai/integration-telegram`** — first notification surface
  (decision #24 — Telegram / Discord / Slack / Email are equal-weight;
  none is hero):
  - `Notifier` interface added to `@conclave-ai/core`
    (`notifyReview(input)` contract). Pluggable — any future integration
    package implements this.
  - `TelegramClient`: thin native-fetch wrapper over Bot API sendMessage.
    No SDK dep; sub-200 lines; injectable `fetch` for tests.
  - `TelegramNotifier`: implements `Notifier`. Builds HTML-mode message
    with per-agent verdict + top-3 blockers (severity-sorted) + summary
    + footer (cost + episodic id). Inline action buttons emit
    `callback_data = "ep:<id>:<outcome>"` — future callback handler can
    call `OutcomeWriter.recordOutcome` directly.
  - Message formatter (`formatReviewForTelegram`): HTML-escapes `& < >`,
    links to PR URL when supplied, truncates to 4090 chars, shows
    `+N more` when blocker count exceeds 3.
  - CLI integration: new `.conclaverc.json` `integrations.telegram.{enabled, chatId, includeActionButtons}` block.
    `conclave review` fires the notifier after deliberation. Failures
    never affect the verdict exit code.
  - Env: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`. Missing credentials
    skip with stderr warning unless `integrations.telegram.enabled: true`
    is explicitly set — then it errors.
  - 21 test cases (`format`, `client`, `notifier`): HTML emoji header,
    PR URL anchor, HTML-special-char escaping (`<never>` → `&lt;never&gt;`,
    `a & b` → `a &amp; b`), severity-sorted top-3 + "+N more" counter,
    no-consensus tag, footer cost+id, 4096-char truncation, (no
    blockers) placeholder; `TelegramClient` rejects empty token, POST
    request shape assertion, `ok:false` throws with description + code,
    non-JSON response throws with status + snippet, baseUrl override;
    `TelegramNotifier` missing-token + missing-chatId throws,
    numeric-string chat id coercion, HTML parse_mode + disable_web_page_preview,
    inline keyboard present by default, includeActionButtons:false
    omits reply_markup, env fallback for TELEGRAM_BOT_TOKEN +
    TELEGRAM_CHAT_ID, `Notifier` interface conformance.
- **`@conclave-ai/observability-langfuse`** — first observability sink
  (decision #13 — self-hosted Langfuse):
  - `LangfuseMetricsSink` implements core's `MetricsSink`. Each per-call
    metric becomes a Langfuse `generation` with name = `review.<agent>`,
    model, input/output tokens, totalCost, cacheHit + latency in
    metadata, start/end times derived from `timestamp - latencyMs`.
  - Self-hosted is the intended deployment (baseUrl override); cloud
    identical. LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY required.
  - Fire-and-forget on `record()` per the synchronous MetricsSink
    contract; Langfuse SDK's internal queue handles HTTP. Errors
    captured + logged to stderr so observability failures never kill
    the review.
  - `setTraceId(id)` groups all metrics in a single review under one
    Langfuse trace. `flush()` / `shutdown()` for clean exit.
  - CLI integration: new `observability.langfuse.{enabled, baseUrl?}`
    config block. `conclave review` wires the sink when
    `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` env are set; trace
    id = `conclave-<owner>-<repo>-<pr>-<sha8>`. Sink flushed before
    process exit.
  - 10 sink tests: generation params mapping, metadata for cacheHit +
    latency, start/end time derivation, traceId static + dynamic
    (setTraceId between records), error-swallowing on client throw,
    flush + shutdown paths (shutdownAsync preferred, flushAsync
    fallback), lazy one-shot client factory init.
- **`@conclave-ai/scm-github`** — GitHub SCM adapter + automatic outcome
  capture (closes the manual `record-outcome` gap):
  - `fetchPrState(repo, prNumber)` wraps `gh pr view` to resolve current
    state / merge SHA / head SHA / updatedAt. No GitHub token needed in
    conclave's config — relies on `gh auth login` which `conclave
    review --pr N` already requires.
  - `classifyTransition(state, reviewedSha)` maps live PR state to the
    outcome vocabulary used by `OutcomeWriter.recordOutcome`:
    merged → `merged`, closed w/o merge → `rejected`, open with new head
    commits since review → `reworked`, open with unchanged head →
    `pending`.
  - `pollOutcomes({ store, writer })` walks pending episodic entries,
    fetches each PR's state, applies classification + writes catalog
    records. gh errors per-PR are counted and surfaced without aborting
    the scan.
  - `MemoryStore.listEpisodic()` added; FS implementation walks
    `episodic/*/` buckets. Required by the pending-entry filter so
    polling is a single pass over disk.
  - **New CLI command `conclave poll-outcomes`** — cron-friendly
    auto-classification. Prints a summary line (scanned / merged /
    rejected / reworked / pending / errors) plus per-PR detail for
    anything that transitioned.
  - 20 test cases across `pr-state.test.mjs` (open / merged / closed
    mapping, merge-commit sha capture, unknown-state throw, missing
    headRefOid throw, gh arg shape assertion, all 4 classifyTransition
    rules) and `poll-runner.test.mjs` (empty store, merged → AnswerKey,
    closed → FailureEntry, reworked with advanced head → FailureEntry,
    same-head no-op, pullNumber=0 local review skipped, gh errors
    counted but scan continues, already-resolved entries not re-polled,
    listPendingEpisodics correctness).
- **`@conclave-ai/agent-gemini`** — third council voice, long-context slot
  (decision #10: Gemini 2.5 Pro as the >50K input tokens handler, flash
  as triage. Deep Think skipped as Ultra-tier overkill):
  - `GeminiAgent` wraps `@google/genai` via a minimal `GenAILike` client
    interface. Lazy-loaded default factory.
  - Structured output via `config.responseMimeType: "application/json"`
    + `config.responseSchema` in OpenAPI-3-subset shape (Gemini
    specifics: no `additionalProperties`; nullable via `nullable: true`).
  - Cacheable prefix sent as `systemInstruction` — Gemini's context
    cache bills the system part separately (75% discount on 2.5 family).
  - Same efficiency-gate contract: pre-flight reserve, cache-liveness
    mark, `actualCost(model, usage)` via `usageMetadata.cachedContentTokenCount`,
    per-call metric.
  - Env resolution: `GOOGLE_API_KEY` first, `GEMINI_API_KEY` fallback.
  - Pricing table for `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-3.0-flash`
    with max-context-tokens metadata for router use.
  - Parser handles empty content with finishReason surfaced, invalid
    JSON, invalid verdict, malformed blockers dropped individually.
  - CLI `conclave review` instantiates Gemini when `config.agents`
    includes `"gemini"` and `GOOGLE_API_KEY` / `GEMINI_API_KEY` is set;
    otherwise skips with a stderr warning.
  - 17 test cases across `pricing.test.mjs` (tiers present, baseline,
    75% cached discount on 2.5-pro, 8× flash/pro ratio, unknown-model
    throw, pre-flight estimate, `maxContextTokens` populated) and
    `gemini-agent.test.mjs` (approve + rework flows, malformed blocker
    drops, responseMimeType + responseSchema wire assertions,
    systemInstruction parts shape, cached-token cost discount,
    empty-text-with-finishReason throw, invalid-JSON throw,
    invalid-verdict throw, no-key constructor throw, GEMINI_API_KEY
    fallback when GOOGLE_API_KEY unset, pre-flight budget short-circuit).
