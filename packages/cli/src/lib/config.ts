import path from "node:path";
import { cosmiconfig } from "cosmiconfig";
import { z } from "zod";

/** Canonical config file that `conclave init` writes. cosmiconfig also accepts .json / .yaml / .yml / .js / .cjs / .mjs and `conclave` fields in package.json. */
export const CONFIG_FILENAME = ".conclaverc.json";

export const ConclaveConfigSchema = z.object({
  version: z.literal(1),
  agents: z.array(z.enum(["claude", "openai", "gemini", "deepseek", "ollama"])).default(["claude"]),
  budget: z
    .object({
      perPrUsd: z.number().positive(),
    })
    .default({ perPrUsd: 0.5 }),
  efficiency: z
    .object({
      cacheEnabled: z.boolean(),
      compactEnabled: z.boolean(),
    })
    .default({ cacheEnabled: true, compactEnabled: true }),
  memory: z
    .object({
      answerKeysDir: z.string(),
      failureCatalogDir: z.string(),
      root: z.string().optional(),
    })
    .default({
      answerKeysDir: ".conclave/answer-keys",
      failureCatalogDir: ".conclave/failure-catalog",
    }),
  observability: z
    .object({
      langfuse: z
        .object({
          enabled: z.boolean().default(true),
          baseUrl: z.string().url().optional(),
        })
        .optional(),
    })
    .optional(),
  integrations: z
    .object({
      telegram: z
        .object({
          enabled: z.boolean().default(true),
          chatId: z.union([z.number(), z.string()]).optional(),
          includeActionButtons: z.boolean().default(true),
        })
        .optional(),
      discord: z
        .object({
          enabled: z.boolean().default(true),
          webhookUrl: z.string().url().optional(),
          username: z.string().optional(),
          avatarUrl: z.string().url().optional(),
        })
        .optional(),
      slack: z
        .object({
          enabled: z.boolean().default(true),
          webhookUrl: z.string().url().optional(),
          username: z.string().optional(),
          iconUrl: z.string().url().optional(),
          iconEmoji: z.string().optional(),
        })
        .optional(),
      email: z
        .object({
          enabled: z.boolean().default(true),
          from: z.string().email().optional(),
          to: z
            .union([z.string().email(), z.array(z.string().email()).min(1)])
            .optional(),
          subjectOverride: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  council: z
    .object({
      maxRounds: z.number().int().min(1).max(5).default(3),
      enableDebate: z.boolean().default(true),
    })
    .default({ maxRounds: 3, enableDebate: true }),
  federated: z
    .object({
      enabled: z.boolean().default(false),
      endpoint: z.string().url().optional(),
    })
    .optional(),
  visual: z
    .object({
      enabled: z.boolean().default(false),
      platforms: z
        .array(z.enum(["vercel", "netlify", "cloudflare", "railway", "deployment-status"]))
        .default(["vercel", "netlify", "cloudflare", "railway", "deployment-status"]),
      width: z.number().int().positive().default(1280),
      height: z.number().int().positive().default(800),
      fullPage: z.boolean().default(true),
      waitSeconds: z.number().int().nonnegative().default(60),
      diffThreshold: z.number().min(0).max(1).default(0.1),
    })
    .optional(),
});

export type ConclaveConfig = z.infer<typeof ConclaveConfigSchema>;

export const DEFAULT_CONFIG: ConclaveConfig = {
  version: 1,
  agents: ["claude"],
  budget: { perPrUsd: 0.5 },
  efficiency: { cacheEnabled: true, compactEnabled: true },
  council: { maxRounds: 3, enableDebate: true },
  memory: {
    answerKeysDir: ".conclave/answer-keys",
    failureCatalogDir: ".conclave/failure-catalog",
    root: ".conclave",
  },
};

/**
 * Cosmiconfig-powered config loader. Searches from `cwd` up to the
 * filesystem root for any of (first hit wins):
 *
 *   - `package.json` with a top-level `conclave` field
 *   - `.conclaverc` (no extension; auto-detected as JSON or YAML)
 *   - `.conclaverc.json`
 *   - `.conclaverc.yaml` / `.conclaverc.yml`
 *   - `.conclaverc.js` / `.cjs` / `.mjs`
 *   - `conclave.config.js` / `.cjs` / `.mjs`
 *
 * The raw config is validated against `ConclaveConfigSchema`; unknown
 * fields raise a Zod error. Missing config returns `DEFAULT_CONFIG`
 * with `configDir = cwd`.
 */
export async function loadConfig(cwd: string = process.cwd()): Promise<{
  config: ConclaveConfig;
  configDir: string;
  found: boolean;
  configPath?: string;
}> {
  // searchStrategy "global" walks up to the filesystem root (matches the
  // original manual walker). "project" would stop at the nearest
  // package.json, which would miss configs placed at the workspace root
  // above a package's own package.json.
  //
  // searchPlaces reorders cosmiconfig's defaults so an explicit
  // `.conclaverc.*` wins over an incidental `conclave` field in
  // package.json. Cosmiconfig's default puts package.json first; our
  // users expect "if I wrote a config file, it's authoritative."
  const explorer = cosmiconfig("conclave", {
    searchStrategy: "global",
    stopDir: path.parse(path.resolve(cwd)).root,
    searchPlaces: [
      ".conclaverc",
      ".conclaverc.json",
      ".conclaverc.yaml",
      ".conclaverc.yml",
      ".conclaverc.js",
      ".conclaverc.cjs",
      ".conclaverc.mjs",
      "conclave.config.js",
      "conclave.config.cjs",
      "conclave.config.mjs",
      "package.json",
    ],
  });
  const result = await explorer.search(path.resolve(cwd));
  if (!result || result.isEmpty) {
    return { config: DEFAULT_CONFIG, configDir: cwd, found: false };
  }
  const parsed = ConclaveConfigSchema.parse(result.config);
  return {
    config: parsed,
    configDir: path.dirname(result.filepath),
    found: true,
    configPath: result.filepath,
  };
}

export function resolveMemoryRoot(config: ConclaveConfig, configDir: string): string {
  const root = config.memory.root ?? ".conclave";
  return path.isAbsolute(root) ? root : path.join(configDir, root);
}
