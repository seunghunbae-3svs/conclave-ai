/**
 * Lightweight BM25-ish retrieval. We avoid a heavy vector DB for the
 * skeleton — answer-keys and failures are short text, the corpus is O(100s)
 * per repo, and a keyword-plus-tag ranking is good enough to pilot the
 * self-evolve loop. Vector embeddings slot in later as a pluggable
 * scoring backend without breaking the store interface.
 */

export interface ScoredDoc<T> {
  doc: T;
  score: number;
}

export interface RetrievalFieldExtractor<T> {
  text(doc: T): string;
  tags(doc: T): readonly string[];
  repo?(doc: T): string | undefined;
}

export interface RetrievalOptions {
  /** Lexicon boost: when query tokens match doc tags, multiply score by this factor. Default 1.5. */
  tagBoost?: number;
  /** Multiply score for docs whose repo matches the query's repo. Default 1.2. */
  repoBoost?: number;
  /** Minimum score to retain a doc. Default 0.05. */
  minScore?: number;
}

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "to", "of", "in", "on", "for", "with", "by",
  "is", "are", "was", "were", "be", "been", "being", "it", "its", "this",
  "that", "these", "those", "at", "from", "as", "but", "not", "if", "then",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9가-힣\-]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

function termFrequencies(tokens: readonly string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

/**
 * Score a single document against a query. Returns a scalar in [0, ~n]
 * where n is the number of query tokens. Uses:
 *   1. Cosine-ish term overlap (sum of min(tf_q, tf_d) / sqrt(|q|·|d|))
 *   2. Tag-match boost
 *   3. Repo-match boost (small, just tie-breaking)
 */
function scoreDoc<T>(
  doc: T,
  queryTokens: readonly string[],
  queryRepo: string | undefined,
  extract: RetrievalFieldExtractor<T>,
  opts: Required<Pick<RetrievalOptions, "tagBoost" | "repoBoost">>,
): number {
  const qTf = termFrequencies(queryTokens);
  const dTokens = tokenize(extract.text(doc));
  if (dTokens.length === 0 || queryTokens.length === 0) return 0;
  const dTf = termFrequencies(dTokens);

  let overlap = 0;
  for (const [t, qf] of qTf) {
    const df = dTf.get(t);
    if (df) overlap += Math.min(qf, df);
  }
  let score = overlap / Math.sqrt(queryTokens.length * dTokens.length);

  const tagSet = new Set(extract.tags(doc).map((t) => t.toLowerCase()));
  let tagHits = 0;
  for (const t of qTf.keys()) if (tagSet.has(t)) tagHits += 1;

  if (score === 0 && tagHits > 0) {
    score = tagHits / queryTokens.length;
  }

  if (score > 0) {
    if (tagHits > 0) score *= opts.tagBoost;

    if (queryRepo && extract.repo) {
      const r = extract.repo(doc);
      if (r && r === queryRepo) score *= opts.repoBoost;
    }
  }

  return score;
}

export function retrieve<T>(
  corpus: readonly T[],
  queryText: string,
  extract: RetrievalFieldExtractor<T>,
  k: number,
  opts: RetrievalOptions & { queryRepo?: string } = {},
): ScoredDoc<T>[] {
  const tokens = tokenize(queryText);
  if (tokens.length === 0 || corpus.length === 0) return [];
  const tagBoost = opts.tagBoost ?? 1.5;
  const repoBoost = opts.repoBoost ?? 1.2;
  const minScore = opts.minScore ?? 0.05;
  const scored: ScoredDoc<T>[] = [];
  for (const doc of corpus) {
    const score = scoreDoc(doc, tokens, opts.queryRepo, extract, { tagBoost, repoBoost });
    if (score >= minScore) scored.push({ doc, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}
