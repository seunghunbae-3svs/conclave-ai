import { FileSystemMemoryStore, computeAllAgentScores, AGENT_SCORE_WEIGHTS } from "@ai-conclave/core";
import { loadConfig, resolveMemoryRoot } from "../lib/config.js";

const HELP = `conclave scores — show per-agent performance scores

Usage:
  conclave scores [--json]

Reads the memory store's episodic log and computes a rolling weighted
score for every agent that has reviewed at least one PR. Weights
(decision #19):

  build pass rate       40%   (proxy: approvals that ultimately merged)
  review approval rate  30%
  time to resolution    20%   (not yet tracked — component null)
  rework frequency      10%   (1 - reworks / resolved)

Missing components renormalize — an agent is not penalized for data
that isn't being tracked yet.
`;

interface ParsedArgs {
  help: boolean;
  json: boolean;
}

function parseArgv(argv: string[]): ParsedArgs {
  return {
    help: argv.includes("--help") || argv.includes("-h"),
    json: argv.includes("--json"),
  };
}

export async function scores(argv: string[]): Promise<void> {
  const args = parseArgv(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }

  const { config, configDir } = await loadConfig();
  const memoryRoot = resolveMemoryRoot(config, configDir);
  const store = new FileSystemMemoryStore({ root: memoryRoot });

  const all = await computeAllAgentScores(store);

  if (args.json) {
    process.stdout.write(JSON.stringify(all, null, 2) + "\n");
    return;
  }

  if (all.length === 0) {
    process.stdout.write("conclave scores: no agent reviews in memory yet. Run `conclave review` first.\n");
    return;
  }

  process.stdout.write(`conclave scores — rolling weighted per-agent performance\n\n`);
  for (const s of all) {
    const pct = (s.score * 100).toFixed(2);
    process.stdout.write(`  ${s.agent.padEnd(10)} score ${pct}%   samples ${s.sampleCount}\n`);
    for (const [k, v] of Object.entries(s.components) as Array<
      [keyof typeof s.components, number | null]
    >) {
      const weight = AGENT_SCORE_WEIGHTS[k];
      const weightStr = `(${Math.round(weight * 100)}%)`;
      if (v === null) {
        process.stdout.write(`    ${k.padEnd(16)} ${weightStr.padEnd(6)} not tracked\n`);
      } else {
        process.stdout.write(
          `    ${k.padEnd(16)} ${weightStr.padEnd(6)} ${(v * 100).toFixed(1)}%\n`,
        );
      }
    }
    process.stdout.write("\n");
  }
}
