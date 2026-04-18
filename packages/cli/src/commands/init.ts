import { promises as fs } from "node:fs";
import path from "node:path";

const CONFIG_FILENAME = ".conclaverc.json";

const DEFAULT_CONFIG = {
  version: 1,
  agents: ["claude"],
  budget: { perPrUsd: 0.5 },
  efficiency: { cacheEnabled: true, compactEnabled: true },
  memory: { answerKeysDir: ".conclave/answer-keys", failureCatalogDir: ".conclave/failure-catalog" },
};

export async function init(_argv: string[]): Promise<void> {
  const cwd = process.cwd();
  const target = path.join(cwd, CONFIG_FILENAME);

  try {
    await fs.access(target);
    process.stderr.write(`conclave: ${CONFIG_FILENAME} already exists at ${cwd}. Aborting.\n`);
    process.exit(1);
    return;
  } catch {
    // does not exist, proceed
  }

  await fs.writeFile(target, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf8");
  process.stdout.write(
    `conclave: wrote ${CONFIG_FILENAME}\n` +
      `Next: set ANTHROPIC_API_KEY, then run \`conclave review\`.\n`,
  );
}
