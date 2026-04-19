import { promises as fs } from "node:fs";
import path from "node:path";
import { FileSystemMemoryStore, seedFromLegacyCatalogPath } from "@conclave-ai/core";
import { loadConfig, resolveMemoryRoot, CONFIG_FILENAME, DEFAULT_CONFIG } from "../lib/config.js";

const HELP = `conclave migrate — bring a solo-cto-agent install over to conclave-ai

Usage:
  conclave migrate [--from <solo-cto-agent-root>] [--dry-run]

--from <path>   Path to the solo-cto-agent install root (contains
                tiers.json + failure-catalog.json + optional .solo-cto/).
                Defaults to detect from CWD upwards.
--dry-run       Print the migration plan without writing anything.

What it does:
  1. Detect solo-cto-agent's failure-catalog.json and port every entry
     to conclave-ai's memory store as a FailureEntry (same mapping as
     \`conclave seed --from <path>\`).
  2. Read any TRACKED_REPOS config in solo-cto-agent/.solo-cto/tracked.json
     (if present) and surface them for the user to configure under
     conclave-ai manually.
  3. Emit a .conclaverc.json with sensible defaults if none exists in the
     current directory.
  4. Print a checklist of env vars the user should migrate
     (ANTHROPIC_API_KEY is shared; solo-cto-agent-specific secrets are
     listed but NOT copied — user must audit).

solo-cto-agent 1.4.x stays installable via npm (decision #27); this
command only creates the v2 configuration — it does NOT delete or
modify the legacy install.
`;

export interface MigrateArgs {
  from?: string;
  dryRun: boolean;
  help: boolean;
}

export function parseMigrateArgs(argv: readonly string[]): MigrateArgs {
  const out: MigrateArgs = { dryRun: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--from" && argv[i + 1]) {
      out.from = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

export interface LegacyDetection {
  root: string;
  failureCatalogPath: string | null;
  trackedReposPath: string | null;
  tiersPath: string | null;
}

/**
 * Probe for solo-cto-agent markers at the given root. Returns paths of
 * every legacy artefact we know how to port; null means "did not find
 * that one; skip it silently".
 */
export async function detectLegacy(root: string): Promise<LegacyDetection | null> {
  const abs = path.resolve(root);
  const stat = await safeStat(abs);
  if (!stat?.isDirectory()) return null;
  const catalog = path.join(abs, "failure-catalog.json");
  const tiers = path.join(abs, "tiers.json");
  const tracked = path.join(abs, ".solo-cto", "tracked.json");
  const [hasCatalog, hasTiers, hasTracked] = await Promise.all([exists(catalog), exists(tiers), exists(tracked)]);
  if (!hasCatalog && !hasTiers) return null;
  return {
    root: abs,
    failureCatalogPath: hasCatalog ? catalog : null,
    trackedReposPath: hasTracked ? tracked : null,
    tiersPath: hasTiers ? tiers : null,
  };
}

/** Walk CWD up to filesystem root looking for a solo-cto-agent install. */
export async function findLegacyUpwards(startDir: string): Promise<LegacyDetection | null> {
  let dir = path.resolve(startDir);
  while (true) {
    const hit = await detectLegacy(dir);
    if (hit) return hit;
    // Also try a sibling "solo-cto-agent" folder (common layout:
    // parent/solo-cto-agent + parent/conclave-ai).
    const sibling = path.join(dir, "solo-cto-agent");
    const sibHit = await detectLegacy(sibling);
    if (sibHit) return sibHit;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export interface MigratePlan {
  legacy: LegacyDetection;
  willWriteConfig: boolean;
  configTargetPath: string;
  willSeedFailures: boolean;
  trackedRepoNames: readonly string[];
  envChecklist: readonly string[];
}

const ENV_CHECKLIST = [
  "ANTHROPIC_API_KEY (required — same as solo-cto-agent)",
  "OPENAI_API_KEY (optional — enables second council agent)",
  "GOOGLE_API_KEY or GEMINI_API_KEY (optional — third council agent, long-context)",
  "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID (optional — notifications)",
  "DISCORD_WEBHOOK_URL (optional)",
  "SLACK_WEBHOOK_URL (optional)",
  "RESEND_API_KEY + CONCLAVE_EMAIL_FROM + CONCLAVE_EMAIL_TO (optional email)",
  "VERCEL_TOKEN / NETLIFY_TOKEN + NETLIFY_SITE_ID / CLOUDFLARE_API_TOKEN+ACCOUNT_ID+PROJECT_NAME (optional — visual review)",
  "LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY (optional — observability)",
];

export async function buildPlan(legacy: LegacyDetection, cwd: string): Promise<MigratePlan> {
  const configTarget = path.join(cwd, CONFIG_FILENAME);
  const configExists = await exists(configTarget);
  const trackedRepoNames = await readTrackedRepos(legacy.trackedReposPath);
  return {
    legacy,
    willWriteConfig: !configExists,
    configTargetPath: configTarget,
    willSeedFailures: !!legacy.failureCatalogPath,
    trackedRepoNames,
    envChecklist: ENV_CHECKLIST,
  };
}

export async function applyPlan(plan: MigratePlan, cwd: string): Promise<{ wroteConfig: boolean; seeded: number }> {
  let wroteConfig = false;
  if (plan.willWriteConfig) {
    await fs.writeFile(plan.configTargetPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf8");
    wroteConfig = true;
  }
  let seeded = 0;
  if (plan.willSeedFailures && plan.legacy.failureCatalogPath) {
    const { config } = await loadConfig(cwd);
    const memoryRoot = resolveMemoryRoot(config, cwd);
    const store = new FileSystemMemoryStore({ root: memoryRoot });
    const res = await seedFromLegacyCatalogPath(plan.legacy.failureCatalogPath, store, {
      extraTags: ["legacy", "solo-cto-agent", "migrated"],
    });
    seeded = res.entries.length;
  }
  return { wroteConfig, seeded };
}

export async function migrate(argv: string[]): Promise<void> {
  const args = parseMigrateArgs(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }

  const cwd = process.cwd();
  const legacy = args.from ? await detectLegacy(args.from) : await findLegacyUpwards(cwd);
  if (!legacy) {
    process.stderr.write(
      "conclave migrate: no solo-cto-agent install found. Pass --from <path> or run from near the legacy root.\n",
    );
    process.exit(1);
    return;
  }

  const plan = await buildPlan(legacy, cwd);

  process.stdout.write(
    `conclave migrate:\n` +
      `  legacy root:         ${plan.legacy.root}\n` +
      `  failure-catalog:     ${plan.legacy.failureCatalogPath ?? "(not found)"}\n` +
      `  tiers.json:          ${plan.legacy.tiersPath ?? "(not found)"}\n` +
      `  tracked repos:       ${plan.trackedRepoNames.length} found\n` +
      `  config to write:     ${plan.willWriteConfig ? plan.configTargetPath : "(already exists — skipping)"}\n` +
      `  seed failures:       ${plan.willSeedFailures ? "yes" : "no"}\n` +
      `  mode:                ${args.dryRun ? "DRY RUN — no changes will be written" : "APPLY"}\n`,
  );

  if (plan.trackedRepoNames.length > 0) {
    process.stdout.write(`\n  tracked-repo names (migrate manually to scm-github config):\n`);
    for (const n of plan.trackedRepoNames) process.stdout.write(`    - ${n}\n`);
  }

  process.stdout.write(`\n  env checklist (audit each; don't copy tokens blindly):\n`);
  for (const e of plan.envChecklist) process.stdout.write(`    • ${e}\n`);

  if (!args.dryRun) {
    const applied = await applyPlan(plan, cwd);
    process.stdout.write(
      `\n  applied:\n` +
        `    config written:    ${applied.wroteConfig ? "yes → " + plan.configTargetPath : "skipped"}\n` +
        `    failures seeded:   ${applied.seeded}\n`,
    );
  } else {
    process.stdout.write(`\n  (dry run — re-run without --dry-run to apply)\n`);
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function safeStat(p: string): Promise<import("node:fs").Stats | null> {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

async function readTrackedRepos(trackedPath: string | null): Promise<readonly string[]> {
  if (!trackedPath) return [];
  try {
    const raw = await fs.readFile(trackedPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === "string");
    if (parsed && typeof parsed === "object") {
      const maybe = (parsed as { selected?: unknown }).selected;
      if (Array.isArray(maybe)) return maybe.filter((x): x is string => typeof x === "string");
    }
    return [];
  } catch {
    return [];
  }
}
