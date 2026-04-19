import { init } from "./commands/init.js";
import { review } from "./commands/review.js";
import { recordOutcome } from "./commands/record-outcome.js";
import { pollOutcomesCommand } from "./commands/poll-outcomes.js";
import { seed } from "./commands/seed.js";
import { migrate } from "./commands/migrate.js";

const HELP = `conclave — Ai-Conclave CLI

Usage:
  conclave <command> [options]

Commands:
  init                  Set up conclave in the current repo (config + skeleton)
  review                Run a council review on the current branch
  record-outcome        Record a PR's merge/reject/rework outcome manually
  poll-outcomes         Auto-classify pending reviews against live GitHub PR state
  seed                  Bootstrap failure-catalog from a legacy source (default: bundled solo-cto-agent)
  migrate               Port a solo-cto-agent install over to ai-conclave (config + failure-catalog + checklist)
  --help, -h            Show this
  --version, -v         Show version

Examples:
  conclave init
  conclave review --pr 42 --visual
  conclave record-outcome --id ep-... --result merged
  conclave poll-outcomes                 # cron-friendly automatic outcome capture
  conclave seed                           # one-time bootstrap from the bundled solo-cto-agent catalog
  conclave migrate --dry-run              # preview migration from solo-cto-agent
  conclave migrate --from ../solo-cto-agent
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
    case "seed":
      await seed(rest);
      return;
    case "migrate":
      await migrate(rest);
      return;
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
      process.exit(2);
  }
}
