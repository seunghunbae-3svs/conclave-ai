import { test } from "node:test";
import assert from "node:assert/strict";
import { scanText, scanPatch, formatFinding, redact, DEFAULT_RULES } from "../dist/index.js";

// These are SYNTHETIC values crafted to match the patterns for testing only.
// They are not real secrets. Prefix each with a test marker so scanners of
// this file (including our own) can allow-list them out in the future.
const FIXTURE = {
  aws: "AKIAIOSFODNN7EXAMPLE",
  openai: "sk-abcdefghijklmnopqrstuvwxyz01234567890A",
  openaiProj: "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH",
  anthropic: "sk-ant-api03-" + "a".repeat(60),
  ghPat: "ghp_" + "a".repeat(36),
  ghFine: "github_pat_" + "a".repeat(65),
  ghOAuth: "gho_" + "a".repeat(36),
  slack: "https://hooks.slack.com/services/T01234567/B01234567/aBcDeFgHiJkLmN",
  discord: "https://discord.com/api/webhooks/123456789012345678/" + "a".repeat(60),
  telegram: "123456789:AAEabcdefghijklmnopqrstuvwxyz012345",
  google: "AIza" + "a".repeat(35),
  npm: "npm_" + "a".repeat(36),
  stripe: "sk_live_" + "a".repeat(32),
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
};

// ---------- redact ---------------------------------------------------------

test("redact: short strings become [redacted]", () => {
  assert.equal(redact("abc"), "[redacted]");
  assert.equal(redact("abcdefghijk"), "[redacted]"); // 11 chars, just under 12
});

test("redact: longer strings keep 4+4 chars with ellipsis", () => {
  const out = redact("AKIAIOSFODNN7EXAMPLE");
  assert.equal(out, "AKIA…MPLE");
  assert.ok(!out.includes("IOSFODNN7EX"));
});

// ---------- scanText: high-confidence rules --------------------------------

for (const [name, sample] of Object.entries(FIXTURE)) {
  test(`scanText: detects ${name}`, () => {
    // scanText needs to surface the rule; JWT is medium, rest are high.
    const opts = name === "jwt" ? { includeLowConfidence: true } : {};
    const result = scanText(`token = "${sample}"`, opts);
    assert.ok(result.findings.length >= 1, `no finding for ${name}: ${JSON.stringify(result)}`);
    if (name !== "jwt") assert.equal(result.blocked, true);
  });
}

test("scanText: file option is threaded into findings", () => {
  const result = scanText(`x = "${FIXTURE.ghPat}"`, { file: "src/config.ts" });
  assert.equal(result.findings[0].file, "src/config.ts");
});

test("scanText: no findings on clean text", () => {
  const result = scanText("export const x = 1;\nfunction foo() {}\n");
  assert.equal(result.findings.length, 0);
  assert.equal(result.blocked, false);
});

test("scanText: line numbers are 1-based and accurate", () => {
  const text = `line one\nline two\nkey = "${FIXTURE.openai}"\nline four`;
  const result = scanText(text);
  assert.equal(result.findings[0].line, 3);
});

test("scanText: allow-list suppresses findings by rule id", () => {
  const result = scanText(`x = "${FIXTURE.aws}"`, { allow: ["aws-access-key"] });
  assert.equal(result.findings.length, 0);
  assert.equal(result.blocked, false);
});

test("scanText: medium confidence (JWT) hidden by default, surfaced on opt-in", () => {
  const clean = scanText(FIXTURE.jwt);
  assert.equal(clean.findings.length, 0);
  const loud = scanText(FIXTURE.jwt, { includeLowConfidence: true });
  assert.equal(loud.findings.length, 1);
  assert.equal(loud.blocked, false); // medium alone must not block
});

test("scanText: low-confidence password= only on opt-in, never blocks", () => {
  const text = `password = "hunter2-classic"`;
  assert.equal(scanText(text).findings.length, 0);
  const loud = scanText(text, { includeLowConfidence: true });
  assert.ok(loud.findings.some((f) => f.ruleId === "generic-password-assignment"));
  assert.equal(loud.blocked, false);
});

test("scanText: AWS-secret labeled rule captures the value, not the label", () => {
  const secret40 = "A".repeat(40);
  const text = `aws_secret_access_key = "${secret40}"`;
  const result = scanText(text);
  const f = result.findings.find((x) => x.ruleId === "aws-secret-access-key-labeled");
  assert.ok(f, "should detect labeled AWS secret");
  // Preview should come from the capture group (the value), not the label.
  assert.equal(f.preview, "AAAA…AAAA");
});

test("scanText: PEM private key block", () => {
  const result = scanText("-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIB...");
  assert.ok(result.findings.some((f) => f.ruleId === "private-key-block"));
  assert.equal(result.blocked, true);
});

test("scanText: custom rules replace the defaults", () => {
  const result = scanText('prefix MY-TOKEN-1234', {
    rules: [{ id: "my", name: "My Token", pattern: /MY-TOKEN-\d+/, confidence: "high", description: "" }],
  });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].ruleId, "my");
});

// ---------- scanPatch ------------------------------------------------------

test("scanPatch: flags added lines, ignores context and deletions", () => {
  const patch = `diff --git a/src/x.ts b/src/x.ts
--- a/src/x.ts
+++ b/src/x.ts
@@ -1,3 +1,3 @@
 const keep = "harmless";
-const old = "${FIXTURE.aws}";
+const fresh = "${FIXTURE.ghPat}";
`;
  const result = scanPatch(patch);
  // The removed line (starts with -) must NOT produce a finding; only the
  // added line (starts with +) should.
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].ruleId, "github-pat-classic");
  assert.equal(result.findings[0].file, "src/x.ts");
  assert.equal(result.blocked, true);
});

test("scanPatch: attributes findings to the right file in a multi-file patch", () => {
  const patch = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -0,0 +1 @@
+const a = "${FIXTURE.openai}";
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -0,0 +1 @@
+const b = "${FIXTURE.slack}";
`;
  const result = scanPatch(patch);
  const a = result.findings.find((f) => f.file === "src/a.ts");
  const b = result.findings.find((f) => f.file === "src/b.ts");
  assert.ok(a, "src/a.ts finding missing");
  assert.ok(b, "src/b.ts finding missing");
  assert.equal(a.ruleId, "openai-key");
  assert.equal(b.ruleId, "slack-webhook");
});

test("scanPatch: ignores /dev/null destination (file deletion)", () => {
  const patch = `diff --git a/old.ts b/old.ts
--- a/old.ts
+++ /dev/null
@@ -1 +0,0 @@
-const old = "${FIXTURE.aws}";
`;
  const result = scanPatch(patch);
  assert.equal(result.findings.length, 0);
});

test("scanPatch: no findings on clean patch", () => {
  const patch = `diff --git a/x b/x
--- a/x
+++ b/x
@@ -1 +1,2 @@
 existing line
+added clean line
`;
  const result = scanPatch(patch);
  assert.equal(result.findings.length, 0);
  assert.equal(result.blocked, false);
});

test("scanPatch: allow-list still honoured", () => {
  const patch = `+++ b/src/x.ts
+const key = "${FIXTURE.aws}";
`;
  const result = scanPatch(patch, { allow: ["aws-access-key"] });
  assert.equal(result.findings.length, 0);
});

// ---------- formatFinding --------------------------------------------------

test("formatFinding: includes confidence, rule, location, and preview", () => {
  const f = {
    ruleId: "openai-key",
    ruleName: "OpenAI API Key",
    confidence: "high",
    line: 42,
    column: 8,
    preview: "sk-a…89AB",
    file: "src/config.ts",
  };
  const s = formatFinding(f);
  assert.match(s, /\[high\]/);
  assert.match(s, /OpenAI API Key/);
  assert.match(s, /openai-key/);
  assert.match(s, /src\/config\.ts:42:8/);
  assert.match(s, /sk-a…89AB/);
});

test("formatFinding: omits file segment when absent", () => {
  const f = {
    ruleId: "aws-access-key",
    ruleName: "AWS Access Key ID",
    confidence: "high",
    line: 3,
    column: 5,
    preview: "AKIA…MPLE",
  };
  assert.match(formatFinding(f), /line 3:5/);
});

// ---------- DEFAULT_RULES integrity ----------------------------------------

test("DEFAULT_RULES: every rule has unique id and no banned regex flags", () => {
  const ids = new Set();
  for (const rule of DEFAULT_RULES) {
    assert.ok(!ids.has(rule.id), `duplicate rule id: ${rule.id}`);
    ids.add(rule.id);
    assert.equal(rule.pattern.global, false, `rule ${rule.id}: pattern must not use /g`);
    assert.equal(rule.pattern.sticky, false, `rule ${rule.id}: pattern must not use /y`);
    assert.equal(rule.pattern.multiline, false, `rule ${rule.id}: pattern must not use /m`);
  }
});
