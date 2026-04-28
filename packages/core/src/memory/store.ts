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
  /**
   * Optional federated-frequency map (`contentHash → count`). When set,
   * retrieval output is re-ranked so local docs whose (kind, domain,
   * category, severity, normalized-tags) hash matches a federated
   * baseline get a logarithmic frequency boost. Decision #21.
   */
  federatedFrequency?: ReadonlyMap<string, number>;
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
  /** List every episodic entry (mostly for outcome polling + admin tools). */
  listEpisodic(): Promise<EpisodicEntry[]>;
}

/**
 * Distilled summary helpers that convert retrieved entries into the short
 * string form that ReviewContext.answerKeys / failureCatalog carry. Agents
 * splice these into prompts (see agent-claude/prompts.ts).
 */
export function formatAnswerKeyForPrompt(k: AnswerKey): string {
  const tags = k.tags.length > 0 ? ` [${k.tags.join(", ")}]` : "";
  const head = `(${k.domain}/${k.pattern})${tags} — ${k.lesson}`;
  // H2 #6 — surface up to 3 removed-blocker examples verbatim so the
  // next council can pattern-match on the same words ("console.log",
  // "missing tests", etc.) instead of leaning on category labels alone.
  if (k.removedBlockers && k.removedBlockers.length > 0) {
    const examples = k.removedBlockers
      .slice(0, 3)
      .map((b) => `${b.category}: ${truncateExample(b.message, 100)}`)
      .join(" / ");
    return `${head}\n  Resolved before merge — ${examples}`;
  }
  return head;
}

function truncateExample(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

export function formatFailureForPrompt(f: FailureEntry): string {
  return `(${f.domain}/${f.category}/${f.severity}) ${f.title} — ${f.body}`;
}
