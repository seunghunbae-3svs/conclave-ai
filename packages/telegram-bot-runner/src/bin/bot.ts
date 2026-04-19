#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { runBotOnce } from "../bot-runner.js";
import type { Outcome } from "../types.js";

const HELP = `conclave-telegram-bot — one-shot long-poll → repository_dispatch runner

Usage:
  conclave-telegram-bot --repo <owner/name> [--offset-file <path>] [--poll-timeout <seconds>]
                        [--allow merged,reworked,rejected] [--no-ack]

Flags:
  --repo <owner/name>     Required. Destination repo for repository_dispatch events.
  --offset-file <path>    JSON file used to persist the last-seen update_id. Default: ./.telegram-bot-offset.json
  --poll-timeout <s>      Long-poll timeout passed to getUpdates. Default: 25.
  --allow <list>          Comma-separated allow-list of outcomes (merged, reworked, rejected).
  --no-ack                Skip Telegram's answerCallbackQuery step (useful in dry-run).
  --help, -h              Show this message.

Environment:
  TELEGRAM_BOT_TOKEN      Required. The bot that users click the inline buttons on.
  GH_TOKEN / GITHUB_TOKEN Required for \`gh api\` — a token with actions:write on the target repo.

Design note: this process runs for one cycle and exits. Schedule it with
GH Actions (\`schedule: */1 * * * *\`) so each minute picks up whatever's
queued. The offset is persisted to a small JSON file so consecutive runs
don't double-process the same update.
`;

interface BinArgs {
  repo?: string;
  offsetFile: string;
  pollTimeoutSec: number;
  allow?: Outcome[];
  ack: boolean;
  help: boolean;
}

function parse(argv: string[]): BinArgs {
  const out: BinArgs = { offsetFile: ".telegram-bot-offset.json", pollTimeoutSec: 25, ack: true, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--repo" && argv[i + 1]) { out.repo = argv[i + 1]; i += 1; }
    else if (a === "--offset-file" && argv[i + 1]) { out.offsetFile = argv[i + 1]!; i += 1; }
    else if (a === "--poll-timeout" && argv[i + 1]) {
      const n = Number.parseInt(argv[i + 1]!, 10);
      if (!Number.isNaN(n)) out.pollTimeoutSec = n;
      i += 1;
    }
    else if (a === "--allow" && argv[i + 1]) {
      out.allow = argv[i + 1]!
        .split(",")
        .map((s) => s.trim())
        .filter((s): s is Outcome => s === "merged" || s === "reworked" || s === "rejected");
      i += 1;
    }
    else if (a === "--no-ack") out.ack = false;
  }
  return out;
}

async function readOffset(filePath: string): Promise<number | undefined> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as { offset?: unknown };
    return typeof parsed.offset === "number" ? parsed.offset : undefined;
  } catch {
    return undefined;
  }
}

async function writeOffset(filePath: string, offset: number): Promise<void> {
  await mkdir(path.dirname(filePath) || ".", { recursive: true });
  await writeFile(filePath, JSON.stringify({ offset }, null, 2) + "\n", "utf8");
}

async function main(): Promise<void> {
  const args = parse(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (!args.repo || !args.repo.includes("/")) {
    process.stderr.write(`conclave-telegram-bot: --repo <owner/name> is required\n\n${HELP}`);
    process.exit(2);
  }
  const botToken = process.env["TELEGRAM_BOT_TOKEN"];
  if (!botToken) {
    process.stderr.write("conclave-telegram-bot: TELEGRAM_BOT_TOKEN env var is not set\n");
    process.exit(2);
  }

  const offset = await readOffset(args.offsetFile);
  const result = await runBotOnce({
    botToken: botToken!,
    repo: args.repo!,
    ...(offset !== undefined ? { offset } : {}),
    pollTimeoutSec: args.pollTimeoutSec,
    ackCallbacks: args.ack,
    ...(args.allow ? { allowOutcomes: args.allow } : {}),
  });

  if (result.nextOffset !== undefined && result.nextOffset !== offset) {
    await writeOffset(args.offsetFile, result.nextOffset);
  }

  process.stdout.write(
    `conclave-telegram-bot: parsed=${result.parsed.length} dispatched=${result.dispatched.length} errors=${result.errors.length} nextOffset=${result.nextOffset ?? "(unchanged)"}\n`,
  );
  for (const e of result.errors) {
    process.stderr.write(`  update ${e.updateId}: ${e.message}\n`);
  }
  if (result.errors.length > 0) process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`conclave-telegram-bot: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
