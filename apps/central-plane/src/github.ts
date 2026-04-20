/**
 * Thin GitHub API client — only the three endpoints v0.4 OAuth uses.
 * Injectable fetch so the route tests stay hermetic without monkey-
 * patching globalThis.fetch.
 */

export type FetchLike = typeof fetch;

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

/** POST https://github.com/login/device/code — kick off device flow. */
export async function requestDeviceCode(
  clientId: string,
  fetchImpl: FetchLike = fetch,
): Promise<DeviceCodeResponse> {
  const resp = await fetchImpl("https://github.com/login/device/code", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: clientId, scope: "repo" }),
  });
  if (!resp.ok) {
    throw new Error(`github device code: HTTP ${resp.status}`);
  }
  return (await resp.json()) as DeviceCodeResponse;
}

export type DeviceTokenPoll =
  | { kind: "pending" }
  | { kind: "slow_down" }
  | { kind: "expired" }
  | { kind: "denied" }
  | { kind: "success"; accessToken: string; scope: string }
  | { kind: "error"; message: string };

/** POST https://github.com/login/oauth/access_token — poll for the token. */
export async function pollDeviceToken(
  clientId: string,
  deviceCode: string,
  fetchImpl: FetchLike = fetch,
): Promise<DeviceTokenPoll> {
  const resp = await fetchImpl("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });
  const body = (await resp.json().catch(() => ({}))) as {
    error?: string;
    access_token?: string;
    scope?: string;
  };
  if (body.access_token) {
    return { kind: "success", accessToken: body.access_token, scope: body.scope ?? "" };
  }
  switch (body.error) {
    case "authorization_pending":
      return { kind: "pending" };
    case "slow_down":
      return { kind: "slow_down" };
    case "expired_token":
      return { kind: "expired" };
    case "access_denied":
      return { kind: "denied" };
    default:
      return { kind: "error", message: body.error ?? `HTTP ${resp.status}` };
  }
}

export interface RepoPermissions {
  admin: boolean;
  maintain?: boolean;
  push: boolean;
  triage?: boolean;
  pull?: boolean;
}

/** GET https://api.github.com/repos/:slug — used to verify repo access. */
export async function fetchRepoPermissions(
  slug: string,
  githubToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<RepoPermissions | null> {
  const resp = await fetchImpl(`https://api.github.com/repos/${slug}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${githubToken}`,
      "user-agent": "conclave-ai-central-plane",
    },
  });
  if (resp.status === 404 || resp.status === 403) return null;
  if (!resp.ok) throw new Error(`github repo api: HTTP ${resp.status}`);
  const body = (await resp.json()) as { permissions?: RepoPermissions };
  return body.permissions ?? null;
}
