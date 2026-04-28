import { promises as fs } from "node:fs";
import path from "node:path";
import { CalibrationEntrySchema, type CalibrationEntry } from "./schema.js";

export interface CalibrationStore {
  /** Load every entry for the given (repo, domain). Empty map when none exist. */
  load(repo: string, domain: "code" | "design"): Promise<Map<string, CalibrationEntry>>;
  /** Increment override count for (repo, domain, category). Creates the entry if absent. */
  recordOverride(input: RecordOverrideInput): Promise<CalibrationEntry>;
  /** Test/admin helper — list every entry for a (repo, domain). */
  listAll(repo: string, domain: "code" | "design"): Promise<CalibrationEntry[]>;
}

export interface RecordOverrideInput {
  repo: string;
  domain: "code" | "design";
  category: string;
  episodicId?: string;
  /** Override the timestamp (test-only; defaults to `new Date().toISOString()`). */
  at?: string;
}

export interface FsCalibrationStoreOptions {
  /** Memory root — the calibration directory lives at `${root}/calibration`. */
  root: string;
}

/**
 * FileSystemCalibrationStore — JSON-file backend for per-repo calibration.
 *
 * Layout:
 *   {root}/calibration/{domain}/{slug(repo)}.json
 *
 * Each file is a single JSON object keyed by category. We write the whole
 * file each update — simple, safe at conclave's volume (handful of repos
 * × handful of categories × low write rate from review/record-outcome).
 *
 * Concurrent writers on the same (repo, domain) is not supported; the
 * autonomy loop is single-writer per PR cycle and the central plane is
 * stateless w.r.t. calibration. If that changes, swap to an
 * append-only JSONL file or a small SQLite store.
 */
export class FileSystemCalibrationStore implements CalibrationStore {
  private readonly root: string;

  constructor(opts: FsCalibrationStoreOptions) {
    this.root = opts.root;
  }

  async load(repo: string, domain: "code" | "design"): Promise<Map<string, CalibrationEntry>> {
    const file = this.fileFor(repo, domain);
    const raw = await readFileOrNull(file);
    if (!raw) return new Map();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return new Map();
    }
    const out = new Map<string, CalibrationEntry>();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [category, entry] of Object.entries(parsed as Record<string, unknown>)) {
        const validated = CalibrationEntrySchema.safeParse(entry);
        if (validated.success) out.set(category, validated.data);
      }
    }
    return out;
  }

  async recordOverride(input: RecordOverrideInput): Promise<CalibrationEntry> {
    const existing = await this.load(input.repo, input.domain);
    const at = input.at ?? new Date().toISOString();
    const prior = existing.get(input.category);
    const updated: CalibrationEntry = {
      repo: input.repo,
      domain: input.domain,
      category: input.category,
      overrideCount: (prior?.overrideCount ?? 0) + 1,
      lastOverrideAt: at,
      ...(input.episodicId ? { lastSampleEpisodicId: input.episodicId } : {}),
    };
    existing.set(input.category, updated);
    await this.persist(input.repo, input.domain, existing);
    return updated;
  }

  async listAll(repo: string, domain: "code" | "design"): Promise<CalibrationEntry[]> {
    const map = await this.load(repo, domain);
    return [...map.values()];
  }

  private fileFor(repo: string, domain: "code" | "design"): string {
    return path.join(this.root, "calibration", domain, `${slugRepo(repo)}.json`);
  }

  private async persist(
    repo: string,
    domain: "code" | "design",
    entries: ReadonlyMap<string, CalibrationEntry>,
  ): Promise<void> {
    const file = this.fileFor(repo, domain);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const obj: Record<string, CalibrationEntry> = {};
    for (const [k, v] of entries) obj[k] = v;
    await fs.writeFile(file, JSON.stringify(obj, null, 2), "utf8");
  }
}

/**
 * Slug a `owner/repo` (or arbitrary string) into a filename-safe form
 * — replace path separators with `__` and strip everything outside
 * a conservative charset.
 */
function slugRepo(repo: string): string {
  return repo.replace(/\//g, "__").replace(/[^a-zA-Z0-9_.\-]/g, "_") || "default";
}

async function readFileOrNull(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
