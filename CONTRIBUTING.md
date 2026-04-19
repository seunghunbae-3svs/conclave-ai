# Contributing to Conclave AI

Thanks for taking an interest. The repo is small and opinionated — a
PR is easiest to accept when it matches the conventions here.

## Local setup

```bash
git clone https://github.com/seunghunbae-3svs/conclave-ai
cd conclave-ai
pnpm install
pnpm build
pnpm test
```

Requires Node ≥ 20 and pnpm ≥ 9 (via `corepack prepare pnpm@10 --activate`).

## Ground rules

1. **`ARCHITECTURE.md` is locked.** The 34 decisions frozen on
   2026-04-19 shouldn't be re-litigated casually. If a PR needs to
   diverge from a decision, the PR description must name the decision
   number and make the case. Current divergences + "what would trigger
   revisit" live in [docs/decision-status.md](docs/decision-status.md).

2. **One package, one responsibility.** New behavior goes in an
   existing package when it extends that package's responsibility; in
   a new package otherwise. No "utility" or "common" packages — those
   become dumping grounds.

3. **Zod schemas at external boundaries.** Anything that crosses a
   wire (HTTP body, file format, CLI input) validates via Zod. Don't
   trust `as` casts at the edge.

4. **Tests alongside the code.** Every `packages/X/src/*` change
   lands with a corresponding `packages/X/test/*.test.mjs` update.
   Use `node --test` (no Jest / Vitest). Mock at the seam (e.g.,
   inject `fetch`, `spawn`, LLM clients) so tests don't hit the
   network.

5. **Don't touch published package semantics without a version bump.**
   Breaking changes wait for a `major` bump; additive changes get a
   `minor`; bug fixes get a `patch`. Version bumps are lockstep
   across all packages via the release workflow.

## PR flow

1. Branch from `main`. No direct pushes.
2. Make the change + tests + changelog entry under `## Unreleased`.
3. `pnpm build && pnpm test` locally.
4. Open PR, wait for CI to go green.
5. The council reviews its own PRs — `conclave review --pr <N>`
   blockers are considered alongside human feedback.

## Release flow

See [docs/release-process.md](docs/release-process.md). Shipping from
this repo goes through the `release.yml` GitHub Action — never run
`npm publish` from a laptop.

## Scope of this repo

**In scope:** the 18 workspace packages, the docs under `docs/`, the
CI workflows, the architecture + decisions files.

**Out of scope:** a hosted service around Conclave AI (that would be
a separate repo). A web dashboard for reviews (also separate). Plugins
for IDEs other than via MCP (MCP is the integration story).

## When in doubt

Look at how similar packages are shaped (e.g., if you're adding a
platform adapter, mirror `packages/platform-railway`). Consistency
across the monorepo is the point of the monorepo.

## License

MIT — same as the project.
