import { FileSystemMemoryStore, OutcomeWriter } from "@ai-conclave/core";
import { pollOutcomes } from "@ai-conclave/scm-github";
import { loadConfig, resolveMemoryRoot } from "../lib/config.js";

const HELP = `conclave poll-outcomes — auto-classify pending reviews against GitHub PR state

Usage:
  conclave poll-outcomes [--quiet]

Scans the memory store for episodic entries with outcome="pending" and
calls \`gh pr view\` on each. Transitions are classified as:
  merged PR                      → outcome=merged   → AnswerKey written
  closed PR (not merged)         → outcome=rejected → FailureEntry per blocker
  open PR with new head commits  → outcome=reworked → FailureEntry per blocker
  open PR, head unchanged        → pending (no-op)

Requires 'gh auth login'. Safe to run on a cron.
`;

function parseArgv(argv: string[]): { quiet: boolean; help: boolean } {
  return {
    quiet: argv.includes("--quiet"),
    help: argv.includes("--help") || argv.includes("-h"),
  };
}

export async function pollOutcomesCommand(argv: string[]): Promise<void> {
  const args = parseArgv(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }

  const { config, configDir } = await loadConfig();
  const memoryRoot = resolveMemoryRoot(config, configDir);
  const store = new FileSystemMemoryStore({ root: memoryRoot });
  const writer = new OutcomeWriter({ store });

  const summary = await pollOutcomes({ store, writer });

  if (!args.quiet) {
    process.stdout.write(
      `conclave poll-outcomes:\n` +
        `  scanned:    ${summary.scanned}\n` +
        `  merged:     ${summary.merged}\n` +
        `  rejected:   ${summary.rejected}\n` +
        `  reworked:   ${summary.reworked}\n` +
        `  pending:    ${summary.pending}\n` +
        `  errors:     ${summary.errors}\n`,
    );
    for (const r of summary.results) {
      if (r.error) {
        process.stderr.write(`  ${r.episodicId} (${r.repo}#${r.prNumber}): error — ${r.error}\n`);
      } else if (r.wrote) {
        process.stdout.write(`  ${r.episodicId} (${r.repo}#${r.prNumber}): ${r.classification}\n`);
      }
    }
  }

  // Exit code: 0 if scan succeeded (errors-per-PR counted separately);
  // 1 if no episodic entries were found (likely misconfigured).
  if (summary.scanned === 0) {
    process.stderr.write(
      "conclave poll-outcomes: no episodic entries in memory store — run `conclave review` first.\n",
    );
    process.exit(1);
    return;
  }
}
