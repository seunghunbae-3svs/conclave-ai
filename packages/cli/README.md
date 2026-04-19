# @conclave-ai/cli

The `conclave` command-line interface for Conclave AI.

Skeleton status: `init` and `review` wired end-to-end through the core
skeleton. Real PR discovery, efficiency gate, memory write-back, and
notification dispatch land in later PRs.

## Install

```bash
pnpm add -g @conclave-ai/cli
# or
npm install -g @conclave-ai/cli
```

## Commands

```
conclave init                Write .conclaverc.json in the current repo
conclave review [--pr N]     Run a council review (skeleton)
conclave --help              Show help
conclave --version           Show version
```
