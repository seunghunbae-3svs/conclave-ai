# Federated sync — privacy model + protocol

Decision #21. **Opt-in.** Off by default.

## What leaves your machine

Exactly this shape (Zod-enforced at the source):

```jsonc
{
  "version": 1,
  "kind": "failure",              // or "answer-key"
  "contentHash": "sha256 hex, 64 chars",
  "domain": "code",               // or "design"
  "category": "security",         // failure-only
  "severity": "blocker",          // failure-only: blocker | major | minor
  "tags": ["auth", "jwt"],        // normalized: trim + lowercase + dedupe + sort
  "dayBucket": "2026-04-19"       // raw timestamp discarded
}
```

## What does NOT leave

Nothing else. Specifically:

- ❌ `lesson` (answer-key natural-language distillation)
- ❌ `title` / `body` / `snippet` (failure-entry details)
- ❌ `seedBlocker` (original blocker object with file + line)
- ❌ `pattern` (e.g. `by-pattern/auth-middleware`)
- ❌ `repo` / `user` — user-identifying strings
- ❌ `episodicId` — links back to your local episodic log
- ❌ `id` — your local sha-prefix identifiers
- ❌ Any diff content, commit message, or code snippet

The redactor (`packages/core/src/federated/redact.ts`) is a pure
function. You can run `conclave sync --dry-run --json` at any time to
see the exact payload that would be uploaded, offline, without touching
the network.

## The hash

```
contentHash = sha256(JSON.stringify([
  kind,                    // "answer-key" | "failure"
  domain,                  // "code" | "design"
  category ?? "",          // failure-only; empty string for answer-keys
  severity ?? "",          // failure-only
  sortedNormalizedTags     // e.g. ["auth", "jwt", "security"]
]))
```

Properties:
- **Deterministic.** Same 5-tuple across users → same hash. A
  federation server aggregates by hash to count frequency without
  seeing any individual contribution's content.
- **K-anonymous.** Many users reviewing auth-related security blockers
  produce the same hash. The server sees "this hash was seen 487
  times" — not "user X reviewed this PR".
- **Unreversible in practice.** SHA-256 over a 5-tuple of enumerated
  values. A motivated attacker could brute-force the tag vocabulary
  space, but there's nothing useful at the end of that attack — the
  input is itself public vocabulary.

## The wire

Thin JSON contract — no vendor SDK. Community-hosted aggregators can
implement it in any language.

### Push

```
POST {endpoint}/baselines
Content-Type: application/json
Authorization: Bearer <AI_CONCLAVE_FEDERATION_TOKEN>   // optional

{
  "baselines": [
    { "version": 1, "kind": "failure", "contentHash": "...", ... },
    ...
  ]
}

→ 200 { "accepted": 12 }
```

Servers MAY dedupe (return `accepted` < input length).

### Pull

```
GET {endpoint}/baselines?since=<ISO-8601>
Authorization: Bearer <...>     // optional

→ 200 { "baselines": [...] }
```

`since` is optional; omit to get all available.

### Errors

- `401` / `403` → auth failure; the HTTP transport throws.
- `5xx` → server error; throws with a truncated body for diagnostics.
- `404` → server has nothing for your query; throws (not null —
  treated as a hard error distinct from "empty but valid" response).

## Schema version

`version: 1` is literal. Servers MUST reject unknown versions to
prevent silent data shape drift. Bumping the version is the single
breaking-change lever for the federation protocol.

## Enabling

In `.conclaverc.json`:

```json
{
  "federated": {
    "enabled": true,
    "endpoint": "https://baseline.your-org.example"
  }
}
```

Optional auth:

```bash
export AI_CONCLAVE_FEDERATION_TOKEN=...
```

Then run:

```bash
# See the payload first (zero network I/O):
conclave sync --dry-run --json

# Actual round-trip:
conclave sync

# Upload only, don't pull:
conclave sync --push-only

# Download only, don't upload:
conclave sync --pull-only

# Delta pull:
conclave sync --since 2026-04-19T00:00:00Z
```

## What the pulled baselines are FOR

`conclave sync` persists pulled baselines to
`.conclave/federated/baselines.jsonl` (JSONL, deduped by `contentHash`).
`conclave review` reads that cache when `federated.enabled = true` and
boosts local retrieval by federated frequency.

Boost mechanics (`packages/core/src/federated/frequency.ts`):

```
factor = 1 + min(1, log2(1 + freq) / log2(1 + saturationAt)) * (boost - 1)
```

- Default `boost = 2.0`, `saturationAt = 256`.
- Docs with zero federated matches keep their original score (factor = 1).
- Logarithmic so "seen 10,000×" doesn't drown out "seen 100×" — it just
  moves ahead.

A local answer-key or failure that shares `(kind, domain, category,
severity, normalized-tags)` with a federated baseline gets this boost.
Hash parity is computed with `hashAnswerKey` / `hashFailure`, which
use the same `computeBaselineHash` that redaction uses — guarantees
the match semantics stay identical across the pipeline.

## Opting out

Three independent off-switches:

1. **Don't configure it.** If `federated.enabled` is absent or `false`,
   the CLI uses `NoopFederatedSyncTransport` — zero network I/O, zero
   redaction, zero payload.
2. **Don't run `conclave sync`.** Nothing in the normal `review` path
   touches federation. Opt-in is a separate command.
3. **Disable the CLI command.** Remove it from your shell history /
   CI / cron. There is no background thread or scheduled worker; sync
   runs only when invoked.

## If you audit the code

Start here:

- `packages/core/src/federated/schema.ts` — the only shape that leaves.
- `packages/core/src/federated/redact.ts` — `redactAnswerKey` /
  `redactFailure` / `redactAll`. Pure, synchronous, no I/O.
- `packages/core/src/federated/transport.ts` — the HTTP wire. No state
  beyond endpoint + token.
- `packages/core/src/federated/sync.ts` — orchestrator.
  `runFederatedSync` ONLY hands `FederatedBaseline[]` (the redacted
  shape) to the transport. The transport never sees raw memory.

Any deviation from this flow is a bug.
