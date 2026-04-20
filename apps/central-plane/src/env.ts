/**
 * The binding surface we accept from the Workers runtime. Added to as
 * follow-up PRs introduce KV (rate limits), Queues (async aggregation),
 * secrets (GITHUB_CLIENT_ID / SECRET for OAuth), etc.
 */
export interface Env {
  DB: D1Database;
  ENVIRONMENT: string;
}
