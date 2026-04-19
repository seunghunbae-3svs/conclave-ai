import path from "node:path";
import { fileURLToPath } from "node:url";
import { FileSystemMemoryStore, seedFromLegacyCatalogPath } from "@conclave-ai/core";
import { loadConfig, resolveMemoryRoot } from "../lib/config.js";

const HELP = `conclave seed — bootstrap the failure catalog from a legacy source

Usage:
  conclave seed [--from <path>]

--from <path>   Path to a legacy failure-catalog JSON. Defaults to the
                bundled solo-cto-agent catalog (decision #18).

Writes one FailureEntry per legacy item into the current .conclave/
memory store. Categories are normalized to the 11 allowed enum values
via heuristic matching; a per-category count is printed so Bae can audit.
`;

function parseArgv(argv: string[]): { from?: string; help: boolean } {
  const out: { from?: string; help: boolean } = { help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--from" && argv[i + 1]) {
      out.from = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

/** Resolve the bundled legacy catalog path (ships inside @conclave-ai/core). */
function resolveBundledCatalog(): string {
  // When bundled via tsc, this file lives at node_modules/@conclave-ai/cli/dist/commands/seed.js.
  // The catalog ships under node_modules/@conclave-ai/core/dist/memory/seeds/solo-cto-agent-failure-catalog.json
  // — but we resolve it relative to the core package's module root for portability.
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Walk up to the workspace root, then dive into core's dist.
  return path.resolve(here, "..", "..", "..", "core", "dist", "memory", "seeds", "solo-cto-agent-failure-catalog.json");
}

export async function seed(argv: string[]): Promise<void> {
  const args = parseArgv(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  const { config, configDir } = await loadConfig();
  const memoryRoot = resolveMemoryRoot(config, configDir);
  const store = new FileSystemMemoryStore({ root: memoryRoot });

  const source = args.from ?? resolveBundledCatalog();
  const result = await seedFromLegacyCatalogPath(source, store, { extraTags: ["legacy", "solo-cto-agent"] });

  process.stdout.write(
    `conclave seed:\n` +
      `  source:   ${source}\n` +
      `  written:  ${result.entries.length} failure-catalog entries → ${memoryRoot}/failure-catalog/code/\n` +
      `  by category:\n`,
  );
  for (const [cat, count] of Object.entries(result.byCategory)) {
    if (count > 0) process.stdout.write(`    ${cat.padEnd(14)} ${count}\n`);
  }
}
