import { z } from "zod";
import { FederatedBaselineSchema, type FederatedBaseline } from "./schema.js";

export interface HttpFetch {
  (url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
    text: () => Promise<string>;
  }>;
}

/**
 * FederatedSyncTransport — pluggable wire for decision #21.
 *
 * Contract:
 *   - `push(baselines)` — uploads redacted entries; server returns an
 *     `accepted` count (may be < input.length if server dedupes).
 *   - `pull(since?)` — returns baselines newer than the ISO timestamp,
 *     or all available if omitted.
 *   - Implementations MUST NOT mutate the input.
 *   - Hard errors (auth failure, 5xx) throw. Empty results (no
 *     baselines yet on server) return `[]`, not throw.
 */
export interface FederatedSyncTransport {
  readonly id: string;
  push(baselines: readonly FederatedBaseline[]): Promise<{ accepted: number }>;
  pull(since?: string): Promise<FederatedBaseline[]>;
}

export interface HttpTransportOptions {
  endpoint: string;
  apiToken?: string;
  fetch?: HttpFetch;
}

const PushResponseSchema = z.object({ accepted: z.number().int().nonnegative() });
const PullResponseSchema = z.object({ baselines: z.array(FederatedBaselineSchema) });

/**
 * HttpFederatedSyncTransport — v2.0 default. Expects a JSON API at:
 *   POST   {endpoint}/baselines        body: { baselines: [...] }    → { accepted: N }
 *   GET    {endpoint}/baselines?since  body: none                     → { baselines: [...] }
 *
 * The endpoint contract is deliberately thin so community-hosted
 * aggregators can implement it without adopting a vendor SDK.
 */
export class HttpFederatedSyncTransport implements FederatedSyncTransport {
  readonly id = "http";
  private readonly endpoint: string;
  private readonly apiToken: string | undefined;
  private readonly fetchFn: HttpFetch;

  constructor(opts: HttpTransportOptions) {
    if (!opts.endpoint) {
      throw new Error("HttpFederatedSyncTransport: endpoint required");
    }
    this.endpoint = opts.endpoint.replace(/\/$/, "");
    this.apiToken = opts.apiToken;
    this.fetchFn = opts.fetch ?? ((...args) => fetch(...(args as Parameters<typeof fetch>)) as ReturnType<HttpFetch>);
  }

  async push(baselines: readonly FederatedBaseline[]): Promise<{ accepted: number }> {
    if (baselines.length === 0) return { accepted: 0 };
    const res = await this.fetchFn(`${this.endpoint}/baselines`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ baselines }),
    });
    if (!res.ok) await this.throwHttp(res, "push");
    const data = PushResponseSchema.parse(await res.json());
    return { accepted: data.accepted };
  }

  async pull(since?: string): Promise<FederatedBaseline[]> {
    const url = since
      ? `${this.endpoint}/baselines?since=${encodeURIComponent(since)}`
      : `${this.endpoint}/baselines`;
    const res = await this.fetchFn(url, { method: "GET", headers: this.headers() });
    if (!res.ok) await this.throwHttp(res, "pull");
    const data = PullResponseSchema.parse(await res.json());
    return data.baselines;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.apiToken) h.authorization = `Bearer ${this.apiToken}`;
    return h;
  }

  private async throwHttp(
    res: { status: number; text: () => Promise<string> },
    op: string,
  ): Promise<never> {
    if (res.status === 401 || res.status === 403) {
      throw new Error(`HttpFederatedSyncTransport: auth failed during ${op} (status ${res.status})`);
    }
    const body = await res.text();
    throw new Error(
      `HttpFederatedSyncTransport: ${op} failed (status ${res.status}): ${body.slice(0, 200)}`,
    );
  }
}

/**
 * NoopFederatedSyncTransport — used when federation is disabled in
 * config. Reports `accepted` equal to input length so upstream metrics
 * stay consistent but performs zero network I/O.
 */
export class NoopFederatedSyncTransport implements FederatedSyncTransport {
  readonly id = "noop";
  async push(baselines: readonly FederatedBaseline[]): Promise<{ accepted: number }> {
    return { accepted: baselines.length };
  }
  async pull(): Promise<FederatedBaseline[]> {
    return [];
  }
}
