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
