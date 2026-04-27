import { init } from "./commands/init.js";
import { review } from "./commands/review.js";
import { audit } from "./commands/audit.js";
import { config } from "./commands/config.js";
import { recordOutcome } from "./commands/record-outcome.js";
import { rework } from "./commands/rework.js";
import { autofix } from "./commands/autofix.js";
import { pollOutcomesCommand } from "./commands/poll-outcomes.js";
import { seed } from "./commands/seed.js";
import { migrate } from "./commands/migrate.js";
import { scores } from "./commands/scores.js";
import { sync } from "./commands/sync.js";
import { mcpServer } from "./commands/mcp-server.js";
import { repos } from "./commands/repos.js";
import { watch } from "./commands/watch.js";
import { doctor } from "./commands/doctor.js";
import { status } from "./commands/status.js";
import { CLI_VERSION } from "./version.js";
import { hydrateEnvFromStorage } from "./lib/credentials.js";

const HELP = `conclave — Conclave AI CLI

Usage:
  conclave <command> [options]

Commands:
  init                  Set up conclave in the current repo (config + skeleton)
  config                Persistent per-user credential storage — set API keys once (v0.7.4)
  audit                 Full-project health check across the current codebase (v0.6+)
  review                Run a council review on the current branch
  rework                Apply a worker-generated patch for a pending council "rework" verdict
  autofix               Autonomous fix loop — council verdict → patch → build → test → commit (v0.7)
  record-outcome        Record a PR's merge/reject/rework outcome manually
  poll-outcomes         Auto-classify pending reviews against live GitHub PR state
  seed                  Bootstrap failure-catalog from a legacy source (default: bundled solo-cto-agent)
  migrate               Port a solo-cto-agent install over to conclave-ai (config + failure-catalog + checklist)
  scores                Show per-agent performance scores from memory (decision #19)
  sync                  Exchange k-anonymous baseline signal with a federation endpoint (decision #21, opt-in)
  mcp-server            Run an MCP stdio server exposing conclave's memory to Claude Desktop / Cursor / Windsurf (decision #11)
  repos                 Manage the multi-repo watch list (v0.12)
  watch                 Local daemon — poll watched repos for new PRs and dispatch reviews (v0.12)
  doctor                Diagnose env keys / worker health / workflow pin / CLI freshness (v0.13.7)
  status                One-line install summary (bot / webhook / chats / recent cycles) — pass --verbose for breakdown (v0.13.16)
  --help, -h            Show this
  --version, -v         Show version

Examples:
  conclave init
  conclave config                         # one-time interactive setup — stores API keys persistently (v0.7.4)
  conclave config list                    # show which keys are set and where
  conclave audit                          # run right after init — full-project health check
  conclave audit --dry-run --scope ui     # preview which files would be audited
  conclave review --pr 42 --visual
  conclave rework --pr 42                 # apply worker patch for the latest pending review on PR 42
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
    process.stdout.write(`${CLI_VERSION}\n`);
    return;
  }

  // v0.7.4 — hydrate process.env from stored credentials BEFORE any
  // command runs so downstream packages that still read `process.env`
  // directly (integration-telegram's CONCLAVE_TOKEN check, visual-review
  // judge, etc.) see the stored value. Env vars always win — this only
  // fills blanks. `config` commands skip hydration so `list` / `get`
  // can tell apart env-vs-stored precedence honestly.
  if (cmd !== "config") {
    try {
      hydrateEnvFromStorage();
    } catch {
      // Never block a command start on credential-file issues.
    }
  }

  switch (cmd) {
    case "init":
      await init(rest);
      return;
    case "config":
      await config(rest);
      return;
    case "audit":
      await audit(rest);
      return;
    case "review":
      await review(rest);
      return;
    case "rework":
      await rework(rest);
      return;
    case "autofix":
      await autofix(rest);
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
    case "scores":
      await scores(rest);
      return;
    case "sync":
      await sync(rest);
      return;
    case "mcp-server":
      await mcpServer(rest);
      return;
    case "repos":
      await repos(rest);
      return;
    case "watch":
      await watch(rest);
      return;
    case "doctor":
      await doctor(rest);
      return;
    case "status":
      await status(rest);
      return;
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
      process.exit(2);
  }
}
