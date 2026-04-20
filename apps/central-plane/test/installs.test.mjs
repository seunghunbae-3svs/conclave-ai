import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  getInstallForDispatch,
  setGithubAccessToken,
  upgradeInstallTokenEncryption,
} from "../dist/db/telegram.js";

function genKekB64() {
  return randomBytes(32).toString("base64");
}

/**
 * Mock D1 that models the installs table with both token columns.
 * Captures bound values and returns rows shaped like real D1 output.
 */
function makeMockDb({ installs = new Map() } = {}) {
  const state = { installs: new Map(installs) };
  return {
    state,
    prepare(sql) {
      let bound = [];
      const api = {
        bind: (...args) => {
          bound = args;
          return api;
        },
        async first() {
          if (
            /SELECT id, repo_slug, github_access_token, github_access_token_enc, github_token_scope FROM installs WHERE id = \? AND status = 'active'/.test(
              sql,
            )
          ) {
            for (const v of state.installs.values()) {
              if (v.id === bound[0] && v.status === "active") {
                return {
                  id: v.id,
                  repo_slug: v.repoSlug,
                  github_access_token: v.githubAccessToken ?? null,
                  github_access_token_enc: v.githubAccessTokenEnc ?? null,
                  github_token_scope: v.githubTokenScope ?? null,
                };
              }
            }
            return null;
          }
          return null;
        },
        async run() {
          if (
            /UPDATE installs SET github_access_token_enc = \?, github_access_token = NULL, github_token_scope = \?, github_token_set_at = \? WHERE id = \?/.test(
              sql,
            )
          ) {
            const [enc, scope, setAt, id] = bound;
            for (const v of state.installs.values()) {
              if (v.id === id) {
                v.githubAccessTokenEnc = enc;
                v.githubAccessToken = null;
                v.githubTokenScope = scope;
                v.githubTokenSetAt = setAt;
              }
            }
          } else if (
            /UPDATE installs SET github_access_token_enc = \?, github_access_token = NULL WHERE id = \? AND github_access_token_enc IS NULL/.test(
              sql,
            )
          ) {
            const [enc, id] = bound;
            for (const v of state.installs.values()) {
              if (v.id === id && (v.githubAccessTokenEnc ?? null) === null) {
                v.githubAccessTokenEnc = enc;
                v.githubAccessToken = null;
              }
            }
          }
          return { success: true };
        },
      };
      return api;
    },
  };
}

function mkInstall(overrides = {}) {
  return {
    id: "c_install_A",
    repoSlug: "acme/service",
    tokenHash: "hashhashhash",
    status: "active",
    createdAt: "2026-04-20T00:00:00Z",
    lastSeenAt: "2026-04-20T00:00:00Z",
    githubAccessToken: null,
    githubAccessTokenEnc: null,
    githubTokenScope: null,
    ...overrides,
  };
}

// ---- write path: setGithubAccessToken encrypts + NULLs plaintext --------

test("setGithubAccessToken: stores ciphertext in _enc and NULLs plaintext column", async () => {
  const kek = genKekB64();
  const install = mkInstall({ githubAccessToken: "STALE_PLAINTEXT" });
  const DB = makeMockDb({ installs: new Map([[install.id, install]]) });
  const env = { DB, CONCLAVE_TOKEN_KEK: kek };

  await setGithubAccessToken(env, install.id, "gho_freshly_minted", "repo", "2026-04-20T12:00:00Z");

  const row = DB.state.installs.get(install.id);
  assert.equal(row.githubAccessToken, null, "plaintext column must be nulled");
  assert.ok(row.githubAccessTokenEnc, "enc column must be populated");
  assert.notEqual(row.githubAccessTokenEnc, "gho_freshly_minted", "enc must not equal plaintext");
  assert.equal(row.githubTokenScope, "repo");
  assert.equal(row.githubTokenSetAt, "2026-04-20T12:00:00Z");
});

test("setGithubAccessToken: refuses to write when CONCLAVE_TOKEN_KEK is unset", async () => {
  const install = mkInstall();
  const DB = makeMockDb({ installs: new Map([[install.id, install]]) });
  const env = { DB }; // no KEK
  await assert.rejects(
    () => setGithubAccessToken(env, install.id, "gho_x", "repo", "t"),
    /CONCLAVE_TOKEN_KEK is not set|refusing to persist/i,
  );
});

// ---- read path: prefers _enc, falls back to plaintext --------------------

test("getInstallForDispatch: reads encrypted _enc column and decrypts it", async () => {
  const kek = genKekB64();
  const install = mkInstall();
  const DB = makeMockDb({ installs: new Map([[install.id, install]]) });
  const env = { DB, CONCLAVE_TOKEN_KEK: kek };

  // First populate via the write path so _enc holds a real ciphertext.
  await setGithubAccessToken(env, install.id, "gho_live_token", "repo", "t");

  const result = await getInstallForDispatch(env, install.id);
  assert.ok(result, "install row should be found");
  assert.equal(result.githubAccessToken, "gho_live_token");
  assert.equal(result.needsLazyEncrypt, false, "encrypted row must NOT flag lazy-encrypt");
});

test("getInstallForDispatch: falls back to plaintext column when _enc is NULL (legacy row)", async () => {
  const install = mkInstall({
    githubAccessToken: "gho_legacy_plaintext",
    githubAccessTokenEnc: null,
    githubTokenScope: "repo",
  });
  const DB = makeMockDb({ installs: new Map([[install.id, install]]) });
  const env = { DB, CONCLAVE_TOKEN_KEK: genKekB64() };
  const result = await getInstallForDispatch(env, install.id);
  assert.ok(result);
  assert.equal(result.githubAccessToken, "gho_legacy_plaintext");
  assert.equal(result.needsLazyEncrypt, true, "legacy row MUST flag lazy-encrypt");
});

test("getInstallForDispatch: cleanly returns null token when both columns are NULL", async () => {
  const install = mkInstall(); // both nulls by default
  const DB = makeMockDb({ installs: new Map([[install.id, install]]) });
  const env = { DB, CONCLAVE_TOKEN_KEK: genKekB64() };
  const result = await getInstallForDispatch(env, install.id);
  assert.ok(result);
  assert.equal(result.githubAccessToken, null);
  assert.equal(result.needsLazyEncrypt, false);
});

test("getInstallForDispatch: throws if _enc is set but CONCLAVE_TOKEN_KEK is missing", async () => {
  const kek = genKekB64();
  const install = mkInstall();
  const DB = makeMockDb({ installs: new Map([[install.id, install]]) });
  const env = { DB, CONCLAVE_TOKEN_KEK: kek };
  await setGithubAccessToken(env, install.id, "gho_x", "repo", "t");

  // Now drop the KEK and attempt a read — must surface a clear error.
  const envNoKek = { DB };
  await assert.rejects(
    () => getInstallForDispatch(envNoKek, install.id),
    /CONCLAVE_TOKEN_KEK is not set/i,
  );
});

// ---- lazy upgrade path --------------------------------------------------

test("upgradeInstallTokenEncryption: writes ciphertext to _enc and NULLs plaintext", async () => {
  const kek = genKekB64();
  const install = mkInstall({
    githubAccessToken: "gho_legacy_plaintext",
    githubAccessTokenEnc: null,
    githubTokenScope: "repo",
  });
  const DB = makeMockDb({ installs: new Map([[install.id, install]]) });
  const env = { DB, CONCLAVE_TOKEN_KEK: kek };

  await upgradeInstallTokenEncryption(env, install.id, "gho_legacy_plaintext");

  const row = DB.state.installs.get(install.id);
  assert.equal(row.githubAccessToken, null, "plaintext column must be nulled after upgrade");
  assert.ok(row.githubAccessTokenEnc, "enc column must be populated after upgrade");

  // A subsequent read must decrypt cleanly.
  const result = await getInstallForDispatch(env, install.id);
  assert.equal(result.githubAccessToken, "gho_legacy_plaintext");
  assert.equal(result.needsLazyEncrypt, false);
});

test("upgradeInstallTokenEncryption: idempotent — does not clobber existing _enc", async () => {
  const kek = genKekB64();
  const install = mkInstall({
    githubAccessTokenEnc: "SOMETHING_ALREADY_THERE",
    githubAccessToken: null,
  });
  const DB = makeMockDb({ installs: new Map([[install.id, install]]) });
  const env = { DB, CONCLAVE_TOKEN_KEK: kek };

  await upgradeInstallTokenEncryption(env, install.id, "gho_any");
  const row = DB.state.installs.get(install.id);
  // The WHERE clause `AND github_access_token_enc IS NULL` blocks the write.
  assert.equal(
    row.githubAccessTokenEnc,
    "SOMETHING_ALREADY_THERE",
    "idempotent upgrade must not overwrite existing ciphertext",
  );
});
