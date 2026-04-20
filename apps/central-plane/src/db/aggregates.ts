import type { Env } from "../env.js";

/**
 * One row per unique content-hash observed across the entire install
 * population. No repo-level info is stored alongside — the whole point
 * is a k-anonymous baseline per decision #21 / D4.
 */
export interface AggregateRow {
  contentHash: string;
  kind: "answer-key" | "failure-catalog";
  domain: "code" | "design";
  category: string | null;
  severity: string | null;
  tags: string[];
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

interface DbRow {
  content_hash: string;
  kind: string;
  domain: string;
  category: string | null;
  severity: string | null;
  tags: string;
  count: number;
  first_seen_at: string;
  last_seen_at: string;
}

function rowToRecord(row: DbRow): AggregateRow {
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(row.tags);
    if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === "string");
  } catch {
    // malformed tags persisted: treat as empty, not an error
  }
  return {
    contentHash: row.content_hash,
    kind: row.kind === "answer-key" ? "answer-key" : "failure-catalog",
    domain: row.domain === "design" ? "design" : "code",
    category: row.category,
    severity: row.severity,
    tags,
    count: row.count,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

export interface UpsertInput {
  contentHash: string;
  kind: "answer-key" | "failure-catalog";
  domain: "code" | "design";
  category?: string | null;
  severity?: string | null;
  tags?: readonly string[];
  now: string;
}

/**
 * Upsert-and-increment on content_hash. Uses SQLite's ON CONFLICT DO UPDATE
 * so the worker does the increment atomically in one round trip even when
 * the same hash is seen concurrently from two consumer repos.
 */
export async function upsertAggregate(env: Env, input: UpsertInput): Promise<void> {
  const tagsJson = JSON.stringify([...(input.tags ?? [])]);
  await env.DB.prepare(
    `INSERT INTO episodic_aggregates (content_hash, kind, domain, category, severity, tags, count, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(content_hash) DO UPDATE SET
       count = count + 1,
       last_seen_at = excluded.last_seen_at`,
  )
    .bind(
      input.contentHash,
      input.kind,
      input.domain,
      input.category ?? null,
      input.severity ?? null,
      tagsJson,
      input.now,
      input.now,
    )
    .run();
}

export interface ListAggregatesQuery {
  kind?: "answer-key" | "failure-catalog";
  domain?: "code" | "design";
  limit?: number;
  minCount?: number;
}

/**
 * List aggregates sorted by count desc — highest-signal patterns first.
 * `minCount` lets a caller ask for only popular-enough patterns (the
 * "baseline" in the federated sense); default is 1 (return everything).
 */
export async function listAggregates(env: Env, query: ListAggregatesQuery = {}): Promise<AggregateRow[]> {
  const wheres: string[] = [];
  const binds: (string | number)[] = [];
  if (query.kind) {
    wheres.push("kind = ?");
    binds.push(query.kind);
  }
  if (query.domain) {
    wheres.push("domain = ?");
    binds.push(query.domain);
  }
  if (query.minCount && query.minCount > 1) {
    wheres.push("count >= ?");
    binds.push(query.minCount);
  }
  const where = wheres.length > 0 ? `WHERE ${wheres.join(" AND ")}` : "";
  const limit = Math.min(Math.max(query.limit ?? 200, 1), 1000);
  const sql = `SELECT * FROM episodic_aggregates ${where} ORDER BY count DESC LIMIT ?`;
  binds.push(limit);
  const result = await env.DB.prepare(sql)
    .bind(...binds)
    .all<DbRow>();
  return (result.results ?? []).map(rowToRecord);
}
