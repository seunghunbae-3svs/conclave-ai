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
  /**
   * Telegram bot token. Set via `wrangler secret put TELEGRAM_BOT_TOKEN` —
   * never paste into wrangler.toml. Required by /telegram/webhook.
   */
  TELEGRAM_BOT_TOKEN?: string;
  /**
   * Optional shared secret for Telegram webhook verification. Pass this
   * as `secret_token` when calling setWebhook and the Worker will reject
   * updates without a matching `X-Telegram-Bot-Api-Secret-Token` header.
   */
  TELEGRAM_WEBHOOK_SECRET?: string;
  /**
   * v0.5 H — base64-encoded 32-byte KEK used to AES-GCM encrypt the
   * GitHub access token stored in D1 (`installs.github_access_token_enc`).
   * Set via `wrangler secret put CONCLAVE_TOKEN_KEK --env production`.
   *
   * Runtime behaviour:
   *   - If unset: OAuth callback refuses to persist tokens (the
   *     `setGithubAccessToken` write throws) and Telegram button clicks
   *     that hit an encrypted row error out with a clear operator
   *     message. The /oauth/device/start path keeps working — only the
   *     token-persistence step gates on this secret.
   *   - If set but wrong length / not valid base64: startup preflight
   *     fails fast with a clear message (see src/preflight.ts).
   */
  CONCLAVE_TOKEN_KEK?: string;
}
