# Changelog

## Unreleased

### Added
- Monorepo skeleton (pnpm workspaces + turbo).
- `@ai-conclave/core`: `Agent` / `Council` interfaces + Zod schemas.
- `@ai-conclave/agent-claude`: Claude agent skeleton implementing `Agent`.
- `@ai-conclave/cli`: `conclave` binary with `init` and `review` commands (skeleton).
- `ARCHITECTURE.md`: locked 7-layer design for the council, efficiency gate,
  self-evolve substrate (정답지 + 오답지), and migration path from solo-cto-agent.
- GitHub Actions CI: typecheck + build + test on push/PR.
- **Efficiency Gate** (`@ai-conclave/core/efficiency`) per decision #22 —
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
- **Real Claude review loop** in `@ai-conclave/agent-claude`:
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
- **Memory substrate** (`@ai-conclave/core/memory`) per decision #17 —
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
- **`@ai-conclave/agent-openai`** — second council voice (decision #28 —
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
- **`@ai-conclave/integration-slack`** — third notification surface
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
- **`@ai-conclave/integration-discord`** — second notification surface
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
    username Ai-Conclave, username override, avatarUrl propagation,
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
    ships with `@ai-conclave/core`. Post-build script
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
- **`@ai-conclave/integration-telegram`** — first notification surface
  (decision #24 — Telegram / Discord / Slack / Email are equal-weight;
  none is hero):
  - `Notifier` interface added to `@ai-conclave/core`
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
- **`@ai-conclave/observability-langfuse`** — first observability sink
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
- **`@ai-conclave/scm-github`** — GitHub SCM adapter + automatic outcome
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
- **`@ai-conclave/agent-gemini`** — third council voice, long-context slot
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
