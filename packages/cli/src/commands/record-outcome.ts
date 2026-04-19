import { FileSystemMemoryStore, OutcomeWriter, type OutcomeResult } from "@conclave-ai/core";
import { loadConfig, resolveMemoryRoot } from "../lib/config.js";

const HELP = `conclave record-outcome — close the self-evolve loop

Usage:
  conclave record-outcome --id <episodic-id> --result merged|rejected|reworked

On merged PRs, a new answer-key is derived from the review summary.
On rejected / reworked PRs, a failure-catalog entry is derived per
unique blocker (ignoring nits).
`;

function parseArgv(argv: string[]): { id?: string; result?: OutcomeResult; help: boolean } {
  const out: { id?: string; result?: OutcomeResult; help: boolean } = { help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--id" && argv[i + 1]) {
      out.id = argv[i + 1];
      i += 1;
    } else if (a === "--result" && argv[i + 1]) {
      const r = argv[i + 1];
      if (r === "merged" || r === "rejected" || r === "reworked") out.result = r;
      i += 1;
    }
  }
  return out;
}

export async function recordOutcome(argv: string[]): Promise<void> {
  const args = parseArgv(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (!args.id) {
    process.stderr.write("conclave record-outcome: --id is required\n\n" + HELP);
    process.exit(2);
    return;
  }
  if (!args.result) {
    process.stderr.write("conclave record-outcome: --result must be merged|rejected|reworked\n\n" + HELP);
    process.exit(2);
    return;
  }

  const { config, configDir } = await loadConfig();
  const memoryRoot = resolveMemoryRoot(config, configDir);
  const store = new FileSystemMemoryStore({ root: memoryRoot });
  const writer = new OutcomeWriter({ store });

  const output = await writer.recordOutcome({ episodicId: args.id, outcome: args.result });

  process.stdout.write(
    `conclave record-outcome:\n` +
      `  episodic:     ${args.id}\n` +
      `  outcome:      ${args.result}\n` +
      `  answer-keys:  ${output.answerKeys.length} written\n` +
      `  failures:     ${output.failures.length} written\n`,
  );
}
