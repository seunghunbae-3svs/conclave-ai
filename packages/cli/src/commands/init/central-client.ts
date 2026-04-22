/**
 * Minimal HTTP client for the Conclave AI central plane. Only the two
 * endpoints `conclave init` actually calls — OAuth device-flow start and
 * poll. Built as an injectable class so tests can stub without monkey-
 * patching globalThis.fetch.
 */

export const DEFAULT_CENTRAL_URL = "https://conclave-ai.seunghunbae.workers.dev";

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;

export interface DeviceStartResponse {
  device_code_id: string;
  user_code: string;
  verification_uri: string;
  interval_sec: number;
  expires_at: string;
}

export type DevicePollResponse =
  | { status: "pending"; interval_sec?: number }
  | { status: "slow_down"; interval_sec?: number }
  | { status: "expired" }
  | { status: "denied"; reason?: string }
  | { status: "already_succeeded" }
  | { status: "success"; token: string; repo: string; rotated?: boolean; note?: string }
  | { status: "error"; message?: string };

export interface CentralClientOptions {
  baseUrl?: string;
  fetch?: FetchLike;
}

export class CentralClient {
  readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: CentralClientOptions = {}) {
    // v0.7.5 — `CONCLAVE_CENTRAL_URL` can be rendered as an EMPTY STRING
    // when GitHub Actions workflows use `${{ vars.FOO || '' }}` and the
    // repo variable isn't set. `??` does not coalesce empty strings, so
    // the old code silently wrote `baseUrl = ""` — then every /oauth/*
    // call resolved to `/oauth/device/start` (no host) and the device
    // flow died with a relative-URL error on Node. Normalise to the
    // default URL when the override is falsy / whitespace.
    const rawBaseUrl =
      opts.baseUrl ?? process.env["CONCLAVE_CENTRAL_URL"] ?? "";
    const trimmed = rawBaseUrl.trim();
    this.baseUrl = (trimmed.length > 0 ? trimmed : DEFAULT_CENTRAL_URL).replace(
      /\/$/,
      "",
    );
    const f = opts.fetch ?? (globalThis as unknown as { fetch?: FetchLike }).fetch;
    if (!f) {
      throw new Error(
        "CentralClient: global fetch unavailable (Node 18+ required) and no opts.fetch passed",
      );
    }
    this.fetchImpl = f;
  }

  async startDeviceFlow(repoSlug: string): Promise<DeviceStartResponse> {
    const resp = await this.fetchImpl(`${this.baseUrl}/oauth/device/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: repoSlug }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`conclave central: /oauth/device/start returned HTTP ${resp.status} — ${text.slice(0, 300)}`);
    }
    return (await resp.json()) as DeviceStartResponse;
  }

  async pollDeviceFlow(deviceCodeId: string): Promise<DevicePollResponse> {
    const resp = await this.fetchImpl(`${this.baseUrl}/oauth/device/poll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code_id: deviceCodeId }),
    });
    if (!resp.ok && resp.status !== 403 && resp.status !== 404) {
      const text = await resp.text().catch(() => "");
      throw new Error(`conclave central: /oauth/device/poll returned HTTP ${resp.status} — ${text.slice(0, 300)}`);
    }
    return (await resp.json()) as DevicePollResponse;
  }
}
