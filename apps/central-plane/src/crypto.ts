/**
 * Field-level encryption for GitHub access tokens (v0.5 H).
 *
 * AES-256-GCM via SubtleCrypto. The KEK (32 bytes) is stored in the
 * Worker secret `CONCLAVE_TOKEN_KEK`, base64-encoded. Ciphertext wire
 * format — base64 of:
 *
 *   [  IV (12 bytes)  |  ciphertext  |  auth tag (16 bytes)  ]
 *
 * SubtleCrypto's AES-GCM encrypt appends the 16-byte auth tag to the
 * ciphertext buffer; decrypt verifies + strips it. We concatenate the
 * 12-byte IV in front so the decrypt side can recover the IV without a
 * separate column.
 *
 * Intentionally narrow API:
 *   encryptToken(plaintext, kekB64)  → base64 ciphertext
 *   decryptToken(ciphertext, kekB64) → plaintext  (throws on tamper)
 *
 * Both helpers accept an optional `subtle` DI for tests — default is
 * `globalThis.crypto.subtle` which is available in Cloudflare Workers
 * and in Node 24+. The helpers do NOT swallow tag-auth failures into a
 * boolean; callers need to distinguish "tampered" from "not yet
 * encrypted" so the lazy-migration path on read can tell which branch
 * to take.
 */

export const IV_BYTES = 12;
export const TAG_BYTES = 16;
export const KEK_BYTES = 32;

export interface CryptoDeps {
  subtle?: SubtleCrypto;
  getRandomValues?: (buf: Uint8Array) => Uint8Array;
}

function getSubtle(deps?: CryptoDeps): SubtleCrypto {
  const s = deps?.subtle ?? (typeof crypto !== "undefined" ? crypto.subtle : undefined);
  if (!s) {
    throw new Error(
      "crypto.subtle is not available in this runtime — Conclave central plane requires Workers or Node 24+",
    );
  }
  return s;
}

function getRandomFn(deps?: CryptoDeps): (buf: Uint8Array) => Uint8Array {
  if (deps?.getRandomValues) return deps.getRandomValues;
  if (typeof crypto === "undefined" || typeof crypto.getRandomValues !== "function") {
    throw new Error("crypto.getRandomValues is not available in this runtime");
  }
  return (buf: Uint8Array) => {
    crypto.getRandomValues(buf);
    return buf;
  };
}

/**
 * Base64 ↔ bytes helpers. Uses atob/btoa which are available in both
 * Workers and Node ≥16. We only handle ASCII-safe bytes here (we're
 * round-tripping binary through base64), which is fine.
 */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

/**
 * Decode the KEK from base64 and import it as an AES-GCM key. Throws on
 * invalid base64 or wrong byte length (must decode to exactly KEK_BYTES).
 */
export async function importKek(kekBase64: string, deps?: CryptoDeps): Promise<CryptoKey> {
  if (typeof kekBase64 !== "string" || kekBase64.length === 0) {
    throw new Error("CONCLAVE_TOKEN_KEK is required (non-empty base64 string)");
  }
  let raw: Uint8Array;
  try {
    raw = base64ToBytes(kekBase64);
  } catch {
    throw new Error("CONCLAVE_TOKEN_KEK is not valid base64");
  }
  if (raw.length !== KEK_BYTES) {
    throw new Error(
      `CONCLAVE_TOKEN_KEK must decode to exactly ${KEK_BYTES} bytes (got ${raw.length}) — generate with: node -e "console.log(crypto.randomBytes(32).toString('base64'))"`,
    );
  }
  const subtle = getSubtle(deps);
  return subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/**
 * Encrypt plaintext with the given base64 KEK. Returns base64(iv || ct+tag).
 * Generates a fresh random 12-byte IV per call — never reuse IVs with the
 * same key under AES-GCM.
 */
export async function encryptToken(
  plaintext: string,
  kekBase64: string,
  deps?: CryptoDeps,
): Promise<string> {
  if (typeof plaintext !== "string") {
    throw new Error("encryptToken: plaintext must be a string");
  }
  const key = await importKek(kekBase64, deps);
  const subtle = getSubtle(deps);
  const rand = getRandomFn(deps);
  const iv = new Uint8Array(IV_BYTES);
  rand(iv);
  const ptBytes = new TextEncoder().encode(plaintext);
  const ctBuf = await subtle.encrypt({ name: "AES-GCM", iv }, key, ptBytes);
  const ct = new Uint8Array(ctBuf);
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return bytesToBase64(out);
}

/**
 * Decrypt base64 ciphertext with the given base64 KEK. Throws on:
 *   - invalid KEK (bad base64 / wrong length)
 *   - malformed ciphertext (too short to contain iv + tag)
 *   - auth-tag failure (tampered ciphertext, wrong KEK, etc.)
 *
 * The caller is expected to catch these and NOT silently fall back to a
 * plaintext column — a tag failure on an `_enc` value means the row was
 * tampered with or the KEK was changed without rotation, which is an
 * operator-level problem that should surface as an error.
 */
export async function decryptToken(
  ciphertextBase64: string,
  kekBase64: string,
  deps?: CryptoDeps,
): Promise<string> {
  if (typeof ciphertextBase64 !== "string" || ciphertextBase64.length === 0) {
    throw new Error("decryptToken: ciphertext must be a non-empty string");
  }
  let blob: Uint8Array;
  try {
    blob = base64ToBytes(ciphertextBase64);
  } catch {
    throw new Error("decryptToken: ciphertext is not valid base64");
  }
  if (blob.length < IV_BYTES + TAG_BYTES) {
    throw new Error(
      `decryptToken: ciphertext too short (${blob.length} bytes, need >= ${IV_BYTES + TAG_BYTES})`,
    );
  }
  const iv = blob.slice(0, IV_BYTES);
  const ct = blob.slice(IV_BYTES);
  const key = await importKek(kekBase64, deps);
  const subtle = getSubtle(deps);
  let ptBuf: ArrayBuffer;
  try {
    ptBuf = await subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  } catch (err) {
    // SubtleCrypto throws OperationError (DOMException) on tag failure in
    // Workers and a generic Error in Node. Normalise to a clear message.
    throw new Error(
      `decryptToken: authentication failure — ciphertext was tampered with, KEK is wrong, or the value was not encrypted with this scheme (${(err as Error)?.message ?? "unknown"})`,
    );
  }
  return new TextDecoder().decode(ptBuf);
}
