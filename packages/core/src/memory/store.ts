import type { AnswerKey, EpisodicEntry, FailureEntry, SemanticRule } from "./schema.js";

export interface MemoryReadQuery {
  /** Free-text query. Typically the diff summary + file paths + blocker categories of the PR under review. */
  query: string;
  /** Filter by domain (code / design). Null/omitted = both. */
  domain?: "code" | "design";
  /** Max results per bucket. Default 8. */
  k?: number;
  /** Repo scope — prefer entries tagged for this repo; falls back to global. */
  repo?: string;
}

export interface MemoryRetrieval {
  answerKeys: AnswerKey[];
  failures: FailureEntry[];
  rules: SemanticRule[];
}

/**
 * MemoryStore — read + write interface for the self-evolve substrate.
 *
 * Implementations: `FileSystemMemoryStore` (JSON files under `.conclave/`),
 * future `PostgresMemoryStore` for shared/team deployments, future
 * `FederatedReadOnlyStore` for the hash+category baseline fetched from a
 * shared endpoint (decision #21).
 *
 * RAG path (`retrieve(...)`) is read-only and is called once per review.
 * Write methods are called by the outcome-writer on merge / reject /
 * rework events (future PR wires this up).
 */
export interface MemoryStore {
  retrieve(query: MemoryReadQuery): Promise<MemoryRetrieval>;
  writeEpisodic(entry: EpisodicEntry): Promise<void>;
  writeAnswerKey(key: AnswerKey): Promise<void>;
  writeFailure(entry: FailureEntry): Promise<void>;
  writeRule(rule: SemanticRule): Promise<void>;
  /** Utility — list all answer-keys matching a domain filter. Mostly for tests + admin tools. */
  listAnswerKeys(domain?: "code" | "design"): Promise<AnswerKey[]>;
  listFailures(domain?: "code" | "design"): Promise<FailureEntry[]>;
  listRules(): Promise<SemanticRule[]>;
  /** Find a single episodic entry by id. Returns null if not found. */
  findEpisodic(id: string): Promise<EpisodicEntry | null>;
}

/**
 * Distilled summary helpers that convert retrieved entries into the short
 * string form that ReviewContext.answerKeys / failureCatalog carry. Agents
 * splice these into prompts (see agent-claude/prompts.ts).
 */
export function formatAnswerKeyForPrompt(k: AnswerKey): string {
  const tags = k.tags.length > 0 ? ` [${k.tags.join(", ")}]` : "";
  return `(${k.domain}/${k.pattern})${tags} — ${k.lesson}`;
}

export function formatFailureForPrompt(f: FailureEntry): string {
  return `(${f.domain}/${f.category}/${f.severity}) ${f.title} — ${f.body}`;
}
