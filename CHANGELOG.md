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
