import {
  FileSystemMemoryStore,
  HttpFederatedSyncTransport,
  NoopFederatedSyncTransport,
  runFederatedSync,
} from "@ai-conclave/core";
import type { FederatedSyncTransport } from "@ai-conclave/core";
import { loadConfig, resolveMemoryRoot } from "../lib/config.js";

const HELP = `conclave sync — exchange k-anonymous baseline signal (decision #21)

Usage:
  conclave sync [--dry-run] [--push-only] [--pull-only] [--since <ISO>]

Federation is OPT-IN. Nothing leaves your machine unless
\`federated.enabled = true\` AND \`federated.endpoint\` are set in
.conclaverc.json.

What leaves: category + severity + normalized tag vector + day-bucket +
a sha256 hash derived from those fields. Nothing else — not the lesson
text, not the failure body, not the diff, not the repo name, not your
username.

Flags:
  --dry-run      Redact locally but DO NOT hit the network. Prints what
                 would be sent so you can audit the payload first.
  --push-only    Only upload — don't pull baselines from the server.
  --pull-only    Only download — don't upload local redacted entries.
  --since <ISO>  Pull baselines newer than the timestamp (default: all).
  --json         Emit a machine-readable summary on stdout.

Env:
  AI_CONCLAVE_FEDERATION_TOKEN  Optional bearer token for the endpoint.
`;

interface ParsedArgs {
  help: boolean;
  dryRun: boolean;
  pushOnly: boolean;
  pullOnly: boolean;
  since: string | undefined;
  json: boolean;
}

function parseArgv(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    help: argv.includes("--help") || argv.includes("-h"),
    dryRun: argv.includes("--dry-run"),
    pushOnly: argv.includes("--push-only"),
    pullOnly: argv.includes("--pull-only"),
    since: undefined,
    json: argv.includes("--json"),
  };
  const i = argv.indexOf("--since");
  if (i >= 0 && argv[i + 1]) args.since = argv[i + 1];
  return args;
}

export async function sync(argv: string[]): Promise<void> {
  const args = parseArgv(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (args.pushOnly && args.pullOnly) {
    process.stderr.write("conclave sync: --push-only and --pull-only are mutually exclusive\n");
    process.exit(2);
  }

  const { config, configDir } = await loadConfig();
  const fed = config.federated;

  let transport: FederatedSyncTransport;
  let reason: string | null = null;
  if (!fed || !fed.enabled) {
    reason = "federation disabled in config (set federated.enabled = true to opt in)";
    transport = new NoopFederatedSyncTransport();
  } else if (!fed.endpoint) {
    reason = "federated.endpoint not configured";
    transport = new NoopFederatedSyncTransport();
  } else {
    transport = new HttpFederatedSyncTransport({
      endpoint: fed.endpoint,
      apiToken: process.env["AI_CONCLAVE_FEDERATION_TOKEN"],
    });
  }

  const memoryRoot = resolveMemoryRoot(config, configDir);
  const store = new FileSystemMemoryStore({ root: memoryRoot });
  const answerKeys = await store.listAnswerKeys();
  const failures = await store.listFailures();

  const result = await runFederatedSync({
    transport,
    answerKeys,
    failures,
    dryRun: args.dryRun,
    ...(args.pushOnly ? { pullDisabled: true } : {}),
    ...(args.pullOnly ? { pushDisabled: true } : {}),
    ...(args.since ? { since: args.since } : {}),
  });

  const summary = {
    transport: result.transportId,
    dryRun: result.dryRun,
    pushed: result.pushed.length,
    accepted: result.accepted,
    pulled: result.pulled.length,
    reason,
  };

  if (args.json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    return;
  }

  if (reason) process.stderr.write(`conclave sync: ${reason}\n`);
  process.stdout.write(
    `conclave sync: transport=${summary.transport} dryRun=${summary.dryRun} pushed=${summary.pushed} accepted=${summary.accepted} pulled=${summary.pulled}\n`,
  );
  if (args.dryRun && result.pushed.length > 0) {
    process.stdout.write("\nBaselines that would be uploaded:\n");
    for (const b of result.pushed) {
      const extra = b.kind === "failure" ? ` ${b.category}/${b.severity}` : "";
      process.stdout.write(
        `  ${b.kind}/${b.domain}${extra} tags=[${b.tags.join(",")}] hash=${b.contentHash.slice(0, 12)}…\n`,
      );
    }
  }
}
