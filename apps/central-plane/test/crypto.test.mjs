import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { encryptToken, decryptToken, importKek, KEK_BYTES } from "../dist/crypto.js";

function genKekB64() {
  return randomBytes(KEK_BYTES).toString("base64");
}

// ---- round-trip ---------------------------------------------------------

test("encryptToken + decryptToken: round-trip recovers plaintext", async () => {
  const kek = genKekB64();
  const plaintext = "gho_abc123DEF456_live_github_access_token";
  const ct = await encryptToken(plaintext, kek);
  assert.notEqual(ct, plaintext, "ciphertext must not equal plaintext");
  assert.ok(ct.length > plaintext.length, "ciphertext should include iv+tag overhead");
  const recovered = await decryptToken(ct, kek);
  assert.equal(recovered, plaintext);
});

test("encryptToken: two encrypts of the same plaintext produce distinct ciphertexts (random IV)", async () => {
  const kek = genKekB64();
  const plaintext = "gho_same_value";
  const ct1 = await encryptToken(plaintext, kek);
  const ct2 = await encryptToken(plaintext, kek);
  assert.notEqual(ct1, ct2, "fresh IV per call — ciphertexts must differ");
  // But both should decrypt back to the same plaintext.
  assert.equal(await decryptToken(ct1, kek), plaintext);
  assert.equal(await decryptToken(ct2, kek), plaintext);
});

// ---- tampered ciphertext ------------------------------------------------

test("decryptToken: tampered ciphertext throws (auth tag failure)", async () => {
  const kek = genKekB64();
  const ct = await encryptToken("gho_original", kek);
  // Flip one bit by corrupting a byte in the middle of the base64 payload.
  // The tampered base64 must stay structurally valid base64 so we only
  // exercise the AES-GCM auth-tag rejection path.
  const raw = Buffer.from(ct, "base64");
  raw[raw.length - 3] ^= 0xff; // flip a byte in the auth tag region
  const tampered = raw.toString("base64");
  await assert.rejects(
    () => decryptToken(tampered, kek),
    /authentication failure|tampered|wrong|OperationError/i,
  );
});

test("decryptToken: wrong KEK throws", async () => {
  const kek1 = genKekB64();
  const kek2 = genKekB64();
  const ct = await encryptToken("gho_secret_token", kek1);
  await assert.rejects(
    () => decryptToken(ct, kek2),
    /authentication failure|tampered|wrong|OperationError/i,
  );
});

// ---- invalid KEK length / shape ----------------------------------------

test("importKek: rejects KEK that does not decode to 32 bytes", async () => {
  const short = Buffer.alloc(16).toString("base64"); // 16 bytes, should be 32
  await assert.rejects(() => importKek(short), /exactly 32 bytes|must decode/i);
  const long = Buffer.alloc(48).toString("base64"); // 48 bytes
  await assert.rejects(() => importKek(long), /exactly 32 bytes|must decode/i);
});

test("importKek: rejects empty / non-string KEK", async () => {
  await assert.rejects(() => importKek(""), /required|non-empty/i);
  await assert.rejects(
    () => importKek(/** @type {any} */ (undefined)),
    /required|non-empty/i,
  );
});

test("encryptToken: rejects missing KEK via importKek", async () => {
  await assert.rejects(() => encryptToken("tok", ""), /required|non-empty/i);
});

test("decryptToken: malformed short ciphertext throws", async () => {
  const kek = genKekB64();
  // 12 bytes or fewer (iv+tag = 28, threshold) — must fail the length check.
  const tooShort = Buffer.alloc(20).toString("base64");
  await assert.rejects(() => decryptToken(tooShort, kek), /too short|authentication failure/i);
});

test("decryptToken: empty ciphertext throws", async () => {
  const kek = genKekB64();
  await assert.rejects(() => decryptToken("", kek), /non-empty/i);
});
