# @conclave-ai/secret-guard

Pre-commit secret scanner. Takes a unified diff or raw text, returns a list of findings plus a `blocked` flag.

Used by `conclave rework` before `git apply` — if the worker's patch contains an API key lifted from a file snapshot, the commit is refused.

## Usage

```ts
import { scanPatch } from "@conclave-ai/secret-guard";

const result = scanPatch(workerOutcome.patch);
if (result.blocked) {
  for (const f of result.findings) console.error(formatFinding(f));
  throw new Error("secret-guard: worker patch contains secrets");
}
```

## Design

- **High-confidence rules block by default.** AWS keys, Anthropic/OpenAI keys, GitHub PATs, Slack/Discord/Telegram webhook URLs, PEM private keys — every one a format where a match is almost certainly a real secret.
- **Medium / low confidence rules are opt-in** via `includeLowConfidence: true`. JWTs are medium (sometimes public); generic `password = "…"` is low (huge false-positive surface).
- **Patches scan only added lines.** Context lines and deletions can't introduce a new secret, and flagging them would spam any PR that touches a file containing an existing token.
- **Findings are redacted by default.** Only the first 4 + last 4 chars of the match survive — no finding ever has to be stringified with the raw secret.
- **Zero runtime dependencies.** Pure regex + string split. Tests are deterministic.

## Adding a rule

Append to `DEFAULT_RULES` in `src/rules.ts`. Rules have stable `id`s — callers can allow-list with `{ allow: ["id-to-skip"] }`.

Rules must NOT use `/g`, `/y`, or `/m` flags (the scanner iterates itself). If your pattern needs to name the secret (labelled assignment), put the raw secret in capture group 1 — the scanner uses it for redaction.
