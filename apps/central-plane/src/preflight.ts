/**
 * Runtime preflight checks for the central-plane Worker.
 *
 * Workers don't have a classical "startup" phase — `fetch` is invoked
 * per-request. We approximate a fail-fast startup by running these
 * checks inside the Worker `fetch` entrypoint before the router
 * dispatches, on first request. Cloudflare caches the isolate so the
 * checks only run once per cold start.
 *
 * Separate from `scripts/preflight.mjs` which is a BUILD-time TOML
 * validator that can't see runtime secrets. This file validates the
 * secret *values* the Worker sees at request time — specifically the
 * shape of `CONCLAVE_TOKEN_KEK`.
 *
 * What we check:
 *   - If `CONCLAVE_TOKEN_KEK` is set, it must base64-decode to exactly
 *     32 bytes. A wrong length would cause every encrypt/decrypt call
 *     to throw deep inside the request path with a cryptic SubtleCrypto
 *     error — failing fast with a clear message here is much better.
 *
 * What we DON'T check (deliberately):
 *   - Whether `CONCLAVE_TOKEN_KEK` is set at all. The plane is meant to
 *     run in partial-configuration modes (operator deploys first, sets
 *     secrets second). Reads/writes that need the KEK throw their own
 *     clear errors; routes that don't need it keep working.
 *   - Whether `GITHUB_CLIENT_ID` is set. Same reason (see the BUILD
 *     preflight comment — deploy first, register OAuth second).
 */

import { KEK_BYTES } from "./crypto.js";

export interface PreflightResult {
  ok: boolean;
  /** Human-readable error lines, empty when ok === true. */
  errors: string[];
}

function tryBase64Decode(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * Validate the shape of runtime secrets. Pure — returns errors as data
 * so the caller can decide between failing the request, logging, or
 * throwing.
 */
export function runPreflight(env: {
  CONCLAVE_TOKEN_KEK?: string;
}): PreflightResult {
  const errors: string[] = [];

  if (env.CONCLAVE_TOKEN_KEK !== undefined && env.CONCLAVE_TOKEN_KEK !== "") {
    const raw = tryBase64Decode(env.CONCLAVE_TOKEN_KEK);
    if (raw === null) {
      errors.push(
        "CONCLAVE_TOKEN_KEK is set but is not valid base64. " +
          'Generate a valid key with: node -e "console.log(crypto.randomBytes(32).toString(\'base64\'))" ' +
          "then `wrangler secret put CONCLAVE_TOKEN_KEK`.",
      );
    } else if (raw.length !== KEK_BYTES) {
      errors.push(
        `CONCLAVE_TOKEN_KEK base64-decodes to ${raw.length} bytes; must be exactly ${KEK_BYTES}. ` +
          'Regenerate: node -e "console.log(crypto.randomBytes(32).toString(\'base64\'))" ' +
          "then `wrangler secret put CONCLAVE_TOKEN_KEK`.",
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Throw a clear error if preflight fails. Called once per isolate from
 * the Worker entrypoint.
 */
export function assertPreflight(env: { CONCLAVE_TOKEN_KEK?: string }): void {
  const result = runPreflight(env);
  if (!result.ok) {
    throw new Error(
      [
        "conclave central-plane preflight failed:",
        ...result.errors.map((e) => `  - ${e}`),
      ].join("\n"),
    );
  }
}
