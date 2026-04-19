import { promises as fs } from "node:fs";
import path from "node:path";
import { FederatedBaselineSchema, type FederatedBaseline } from "./schema.js";

/**
 * Cache for pulled federated baselines. The review path reads from this
 * between sync runs; `conclave sync` writes fresh baselines here.
 *
 * JSONL format on disk — one FederatedBaseline per line — so append + read
 * are O(1) / O(n) without needing a DB. Lines that fail schema validation
 * are skipped (not thrown) to survive partial writes.
 */
export interface FederatedBaselineStore {
  read(): Promise<FederatedBaseline[]>;
  /** Replace the entire store contents atomically. */
  write(baselines: readonly FederatedBaseline[]): Promise<void>;
  /** Append new baselines (dedupes by contentHash — last write wins). */
  append(baselines: readonly FederatedBaseline[]): Promise<void>;
  clear(): Promise<void>;
}

export interface FileSystemBaselineStoreOptions {
  /** Repo-relative directory that owns the cache file. Default `.conclave/federated`. */
  root: string;
  /** File name inside `root`. Default `baselines.jsonl`. */
  filename?: string;
}

export class FileSystemFederatedBaselineStore implements FederatedBaselineStore {
  private readonly filePath: string;

  constructor(opts: FileSystemBaselineStoreOptions) {
    this.filePath = path.join(opts.root, opts.filename ?? "baselines.jsonl");
  }

  async read(): Promise<FederatedBaseline[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return [];
      throw err;
    }
    const out: FederatedBaseline[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(FederatedBaselineSchema.parse(JSON.parse(trimmed)));
      } catch {
        // Partial writes or old-schema rows — skip silently.
      }
    }
    return out;
  }

  async write(baselines: readonly FederatedBaseline[]): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const body = baselines.map((b) => JSON.stringify(b)).join("\n") + (baselines.length > 0 ? "\n" : "");
    await fs.writeFile(this.filePath, body, "utf8");
  }

  async append(baselines: readonly FederatedBaseline[]): Promise<void> {
    if (baselines.length === 0) return;
    const existing = await this.read();
    const merged = new Map<string, FederatedBaseline>();
    for (const b of existing) merged.set(b.contentHash, b);
    for (const b of baselines) merged.set(b.contentHash, b);
    await this.write(Array.from(merged.values()));
  }

  async clear(): Promise<void> {
    try {
      await fs.unlink(this.filePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
    }
  }
}
