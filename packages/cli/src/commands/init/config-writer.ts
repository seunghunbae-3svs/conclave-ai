import { promises as fs } from "node:fs";
import path from "node:path";

export const CONFIG_FILENAME = ".conclaverc.json";

/**
 * Default config the v0.4 `conclave init` writes. Deliberately opinionated:
 *  - Three-agent tier-1 council is the sweet spot per decision #7 (debate
 *    signal saturates beyond three; two produces ties; one kills the moat).
 *  - $2/PR budget matches the eventbadge-dogfood default that proved
 *    sustainable for a code-review workload; users can raise it freely.
 *  - `shareMode: "hashes"` locks D4 default: no PR content leaves the
 *    user's runner unless they explicitly flip to "full" in the config.
 *  - `integrations.telegram.enabled: true` with no chatId yet — the
 *    init wizard captures the link token; until then the CLI sees no
 *    chatId and silently skips Telegram (documented behaviour).
 */
export const DEFAULT_CONFIG = {
  version: 1,
  agents: ["claude", "openai", "gemini"],
  budget: { perPrUsd: 2.0 },
  efficiency: { cacheEnabled: true, compactEnabled: true },
  memory: {
    answerKeysDir: ".conclave/answer-keys",
    failureCatalogDir: ".conclave/failure-catalog",
  },
  sharing: {
    mode: "hashes" as const,
  },
  integrations: {
    telegram: { enabled: true, includeActionButtons: true },
  },
  council: {
    maxRounds: 3,
    enableDebate: true,
    domains: {
      code: {
        tier1: ["claude", "openai", "gemini"],
        tier2: ["claude", "openai"],
        tier1MaxRounds: 1,
        tier2MaxRounds: 2,
        alwaysEscalate: false,
        models: { tier1: {}, tier2: { claude: "claude-opus-4-7", openai: "gpt-5.4" } },
      },
      design: {
        // v0.5 C: design-specialist agent leads on design reviews;
        // Claude stays on as the text-backup so code changes paired
        // with visuals still get a code-reading reviewer.
        tier1: ["design", "claude"],
        tier2: ["design", "claude"],
        tier1MaxRounds: 1,
        tier2MaxRounds: 2,
        alwaysEscalate: true,
        models: {
          tier1: { design: "claude-haiku-4-5" },
          tier2: { design: "claude-opus-4-7", claude: "claude-opus-4-7" },
        },
      },
    },
  },
};

export interface WriteConfigInput {
  cwd: string;
  repoSlug: string;
  /** If true, overwrite an existing file. Default false. */
  force?: boolean;
  /** Agents the user confirmed they have a key for. Others get stripped from tier1/tier2. */
  selectedAgents?: readonly string[];
}

export interface WriteConfigOutput {
  path: string;
  created: boolean;
  skipped: boolean;
}

export async function writeConfig(input: WriteConfigInput): Promise<WriteConfigOutput> {
  const target = path.join(input.cwd, CONFIG_FILENAME);
  const exists = await fs
    .access(target)
    .then(() => true)
    .catch(() => false);
  if (exists && !input.force) {
    return { path: target, created: false, skipped: true };
  }

  const config = buildConfigFor(input.repoSlug, input.selectedAgents);
  await fs.writeFile(target, JSON.stringify(config, null, 2) + "\n", "utf8");
  return { path: target, created: true, skipped: false };
}

export function buildConfigFor(repoSlug: string, selectedAgents?: readonly string[]): typeof DEFAULT_CONFIG & {
  repo: string;
} {
  const base: typeof DEFAULT_CONFIG & { repo: string } = {
    ...DEFAULT_CONFIG,
    repo: repoSlug,
  };
  if (!selectedAgents || selectedAgents.length === 0) return base;

  // Filter the tiered council to only agents the user actually has keys for.
  // If OpenAI/Gemini got deselected, drop them from tier1 + tier2 while
  // preserving order.
  //
  // `design` is not a distinct credential — it reuses ANTHROPIC_API_KEY,
  // so it travels with `claude`. If Claude survived the filter, Design
  // stays; if Claude got dropped, Design goes too.
  const allow = new Set(selectedAgents);
  const claudeSurvived = allow.has("claude");
  const filter = (arr: readonly string[]) =>
    arr.filter((a) => (a === "design" ? claudeSurvived : allow.has(a)));
  return {
    ...base,
    agents: filter(base.agents),
    council: {
      ...base.council,
      domains: {
        code: {
          ...base.council.domains.code,
          tier1: filter(base.council.domains.code.tier1),
          tier2: filter(base.council.domains.code.tier2),
        },
        design: {
          ...base.council.domains.design,
          tier1: filter(base.council.domains.design.tier1),
          tier2: filter(base.council.domains.design.tier2),
        },
      },
    },
  };
}
