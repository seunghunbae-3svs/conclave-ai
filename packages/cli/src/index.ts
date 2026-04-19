import { init } from "./commands/init.js";
import { review } from "./commands/review.js";
import { recordOutcome } from "./commands/record-outcome.js";
import { pollOutcomesCommand } from "./commands/poll-outcomes.js";

const HELP = `conclave — Ai-Conclave CLI

Usage:
  conclave <command> [options]

Commands:
  init                  Set up conclave in the current repo (config + skeleton)
  review                Run a council review on the current branch
  record-outcome        Record a PR's merge/reject/rework outcome manually
  poll-outcomes         Auto-classify pending reviews against live GitHub PR state
  --help, -h            Show this
  --version, -v         Show version

Examples:
  conclave init
  conclave review --pr 42
  conclave record-outcome --id ep-... --result merged
  conclave poll-outcomes                 # cron-friendly automatic outcome capture
`;

export async function run(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;

  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    process.stdout.write(HELP);
    return;
  }

  if (cmd === "--version" || cmd === "-v") {
    process.stdout.write("0.0.0\n");
    return;
  }

  switch (cmd) {
    case "init":
      await init(rest);
      return;
    case "review":
      await review(rest);
      return;
    case "record-outcome":
      await recordOutcome(rest);
      return;
    case "poll-outcomes":
      await pollOutcomesCommand(rest);
      return;
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
      process.exit(2);
  }
}
