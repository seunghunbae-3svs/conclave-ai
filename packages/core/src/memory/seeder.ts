import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { FailureEntry } from "./schema.js";
import type { MemoryStore } from "./store.js";

/**
 * Legacy shape of solo-cto-agent's failure-catalog.json (ERR-001~).
 * Decision #18: port directly rather than starting from zero.
 */
export const LegacyEntrySchema = z.object({
  id: z.string().min(1),
  category: z.string().min(1),
  pattern: z.string().min(1),
  description: z.string().min(1),
  fix: z.string().min(1),
});

export const LegacyCatalogSchema = z.object({
  version: z.literal(1),
  updated_at: z.string(),
  items: z.array(LegacyEntrySchema),
});

export type LegacyEntry = z.infer<typeof LegacyEntrySchema>;
export type LegacyCatalog = z.infer<typeof LegacyCatalogSchema>;

export type NewFailureCategory = FailureEntry["category"];

/**
 * Map a legacy (category, pattern, description) triple to our canonical
 * enum. Ordered: most-specific terms first so e.g. "type error" catches
 * "type" before "module" does.
 */
export function mapLegacyCategory(legacy: LegacyEntry): NewFailureCategory {
  const blob = `${legacy.category} ${legacy.pattern} ${legacy.description}`.toLowerCase();
  const rules: Array<[RegExp, NewFailureCategory]> = [
    [/type\s*error|ts\d{4}|type\s*mismatch/i, "type-error"],
    [/missing\s*test|no\s*test|untested/i, "missing-test"],
    [/prisma|schema|migration|db\s*connection|sql|database/i, "schema-drift"],
    [/secret|token|nextauth_url|api\s*key|credential|leak/i, "security"],
    [/accessibility|a11y|aria/i, "accessibility"],
    [/contrast/i, "contrast"],
    [/timeout|memory_?limit|performance|slow|invocation_timeout/i, "performance"],
    [/dead\s*code|unused\s*import|unused\s*var/i, "dead-code"],
    [/regression|broke|broken/i, "regression"],
    [/module\s*not\s*found|cannot\s*find\s*module|import|'use\s*server'|route\s*.*does\s*not\s*match/i, "api-misuse"],
  ];
  for (const [re, cat] of rules) {
    if (re.test(blob)) return cat;
  }
  return "other";
}

export interface SeedOptions {
  /** Timestamp to attach to each derived FailureEntry. Defaults to catalog.updated_at. */
  createdAt?: string;
  /** Default severity. Legacy catalog didn't distinguish — default "major". */
  severity?: FailureEntry["severity"];
  /** Extra tags to attach to every derived entry (e.g. ["legacy", "solo-cto-agent"]). */
  extraTags?: readonly string[];
  /** If true, write through `store.writeFailure`. If false, just return derived entries. Default true. */
  write?: boolean;
}

export interface SeedResult {
  /** All derived entries (written + any skipped with reason). */
  entries: FailureEntry[];
  /** Per-entry category distribution for the caller to print. */
  byCategory: Record<NewFailureCategory, number>;
}

/** Convert a legacy entry into our canonical FailureEntry shape. */
export function toFailureEntry(legacy: LegacyEntry, opts: SeedOptions = {}): FailureEntry {
  const category = mapLegacyCategory(legacy);
  const severity = opts.severity ?? "major";
  const createdAt = opts.createdAt ?? new Date().toISOString();
  const extra = opts.extraTags ?? ["legacy", "solo-cto-agent"];
  const id = `fc-legacy-${legacy.id}-${shortHash(legacy.pattern)}`;
  return {
    id,
    createdAt,
    domain: "code",
    category,
    severity,
    title: legacy.pattern,
    body: `${legacy.description} Fix: ${legacy.fix}`,
    tags: [legacy.category, ...extra],
  };
}

/** Parse legacy catalog JSON and derive FailureEntry records; optionally write them. */
export async function seedFromLegacyCatalog(
  raw: string,
  store: MemoryStore,
  opts: SeedOptions = {},
): Promise<SeedResult> {
  const parsed = LegacyCatalogSchema.parse(JSON.parse(raw));
  const createdAt = opts.createdAt ?? ensureIsoDate(parsed.updated_at);
  const entries: FailureEntry[] = [];
  const byCategory: Record<NewFailureCategory, number> = initCategoryCounter();
  for (const legacy of parsed.items) {
    const seedOpts: SeedOptions = { createdAt };
    if (opts.severity !== undefined) seedOpts.severity = opts.severity;
    if (opts.extraTags !== undefined) seedOpts.extraTags = opts.extraTags;
    const entry = toFailureEntry(legacy, seedOpts);
    entries.push(entry);
    byCategory[entry.category] += 1;
    if (opts.write !== false) await store.writeFailure(entry);
  }
  return { entries, byCategory };
}

export async function seedFromLegacyCatalogPath(
  filePath: string,
  store: MemoryStore,
  opts: SeedOptions = {},
): Promise<SeedResult> {
  const raw = await fs.readFile(filePath, "utf8");
  return seedFromLegacyCatalog(raw, store, opts);
}

function ensureIsoDate(date: string): string {
  if (/\d{4}-\d{2}-\d{2}T/.test(date)) return date;
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return `${date}T00:00:00.000Z`;
  return new Date().toISOString();
}

function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 8);
}

function initCategoryCounter(): Record<NewFailureCategory, number> {
  return {
    "type-error": 0,
    "missing-test": 0,
    regression: 0,
    security: 0,
    accessibility: 0,
    contrast: 0,
    performance: 0,
    "dead-code": 0,
    "api-misuse": 0,
    "schema-drift": 0,
    other: 0,
  };
}
