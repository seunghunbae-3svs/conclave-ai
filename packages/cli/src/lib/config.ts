import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const CONFIG_FILENAME = ".conclaverc.json";

export const ConclaveConfigSchema = z.object({
  version: z.literal(1),
  agents: z.array(z.enum(["claude", "openai", "gemini"])).default(["claude"]),
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
  memory: {
    answerKeysDir: ".conclave/answer-keys",
    failureCatalogDir: ".conclave/failure-catalog",
    root: ".conclave",
  },
};

/**
 * Loads .conclaverc.json from `cwd` or any ancestor directory. Returns the
 * merged+validated config + the directory the config was found in (or
 * `cwd` if none found). Missing config → DEFAULT_CONFIG with cwd root.
 */
export async function loadConfig(cwd: string = process.cwd()): Promise<{
  config: ConclaveConfig;
  configDir: string;
  found: boolean;
}> {
  let dir = path.resolve(cwd);
  while (true) {
    const candidate = path.join(dir, CONFIG_FILENAME);
    try {
      const raw = await fs.readFile(candidate, "utf8");
      const parsed = ConclaveConfigSchema.parse(JSON.parse(raw));
      return { config: parsed, configDir: dir, found: true };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { config: DEFAULT_CONFIG, configDir: cwd, found: false };
}

export function resolveMemoryRoot(config: ConclaveConfig, configDir: string): string {
  const root = config.memory.root ?? ".conclave";
  return path.isAbsolute(root) ? root : path.join(configDir, root);
}
