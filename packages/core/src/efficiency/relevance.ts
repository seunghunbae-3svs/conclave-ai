export interface RelevanceChunk {
  path: string;
  excerpt: string;
  reason: "diff" | "import-of-diff" | "imported-by-diff" | "test-of-diff";
  estimatedTokens: number;
}

export interface RelevanceInput {
  diff: string;
  diffPaths: readonly string[];
  /** Optional resolver: given a path, return its full content (for selective excerpts). */
  readFile?: (path: string) => Promise<string | null>;
  /** Optional resolver: given a path, return its direct imports (for graph walk). */
  importsOf?: (path: string) => Promise<readonly string[]>;
}

export interface RelevanceOptions {
  /** Max tokens to spend on the assembled context. Default 20_000. */
  tokenBudget?: number;
  /** Depth of import-graph walk. Default 1 (direct imports only). */
  graphDepth?: number;
}

/**
 * Build a relevance context for a review call.
 *
 * Priority (in token-budget order):
 *   1. Full diff (always included; truncated to budget if oversized)
 *   2. Test files matching diffed paths (critical for missing-coverage checks)
 *   3. Direct imports of diffed paths (next PR may import these; reviewer needs the interfaces)
 *   4. Files that import the diffed paths (potential breakage surface)
 *
 * The function is deliberately conservative: if `readFile` / `importsOf` are
 * not provided, it returns just the diff. Scm-github (v2.0) will supply the
 * real resolvers; for scaffolding we keep this pure.
 */
export async function buildRelevanceContext(
  input: RelevanceInput,
  opts: RelevanceOptions = {},
): Promise<{ chunks: RelevanceChunk[]; totalTokens: number }> {
  const budget = opts.tokenBudget ?? 20_000;
  const chunks: RelevanceChunk[] = [];
  let used = 0;

  const diffTokens = Math.ceil(input.diff.length / 4);
  const diffChunk: RelevanceChunk = {
    path: "__diff__",
    excerpt: diffTokens > budget ? input.diff.slice(0, budget * 4) : input.diff,
    reason: "diff",
    estimatedTokens: Math.min(diffTokens, budget),
  };
  chunks.push(diffChunk);
  used += diffChunk.estimatedTokens;
  if (used >= budget) return { chunks, totalTokens: used };

  if (input.readFile) {
    for (const p of input.diffPaths) {
      if (used >= budget) break;
      const testPath = inferTestPath(p);
      if (!testPath) continue;
      const content = await input.readFile(testPath);
      if (!content) continue;
      const tokens = Math.ceil(content.length / 4);
      if (used + tokens > budget) continue;
      chunks.push({ path: testPath, excerpt: content, reason: "test-of-diff", estimatedTokens: tokens });
      used += tokens;
    }
  }

  if (input.importsOf && (opts.graphDepth ?? 1) > 0) {
    const seen = new Set(input.diffPaths);
    for (const p of input.diffPaths) {
      if (used >= budget) break;
      const imports = await input.importsOf(p);
      for (const imp of imports) {
        if (used >= budget) break;
        if (seen.has(imp)) continue;
        seen.add(imp);
        const content = input.readFile ? await input.readFile(imp) : null;
        if (!content) continue;
        const tokens = Math.ceil(content.length / 4);
        if (used + tokens > budget) continue;
        chunks.push({
          path: imp,
          excerpt: content,
          reason: "import-of-diff",
          estimatedTokens: tokens,
        });
        used += tokens;
      }
    }
  }

  return { chunks, totalTokens: used };
}

/** Heuristic: map a source file path to its conventional test path. Returns null if none inferable. */
export function inferTestPath(source: string): string | null {
  if (/\.(test|spec)\.(ts|tsx|js|mjs)$/.test(source)) return source;
  const m = source.match(/^(.*)\/([^/]+?)\.(ts|tsx|js|mjs)$/);
  if (!m) return null;
  const [, dir, base, ext] = m;
  return `${dir}/${base}.test.${ext}`;
}
