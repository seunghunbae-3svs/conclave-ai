/**
 * OP-5 — secret-guard fires on autofix patches end-to-end.
 *
 * If the worker hallucinates a hard-coded API key in its patch, the
 * apply step MUST refuse. Pre-OP-5 audit, this was wired but never
 * verified in a hermetic E2E that simulates the actual autofix.ts
 * path with a worker stub.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { scanPatch, formatFinding } from "@conclave-ai/secret-guard";

const FAKE_KEYS = {
  anthropic: "sk-ant-api03-" + "x".repeat(95),
  openai: "sk-proj-" + "y".repeat(48),
  github: "ghp_" + "z".repeat(36),
};

test("OP-5 baseline: secret-guard scanPatch on a clean unified-diff returns blocked=false", () => {
  const cleanPatch = [
    "diff --git a/src/index.ts b/src/index.ts",
    "--- a/src/index.ts",
    "+++ b/src/index.ts",
    "@@ -1,1 +1,2 @@",
    " export const x = 1;",
    "+export const y = 2;",
  ].join("\n");
  const result = scanPatch(cleanPatch);
  assert.equal(result.blocked, false);
  assert.equal(
    result.findings.filter((f) => f.confidence === "high").length,
    0,
  );
});

test("OP-5: a worker patch leaking an Anthropic key → blocked=true (autofix would mark secret-block)", () => {
  const leakingPatch = [
    "diff --git a/src/config.ts b/src/config.ts",
    "--- a/src/config.ts",
    "+++ b/src/config.ts",
    "@@ -1,1 +1,2 @@",
    " export const env = {",
    `+  anthropic: "${FAKE_KEYS.anthropic}",`,
    " }",
  ].join("\n");
  const result = scanPatch(leakingPatch);
  assert.equal(result.blocked, true, "high-confidence secret in patch must block apply");
  assert.ok(result.findings.length > 0);
  // The autofix integration uses formatFinding to build the error reason.
  const reason = result.findings.map(formatFinding).join("; ");
  assert.match(reason, /Anthropic|sk-ant/i);
});

test("OP-5: --allow-secret rule-id allowlist permits a specific rule's findings", () => {
  const leakingPatch = [
    "diff --git a/src/config.ts b/src/config.ts",
    "+++ b/src/config.ts",
    "@@",
    `+const k = "${FAKE_KEYS.openai}";`,
  ].join("\n");
  const blockedDefault = scanPatch(leakingPatch);
  assert.equal(blockedDefault.blocked, true, "default rules block sk-proj");
  // With OpenAI rule allowed, the same patch should pass.
  const allowed = scanPatch(leakingPatch, { allow: ["openai-key"] });
  assert.equal(allowed.blocked, false, "allowlisted rule must permit the patch");
});

test("OP-5: secret-guard reports each finding with file + line so users can locate the issue", () => {
  const patch = [
    "diff --git a/src/x.ts b/src/x.ts",
    "+++ b/src/x.ts",
    "@@",
    "+const a = 1;",
    `+const b = "${FAKE_KEYS.github}";`,
    "+const c = 3;",
  ].join("\n");
  const r = scanPatch(patch);
  const finding = r.findings.find((f) => f.confidence === "high");
  assert.ok(finding);
  assert.ok(typeof finding.line === "number" && finding.line > 0);
  // formatFinding produces a one-liner with the rule name.
  const formatted = formatFinding(finding);
  assert.match(formatted, /GitHub|ghp_/);
});

test("OP-5: PEM private key block in patch → high-confidence block", () => {
  const patch = [
    "diff --git a/secrets/key.pem b/secrets/key.pem",
    "+++ b/secrets/key.pem",
    "@@",
    "+-----BEGIN PRIVATE KEY-----",
    "+MIIEvQIBADANBgkqhkiG9w0BAQEFAAS",
    "+-----END PRIVATE KEY-----",
  ].join("\n");
  const r = scanPatch(patch);
  assert.equal(r.blocked, true, "PEM block must block");
});

test("OP-5: multiple secrets in one patch → all surfaced in findings (not just the first)", () => {
  const patch = [
    "diff --git a/.env b/.env",
    "+++ b/.env",
    "@@",
    `+ANTHROPIC=${FAKE_KEYS.anthropic}`,
    `+OPENAI=${FAKE_KEYS.openai}`,
    `+GITHUB=${FAKE_KEYS.github}`,
  ].join("\n");
  const r = scanPatch(patch);
  // At least 3 high-confidence findings.
  const highConf = r.findings.filter((f) => f.confidence === "high");
  assert.ok(highConf.length >= 3, `expected ≥3 high-conf findings, got ${highConf.length}`);
  assert.equal(r.blocked, true);
});

test("OP-5: REMOVAL of a secret (the diff DELETES a key) does not block — blocking only on additions", () => {
  // A worker patch that REMOVES a leaked secret must succeed.
  // The pre-image (- lines) shouldn't trigger blocked=true.
  const patch = [
    "diff --git a/.env b/.env",
    "+++ b/.env",
    "--- a/.env",
    "@@",
    `-ANTHROPIC=${FAKE_KEYS.anthropic}`,
  ].join("\n");
  const r = scanPatch(patch);
  // scanPatch only flags ADDITIONS — removals shouldn't block the
  // sanitization patch.
  assert.equal(
    r.blocked,
    false,
    "secret REMOVAL diff must NOT block — that's the fix patch, blocking it would lock the user out",
  );
});

test("OP-5: scanner accepts the same options shape autofix.ts passes (allow: string[])", () => {
  // autofix.ts calls scanner(rf.patch!, { allow: args.allowSecrets }).
  // Confirm the contract holds for various input shapes.
  const patch = [
    "diff --git a/.env b/.env",
    "+++ b/.env",
    "@@",
    `+OPENAI=${FAKE_KEYS.openai}`,
  ].join("\n");
  const r1 = scanPatch(patch, { allow: [] });
  assert.equal(r1.blocked, true, "empty allow → no allowlist");
  const r2 = scanPatch(patch, { allow: ["openai-key"] });
  assert.equal(r2.blocked, false, "specific allow → permits");
  const r3 = scanPatch(patch, { allow: undefined });
  assert.equal(r3.blocked, true, "undefined allow → defaults (no allowlist)");
});
