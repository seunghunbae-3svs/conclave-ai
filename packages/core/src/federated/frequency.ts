import type { FederatedBaseline } from "./schema.js";

/**
 * Aggregate a list of federated baselines by `contentHash` to a frequency map.
 *
 * The map is what retrieval-time rerank consumes: "this hash was seen N
 * times across the fleet" becomes a boost signal for local docs whose
 * (kind, domain, category, severity, normalized-tags) hash matches.
 *
 * Pure; safe to call inside the review path without I/O side effects.
 */
export function buildFrequencyMap(
  baselines: readonly FederatedBaseline[],
): Map<string, number> {
  const m = new Map<string, number>();
  for (const b of baselines) {
    m.set(b.contentHash, (m.get(b.contentHash) ?? 0) + 1);
  }
  return m;
}

export interface RerankedDoc<T> {
  doc: T;
  score: number;
  federatedFrequency: number;
}

/**
 * Post-hoc rerank — multiply each scored doc's score by
 * `1 + log2(1 + freq) / log2(1 + saturationAt) * (boost - 1)`, clamped so
 * the multiplicative factor is bounded in `[1, boost]`. Logarithmic so a
 * pattern seen 10,000 times doesn't drown out everything else — just
 * moves ahead of patterns seen 100 times.
 *
 * Docs with zero federated matches keep their original score (factor = 1).
 */
export function rerankByFrequency<T>(
  scored: ReadonlyArray<{ doc: T; score: number }>,
  frequencyMap: ReadonlyMap<string, number>,
  hashDoc: (doc: T) => string,
  opts: { boost?: number; saturationAt?: number } = {},
): RerankedDoc<T>[] {
  const boost = opts.boost ?? 2.0;
  const saturationAt = opts.saturationAt ?? 256;
  const denom = Math.log2(1 + saturationAt);
  const out: RerankedDoc<T>[] = scored.map((s) => {
    const hash = hashDoc(s.doc);
    const freq = frequencyMap.get(hash) ?? 0;
    const norm = Math.min(1, Math.log2(1 + freq) / denom);
    const factor = 1 + norm * (boost - 1);
    return { doc: s.doc, score: s.score * factor, federatedFrequency: freq };
  });
  out.sort((a, b) => b.score - a.score);
  return out;
}
