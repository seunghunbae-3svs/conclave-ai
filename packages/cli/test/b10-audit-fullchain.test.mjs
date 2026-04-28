/**
 * Phase B.10 — audit (whole-project health check) fullchain.
 *
 * Two paths in audit:
 *   1. LLM-driven file scan — needs API keys + budget.
 *   2. --spec docs/spec.md hermetic spec-vs-code classifier (H1.5 C).
 *
 * Path 2 is fully hermetic, so we exercise it on a fixture repo and
 * validate the entire spec → bullet → classification → report
 * pipeline. Path 1 needs LLM cost; we cover its piece-helpers
 * (audit-discovery / audit-output) directly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  parseSpecMarkdown,
  classifySpecFeature,
  buildSpecReport,
  renderSpecStdout,
  renderSpecIssueBody,
} from "../dist/lib/audit-spec.js";
import {
  discoverAuditFiles,
  buildAuditBatches,
} from "../dist/lib/audit-discovery.js";

function freshFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aic-b10-"));
  execSync("git init -q", { cwd: root });
  execSync('git config user.email "test@test"', { cwd: root });
  execSync('git config user.name "test"', { cwd: root });
  return root;
}
function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

test("B.10 spec-mode: parseSpecMarkdown extracts bullet features at any indent", () => {
  const md = [
    "# spec",
    "",
    "## Auth",
    "- Login with email + password",
    "- Login with Google OAuth",
    "  * Sub-bullet under OAuth",
    "+ Forgot password flow",
    "",
    "## Reviews",
    "- Cross-agent council review on every PR",
    "- Visual diff on UI PRs",
  ].join("\n");
  const features = parseSpecMarkdown(md);
  assert.ok(features.length >= 5, `expected ≥5 features, got ${features.length}`);
  const titles = features.map((f) => f.title);
  assert.ok(titles.some((t) => t.includes("Login with email")));
  assert.ok(titles.some((t) => t.includes("Forgot password")));
  assert.ok(titles.some((t) => t.includes("Cross-agent council")));
});

function classifyAll(features, files) {
  return features.map((f) => classifySpecFeature(f, files));
}

test("B.10 spec-mode: classifySpecFeature — PRESENT on file-path + content match (3x weighted path)", () => {
  const files = [
    { path: "src/api/auth/login.ts", content: "export function login(email, password) {}" },
    { path: "src/components/LoginForm.tsx", content: "export function LoginForm() { return null }" },
  ];
  const features = parseSpecMarkdown("- Login with email and password");
  const [c] = classifyAll(features, files);
  assert.equal(c.status, "PRESENT", `expected PRESENT got ${c.status} (notes: ${c.notes})`);
  assert.ok(c.matchedFiles.includes("src/api/auth/login.ts"));
});

test("B.10 spec-mode: classifySpecFeature — MISSING when no file or content matches", () => {
  const files = [{ path: "src/api/auth/login.ts", content: "export function login() {}" }];
  const features = parseSpecMarkdown("- Multi-factor authentication via TOTP");
  const [c] = classifyAll(features, files);
  assert.equal(c.status, "MISSING", `expected MISSING got ${c.status}`);
});

test("B.10 spec-mode: classifySpecFeature — PARTIAL on weak single-file match", () => {
  const files = [
    { path: "src/util/random.ts", content: "// notes mention forgot password" },
  ];
  const features = parseSpecMarkdown("- Forgot password flow");
  const [c] = classifyAll(features, files);
  assert.notEqual(c.status, "MISSING", "single-file content match should not be full MISSING");
});

test("B.10 spec-mode: buildSpecReport tallies present/partial/missing counts", () => {
  const files = [
    { path: "src/api/login.ts", content: "export function login() {}" },
    { path: "src/components/LoginForm.tsx", content: "export function LoginForm() {}" },
  ];
  const features = parseSpecMarkdown(
    [
      "- Login with email password",
      "- OAuth Google integration",
      "- Wholly fictional totally-different feature x",
    ].join("\n"),
  );
  const cls = classifyAll(features, files);
  const report = buildSpecReport("docs/spec.md", cls);
  assert.equal(report.features.length, 3);
  assert.equal(
    report.presentCount + report.partialCount + report.missingCount,
    3,
    "all features accounted for",
  );
  assert.ok(report.missingCount >= 1, "fictional feature must be missing");
});

test("B.10 spec-mode: renderSpecStdout produces a useful human-readable summary", () => {
  const features = parseSpecMarkdown("- Login with email");
  const cls = classifyAll(features, [{ path: "login.ts", content: "export function login() {}" }]);
  const report = buildSpecReport("docs/spec.md", cls);
  const text = renderSpecStdout(report);
  assert.match(text, /Login/);
  assert.match(text, /PRESENT|PARTIAL|MISSING/);
});

test("B.10 spec-mode: renderSpecIssueBody includes a markdown checklist", () => {
  const features = parseSpecMarkdown(
    ["- feature A nonexistent", "- feature B fictional"].join("\n"),
  );
  const cls = classifyAll(features, []); // empty codebase → both MISSING
  const report = buildSpecReport("docs/spec.md", cls);
  const body = renderSpecIssueBody(report);
  assert.match(body, /\[ \]/, "missing features rendered as `[ ]` checkboxes");
});

// audit-discovery on a real fixture
test("B.10 discovery: discoverAuditFiles surfaces real files, excludes node_modules, respects --max-files", async () => {
  const root = freshFixture();
  try {
    fs.mkdirSync(path.join(root, "src/api"), { recursive: true });
    fs.writeFileSync(path.join(root, "src/api/users.ts"), "export const users = [];", "utf8");
    fs.writeFileSync(path.join(root, "src/api/auth.ts"), "export const auth = {};", "utf8");
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fx" }), "utf8");
    fs.writeFileSync(path.join(root, "README.md"), "# fx", "utf8");
    fs.mkdirSync(path.join(root, "node_modules/lib"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules/lib/index.js"), "module.exports = {}", "utf8");

    const result = await discoverAuditFiles({ cwd: root, maxFiles: 100 });
    assert.ok(Array.isArray(result.files));
    const paths = result.files.map((f) => f.path);
    assert.ok(paths.some((p) => p.endsWith("users.ts")), `expected users.ts among ${paths.join(",")}`);
    assert.ok(paths.some((p) => p.endsWith("auth.ts")));
    assert.ok(
      !paths.some((p) => p.includes("node_modules")),
      "node_modules excluded from discovery",
    );

    // maxFiles cap honored — discovery prunes to the budget.
    const capped = await discoverAuditFiles({ cwd: root, maxFiles: 1 });
    assert.equal(capped.files.length, 1);
  } finally {
    cleanup(root);
  }
});

test("B.10 discovery: buildAuditBatches partitions real files by char budget", async () => {
  const root = freshFixture();
  try {
    // 5 files of 2000 chars each = 10000 chars; with default 6000-char
    // budget, expect ≥ 2 batches.
    const files = [];
    for (let i = 0; i < 5; i += 1) {
      const rel = `f${i}.ts`;
      fs.writeFileSync(path.join(root, rel), "x".repeat(2000), "utf8");
      files.push({ path: rel, category: "code", sizeBytes: 2000 });
    }
    const batches = await buildAuditBatches(files, root);
    assert.ok(batches.length >= 2, `expected ≥ 2 batches; got ${batches.length}`);
    for (const b of batches) {
      assert.ok(b.payload.length > 0);
      assert.match(b.payload, /^--- file:/m, "each batch carries per-file header so agents can attribute findings");
    }
  } finally {
    cleanup(root);
  }
});
