import { promises as fs } from "node:fs";
import path from "node:path";
import {
  AnswerKeySchema,
  EpisodicEntrySchema,
  FailureEntrySchema,
  SemanticRuleSchema,
  type AnswerKey,
  type EpisodicEntry,
  type FailureEntry,
  type SemanticRule,
} from "./schema.js";
import type { MemoryReadQuery, MemoryRetrieval, MemoryStore } from "./store.js";
import { retrieve } from "./retrieval.js";
import { hashAnswerKey, hashFailure } from "../federated/redact.js";
import { rerankByFrequency } from "../federated/frequency.js";

export interface FsStoreOptions {
  root: string;
}

/**
 * FileSystemMemoryStore — JSON-file backend for the self-evolve substrate.
 *
 * Layout under `root`:
 *   episodic/YYYY-MM-DD/pr-{n}.json          (90d TTL — pruning runs out-of-band)
 *   answer-keys/{domain}/{id}.json
 *   failure-catalog/{domain}/{id}.json
 *   semantic/rules.json                       (single JSONL file, appended)
 *
 * All paths are created lazily on first write. Reads are glob-less —
 * we walk only the directories we care about.
 */
export class FileSystemMemoryStore implements MemoryStore {
  private readonly root: string;

  constructor(opts: FsStoreOptions) {
    this.root = opts.root;
  }

  async retrieve(q: MemoryReadQuery): Promise<MemoryRetrieval> {
    const k = q.k ?? 8;
    const answerKeyCorpus = await this.listAnswerKeys(q.domain);
    const failureCorpus = await this.listFailures(q.domain);
    const ruleCorpus = await this.listRules();

    const answerKeyScored = retrieve(
      answerKeyCorpus,
      q.query,
      {
        text: (d) => `${d.pattern}\n${d.lesson}\n${d.tags.join(" ")}`,
        tags: (d) => d.tags,
        repo: (d) => d.repo,
      },
      k,
      { queryRepo: q.repo },
    );

    const failureScored = retrieve(
      failureCorpus,
      q.query,
      {
        text: (d) => `${d.title}\n${d.body}\n${d.category}\n${d.tags.join(" ")}`,
        tags: (d) => [d.category, ...d.tags],
      },
      k,
    );

    const answerKeys = q.federatedFrequency
      ? rerankByFrequency(answerKeyScored, q.federatedFrequency, hashAnswerKey).map((s) => s.doc)
      : answerKeyScored.map((s) => s.doc);

    const failures = q.federatedFrequency
      ? rerankByFrequency(failureScored, q.federatedFrequency, hashFailure).map((s) => s.doc)
      : failureScored.map((s) => s.doc);

    const rules = retrieve(
      ruleCorpus,
      q.query,
      {
        text: (d) => `${d.tag}\n${d.rule}`,
        tags: (d) => [d.tag],
      },
      Math.min(k, 4),
    ).map((s) => s.doc);

    return { answerKeys, failures, rules };
  }

  async writeEpisodic(entry: EpisodicEntry): Promise<void> {
    EpisodicEntrySchema.parse(entry);
    const day = entry.createdAt.slice(0, 10);
    const dir = path.join(this.root, "episodic", day);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, `pr-${entry.pullNumber}-${entry.id}.json`),
      JSON.stringify(entry, null, 2),
      "utf8",
    );
  }

  async writeAnswerKey(key: AnswerKey): Promise<void> {
    AnswerKeySchema.parse(key);
    const dir = path.join(this.root, "answer-keys", key.domain);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${key.id}.json`), JSON.stringify(key, null, 2), "utf8");
  }

  async writeFailure(entry: FailureEntry): Promise<void> {
    FailureEntrySchema.parse(entry);
    const dir = path.join(this.root, "failure-catalog", entry.domain);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${entry.id}.json`), JSON.stringify(entry, null, 2), "utf8");
  }

  async writeRule(rule: SemanticRule): Promise<void> {
    SemanticRuleSchema.parse(rule);
    const dir = path.join(this.root, "semantic");
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, "rules.jsonl");
    await fs.appendFile(file, JSON.stringify(rule) + "\n", "utf8");
  }

  async listAnswerKeys(domain?: "code" | "design"): Promise<AnswerKey[]> {
    const domains: Array<"code" | "design"> = domain ? [domain] : ["code", "design"];
    const out: AnswerKey[] = [];
    for (const d of domains) {
      const dir = path.join(this.root, "answer-keys", d);
      const files = await safeReaddir(dir);
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        const raw = await fs.readFile(path.join(dir, f), "utf8");
        const parsed = AnswerKeySchema.safeParse(JSON.parse(raw));
        if (parsed.success) out.push(parsed.data);
      }
    }
    return out;
  }

  async listFailures(domain?: "code" | "design"): Promise<FailureEntry[]> {
    const domains: Array<"code" | "design"> = domain ? [domain] : ["code", "design"];
    const out: FailureEntry[] = [];
    for (const d of domains) {
      const dir = path.join(this.root, "failure-catalog", d);
      const files = await safeReaddir(dir);
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        const raw = await fs.readFile(path.join(dir, f), "utf8");
        const parsed = FailureEntrySchema.safeParse(JSON.parse(raw));
        if (parsed.success) out.push(parsed.data);
      }
    }
    return out;
  }

  async findEpisodic(id: string): Promise<EpisodicEntry | null> {
    const episRoot = path.join(this.root, "episodic");
    const days = await safeReaddir(episRoot);
    for (const day of days) {
      const dir = path.join(episRoot, day);
      const files = await safeReaddir(dir);
      for (const f of files) {
        if (!f.includes(id) || !f.endsWith(".json")) continue;
        try {
          const raw = await fs.readFile(path.join(dir, f), "utf8");
          const parsed = EpisodicEntrySchema.safeParse(JSON.parse(raw));
          if (parsed.success && parsed.data.id === id) return parsed.data;
        } catch {
          continue;
        }
      }
    }
    return null;
  }

  async listEpisodic(): Promise<EpisodicEntry[]> {
    const episRoot = path.join(this.root, "episodic");
    const days = await safeReaddir(episRoot);
    const out: EpisodicEntry[] = [];
    for (const day of days) {
      const dir = path.join(episRoot, day);
      const files = await safeReaddir(dir);
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        try {
          const raw = await fs.readFile(path.join(dir, f), "utf8");
          const parsed = EpisodicEntrySchema.safeParse(JSON.parse(raw));
          if (parsed.success) out.push(parsed.data);
        } catch {
          continue;
        }
      }
    }
    return out;
  }

  async listRules(): Promise<SemanticRule[]> {
    const file = path.join(this.root, "semantic", "rules.jsonl");
    try {
      const raw = await fs.readFile(file, "utf8");
      const out: SemanticRule[] = [];
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const parsed = SemanticRuleSchema.safeParse(JSON.parse(line));
        if (parsed.success) out.push(parsed.data);
      }
      return out;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}
