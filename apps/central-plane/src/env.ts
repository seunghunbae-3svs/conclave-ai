/**
 * The binding surface we accept from the Workers runtime. Added to as
 * follow-up PRs introduce KV (rate limits), Queues (async aggregation),
 * secrets (GITHUB_CLIENT_ID / SECRET for OAuth), etc.
 */
export interface Env {
  DB: D1Database;
  ENVIRONMENT: string;
  /**
   * Public GitHub OAuth App client_id (vars, not secret — it's public by nature).
   * Required by the /oauth/device/* routes. Leave empty / set to placeholder
   * while the central plane is run without OAuth integration.
   */
  GITHUB_CLIENT_ID?: string;
}
