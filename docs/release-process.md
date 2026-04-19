# Release process

All 18 packages version-bump + publish in lockstep (monorepo pre-1.0
policy). The `.github/workflows/release.yml` GitHub Action does the
work — you almost never run `npm publish` locally.

## Prerequisites (one-time)

- `NPM_TOKEN` secret on the GitHub repo — Automation-type token scoped
  to the `@conclave-ai` org with Publish permission. Rotate annually.
- Workflow permissions: `Settings → Actions → General → Workflow
  permissions` set to **Read and write** (needed for the commit + tag
  the workflow pushes back to `main`).
- Manual (`workflow_dispatch`) runs are **gated to `main`**. The
  workflow fails fast with an actionable error if dispatched from a
  feature branch — guards against accidentally pushing that branch
  into `main` via the release pipeline.

## Option A — Ship from the GitHub UI (recommended)

1. `Actions → release → Run workflow`.
2. Branch: `main`.
3. Bump: `patch` (bug fix), `minor` (backward-compat feature), or
   `major` (breaking change).
4. Click **Run workflow**.

What it does:
- Checks out `main`.
- Runs `pnpm install --frozen-lockfile`, `typecheck`, `build`, `test`.
- Bumps every package under `packages/*` via
  `pnpm -r exec npm version <bump> --no-git-tag-version`.
- Commits `chore(release): v<new-version>` + tags `v<new-version>` +
  pushes both back to `main`.
- Publishes every package via `pnpm publish -r --access public`
  with `NPM_CONFIG_PROVENANCE=true` (signed attestations on each
  tarball).

## Option B — Cut the tag locally

Use this when you want to review + commit the version bump manually
before releasing.

```bash
pnpm -r --filter "./packages/*" exec npm version patch --no-git-tag-version
git add -A
git commit -m "chore(release): v0.1.1"
git tag v0.1.1
git push origin main
git push origin v0.1.1
```

The tag push triggers the workflow's second path — it skips the bump
step (already done) and goes straight to publish.

## Verification

After the workflow finishes:

```bash
npm view @conclave-ai/core versions --json   # should show the new version
npm view @conclave-ai/cli version            # should match
```

Every package publishes in lockstep, so checking core + cli is enough
to confirm the release landed.

## Troubleshooting

- **Workflow fails at "Publish to npm" with 401/403** → `NPM_TOKEN`
  secret is missing, expired, or doesn't have `@conclave-ai` scope.
- **Workflow fails at bump commit push** → repo workflow permissions
  aren't "Read and write." Fix in repo settings.
- **`pnpm publish -r` skips a package** → probably already published
  at that version. pnpm silently no-ops rather than fail, which is
  correct for re-runs.
