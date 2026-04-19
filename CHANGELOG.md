# Changelog

## Unreleased

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
  self-evolve substrate (정답지 + 오답지), and migration path from solo-cto-agent.
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
  정답지 / 오답지 dualism as the core primitive.
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
