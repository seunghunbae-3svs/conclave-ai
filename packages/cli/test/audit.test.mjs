import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  discoverAuditFiles,
  buildAuditBatches,
  categorize,
  isBinaryExtension,
  parseIgnoreFile,
  DEFAULT_UI_SIGNALS,
} from "../dist/lib/audit-discovery.js";
import {
  aggregateFindings,
  renderAuditJson,
  renderAuditStdout,
  renderAuditIssueBody,
} from "../dist/lib/audit-output.js";
import { HARD_BUDGET_CEILING_USD } from "../dist/commands/audit.js";

// ─── helpers ─────────────────────────────────────────────────────────

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aic-audit-"));
}

function touch(root, rel, body = "x", mtimeMs) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  if (mtimeMs !== undefined) {
    fs.utimesSync(p, new Date(mtimeMs), new Date(mtimeMs));
  }
}

// ─── 1. discovery respects .gitignore + scope ────────────────────────

test("audit-discovery: respects .gitignore and applies scope filter", async () => {
  const root = tmpRepo();
  try {
    touch(root, ".gitignore", "secrets.ts\ntmp/\n");
    touch(root, "src/app.ts", "x");
    touch(root, "src/Button.tsx", "x");
    touch(root, "secrets.ts", "x");
    touch(root, "tmp/generated.ts", "x");
    touch(root, "README.md", "x");

    const result = await discoverAuditFiles({
      cwd: root,
      scope: "all",
      useGitRecency: false,
    });
    const paths = result.files.map((f) => f.path).sort();
    assert.ok(paths.includes("src/app.ts"), "src/app.ts should be discovered");
    assert.ok(paths.includes("src/Button.tsx"), "src/Button.tsx should be discovered");
    assert.ok(paths.includes("README.md"), "README.md should be discovered");
    assert.ok(!paths.includes("secrets.ts"), ".gitignore entry should be excluded");
    assert.ok(!paths.includes("tmp/generated.ts"), ".gitignore dir should be excluded");

    const uiOnly = await discoverAuditFiles({ cwd: root, scope: "ui", useGitRecency: false });
    const uiPaths = uiOnly.files.map((f) => f.path);
    assert.deepEqual(uiPaths, ["src/Button.tsx"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ─── 2. sampling picks recent files when over max ────────────────────

test("audit-discovery: samples category-balanced when over max-files", async () => {
  const root = tmpRepo();
  try {
    // 30 code files, 10 ui files. Make the LAST 5 code files the most recent.
    for (let i = 0; i < 30; i++) {
      const age = i < 25 ? Date.now() - 1000 * 60 * 60 * 24 * 30 : Date.now();
      touch(root, `src/code${i}.ts`, "x", age);
    }
    for (let i = 0; i < 10; i++) {
      touch(root, `src/ui${i}.tsx`, "x", Date.now() - 1000 * 60 * 60 * 24 * 10);
    }

    const result = await discoverAuditFiles({
      cwd: root,
      scope: "all",
      maxFiles: 10,
      useGitRecency: false,
    });
    assert.equal(result.sampled, true);
    assert.equal(result.files.length, 10);
    const cats = new Set(result.files.map((f) => f.category));
    assert.ok(cats.has("code"), "should include code files");
    assert.ok(cats.has("ui"), "should include ui files (category-balanced)");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ─── 3. batching doesn't exceed per-agent char budget ────────────────

test("audit-batching: packs files under the char budget per batch", async () => {
  const root = tmpRepo();
  try {
    touch(root, "a.ts", "a".repeat(2_000));
    touch(root, "b.ts", "b".repeat(2_000));
    touch(root, "c.ts", "c".repeat(2_000));
    touch(root, "d.ts", "d".repeat(2_000));

    const discovery = await discoverAuditFiles({ cwd: root, useGitRecency: false });
    const batches = await buildAuditBatches(discovery.files, root, 3_000);
    for (const b of batches) {
      // Header adds a few bytes per file; allow 10% headroom beyond cap
      // when a single oversize file is in a batch alone.
      assert.ok(b.charCount <= 3_500, `batch chars ${b.charCount} over cap`);
    }
    assert.ok(batches.length >= 2, "should create multiple batches");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ─── 4. aggregation dedupes across agents ────────────────────────────

test("audit-aggregate: dedupes same (file,line,category,severity) across agents", () => {
  const perBatch = [
    {
      batchIndex: 0,
      files: [],
      costUsd: 0,
      latencyMs: 0,
      results: [
        {
          agent: "claude",
          verdict: "rework",
          summary: "",
          blockers: [
            { severity: "blocker", category: "a11y", message: "missing alt", file: "Hero.tsx", line: 12 },
          ],
        },
        {
          agent: "openai",
          verdict: "rework",
          summary: "",
          blockers: [
            { severity: "blocker", category: "a11y", message: "img missing alt attr", file: "Hero.tsx", line: 13 },
          ],
        },
      ],
    },
  ];
  const cat = new Map();
  cat.set("Hero.tsx", "ui");
  const findings = aggregateFindings(perBatch, cat);
  assert.equal(findings.length, 1, "overlapping blockers should collapse");
  assert.deepEqual(findings[0].agents.sort(), ["claude", "openai"]);
  // Longest message wins
  assert.match(findings[0].message, /img missing alt attr/);
});

// ─── 5. budget exhaustion → partial (no crash) ───────────────────────
// We exercise this via the aggregation path rather than spinning up
// agents. A report with budgetExhausted=true must still render.

test("audit-output: renders a partial (budget-exhausted) report without throwing", () => {
  const report = {
    repo: "acme/x",
    sha: "deadbeefcafe",
    scope: "all",
    domain: "mixed",
    filesAudited: 40,
    filesInScope: 120,
    sampled: true,
    discoveryReason: "120 matched > max-files=40 — sampled 40",
    findings: [],
    perAgentVerdict: [{ agent: "claude", approvedBatches: 2, reworkBatches: 0, rejectBatches: 0 }],
    budgetUsd: 2,
    spentUsd: 1.9,
    budgetExhausted: true,
    batchesRun: 2,
    batchesTotal: 5,
    metrics: {
      callCount: 2,
      totalInputTokens: 1000,
      totalOutputTokens: 200,
      totalCostUsd: 1.9,
      totalLatencyMs: 8000,
      cacheHitRate: 0,
      byAgent: {},
      byModel: {},
    },
  };
  const s = renderAuditStdout(report);
  assert.match(s, /BUDGET EXHAUSTED/);
  assert.match(s, /batches: 2\/5/);
  const issue = renderAuditIssueBody(report);
  assert.match(issue, /budget exhausted/i);
  assert.match(issue, /2\/5/);
});

// ─── 6. --dry-run no LLM calls ───────────────────────────────────────
// Asserted indirectly: discovery returns files but we never call agents.
// The test below is a structural smoke — discovery shouldn't throw on a
// minimal repo and its result shape should be ready to pass to --dry-run.

test("audit-discovery: minimal repo yields a dry-run-able result", async () => {
  const root = tmpRepo();
  try {
    touch(root, "src/a.ts", "x");
    const d = await discoverAuditFiles({ cwd: root, useGitRecency: false });
    assert.equal(d.files.length, 1);
    assert.equal(d.files[0].path, "src/a.ts");
    assert.equal(d.files[0].category, "code");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ─── 7. --output json valid ──────────────────────────────────────────

test("audit-output: --output json produces parseable JSON", () => {
  const report = {
    repo: "acme/x",
    sha: "abcdef",
    scope: "code",
    domain: "code",
    filesAudited: 1,
    filesInScope: 1,
    sampled: false,
    discoveryReason: "1 matched",
    findings: [
      {
        severity: "major",
        category: "correctness",
        file: "a.ts",
        line: 5,
        message: "possible null deref",
        agents: ["claude"],
        subsystem: "code",
      },
    ],
    perAgentVerdict: [{ agent: "claude", approvedBatches: 0, reworkBatches: 1, rejectBatches: 0 }],
    budgetUsd: 2,
    spentUsd: 0.1,
    budgetExhausted: false,
    batchesRun: 1,
    batchesTotal: 1,
    metrics: {
      callCount: 1,
      totalInputTokens: 100,
      totalOutputTokens: 20,
      totalCostUsd: 0.1,
      totalLatencyMs: 500,
      cacheHitRate: 0,
      byAgent: {},
      byModel: {},
    },
  };
  const json = renderAuditJson(report);
  const parsed = JSON.parse(json);
  assert.equal(parsed.findings[0].file, "a.ts");
  assert.equal(parsed.findings[0].severity, "major");
});

// ─── 8. --domain design → DesignAgent only (routing) ─────────────────
// The domain routing happens inside the command. We spot-check the flag
// parser separately via categorize + UI-signal defaults.

test("audit-discovery: ui scope picks up tsx / css / tailwind.config", () => {
  // Categorization is the routing primitive.
  assert.equal(categorize("src/Hero.tsx"), "ui");
  assert.equal(categorize("app/styles.css"), "ui");
  assert.equal(categorize("tailwind.config.ts"), "ui");
  assert.equal(categorize("lib/util.ts"), "code");
  assert.equal(categorize("src/lib/__tests__/foo.test.ts"), "test");
  assert.equal(categorize("README.md"), "docs");
  assert.equal(categorize("Dockerfile"), "infra");
});

// ─── 9. hard-ceiling $10 enforcement ────────────────────────────────

test("audit: hard budget ceiling is exported as $10", () => {
  assert.equal(HARD_BUDGET_CEILING_USD, 10);
});

// ─── 10. .conclaveignore respected ──────────────────────────────────

test("audit-discovery: respects .conclaveignore in addition to .gitignore", async () => {
  const root = tmpRepo();
  try {
    touch(root, ".conclaveignore", "secret.ts\n");
    touch(root, "secret.ts", "x");
    touch(root, "public.ts", "x");
    const d = await discoverAuditFiles({ cwd: root, useGitRecency: false });
    const paths = d.files.map((f) => f.path);
    assert.ok(paths.includes("public.ts"));
    assert.ok(!paths.includes("secret.ts"), ".conclaveignore should drop secret.ts");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ─── 11. binary files excluded ──────────────────────────────────────

test("audit-discovery: binary extensions are never returned", async () => {
  const root = tmpRepo();
  try {
    touch(root, "logo.png", "binary");
    touch(root, "font.woff2", "binary");
    touch(root, "a.ts", "x");
    const d = await discoverAuditFiles({ cwd: root, useGitRecency: false });
    const paths = d.files.map((f) => f.path);
    assert.ok(paths.includes("a.ts"));
    assert.ok(!paths.includes("logo.png"));
    assert.ok(!paths.includes("font.woff2"));
    assert.equal(isBinaryExtension("logo.png"), true);
    assert.equal(isBinaryExtension("a.ts"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ─── 12. recent modification priority works ─────────────────────────

test("audit-discovery: files are sorted by mtime (newest first)", async () => {
  const root = tmpRepo();
  try {
    const now = Date.now();
    touch(root, "old.ts", "x", now - 1000 * 60 * 60 * 24 * 90);
    touch(root, "mid.ts", "x", now - 1000 * 60 * 60 * 24 * 10);
    touch(root, "new.ts", "x", now);
    const d = await discoverAuditFiles({ cwd: root, useGitRecency: false });
    assert.equal(d.files[0].path, "new.ts");
    assert.equal(d.files[1].path, "mid.ts");
    assert.equal(d.files[2].path, "old.ts");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ─── bonus: parseIgnoreFile sanity ───────────────────────────────────

test("parseIgnoreFile: ignores blanks + comments, expands dir patterns", () => {
  const out = parseIgnoreFile("# comment\n\nfoo.ts\ntmp/\n");
  assert.ok(out.includes("foo.ts"));
  assert.ok(out.includes("tmp/**") || out.some((g) => g.endsWith("tmp/**")));
});

// ─── bonus: DEFAULT_UI_SIGNALS includes tsx/jsx ──────────────────────

test("audit-discovery: DEFAULT_UI_SIGNALS includes the core frameworks", () => {
  const joined = DEFAULT_UI_SIGNALS.join(" ");
  assert.match(joined, /tsx/);
  assert.match(joined, /vue/);
  assert.match(joined, /svelte/);
  assert.match(joined, /css/);
});

// ─── RC audit-1: gh issue create always passes --repo ────────────────
// When `--cwd` points to a directory other than process.cwd() the issue
// must land in the target repo, not the invoker's repo. We verify the
// compiled code passes --repo to `gh issue create`.

test("RC audit-1: gh issue create call includes --repo flag", () => {
  const src = fs.readFileSync(
    new URL("../dist/commands/audit.js", import.meta.url),
    "utf8",
  );
  // The gh issue create invocation must spread ["--repo", repo] into the args.
  assert.match(src, /["']--repo["']/, "gh issue create must include --repo");
});

// ─── RC audit-2: --output both doesn't double-write stdout on failure ─
// When --output both is used and issue creation fails, stdout has already
// been written by the earlier stdout-or-both branch; the fallback must
// NOT write it again.

test("RC audit-2: output=both fallback is guarded against double-write", () => {
  const src = fs.readFileSync(
    new URL("../dist/commands/audit.js", import.meta.url),
    "utf8",
  );
  // The fallback in the issue-creation catch block must check output !== "both"
  // before writing stdout. Look for the guard pattern.
  assert.match(
    src,
    /output\s*!==\s*["']both["']/,
    "issue-creation fallback must skip stdout when output=both",
  );
});

// ─── dry-run end-to-end: audit() exits cleanly without LLM calls ──────
// The --dry-run flag must return without calling any LLMs. We verify
// this by calling audit() directly; the dry-run path returns early before
// any agent or gh calls are made. Note: stdout interception is intentionally
// avoided here to prevent interference with the concurrent test runner.

test("audit() --dry-run: resolves without throwing on a minimal repo", async () => {
  const root = tmpRepo();
  try {
    touch(root, "src/app.ts", 'console.log("hello")');
    touch(root, "src/Button.tsx", "<button>click</button>");
    touch(root, "README.md", "# readme");

    const { audit } = await import("../dist/commands/audit.js");
    // Should resolve without throwing (dry-run never calls LLMs or gh).
    await assert.doesNotReject(
      () => audit(["--dry-run", "--cwd", root, "--scope", "all"]),
      "audit() --dry-run should not throw",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ─── parseArgv: default values and explicit flags ─────────────────────

test("audit-parseArgv: exports HARD_BUDGET_CEILING_USD = 10", () => {
  assert.equal(HARD_BUDGET_CEILING_USD, 10);
});

test("audit-discovery: --include restricts to matching files only", async () => {
  const root = tmpRepo();
  try {
    touch(root, "src/app.ts", "x");
    touch(root, "src/Button.tsx", "x");
    touch(root, "lib/util.ts", "x");

    const result = await discoverAuditFiles({
      cwd: root,
      scope: "all",
      include: ["src/**"],
      useGitRecency: false,
    });
    const paths = result.files.map((f) => f.path).sort();
    assert.ok(paths.every((p) => p.startsWith("src/")), "only src/ files should be returned");
    assert.ok(!paths.includes("lib/util.ts"), "lib/util.ts should be excluded");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("audit-output: renderAuditStdout shows 'no findings' when findings list is empty", () => {
  const report = {
    repo: "acme/x",
    sha: "abc",
    scope: "all",
    domain: "code",
    filesAudited: 3,
    filesInScope: 3,
    sampled: false,
    discoveryReason: "3 matched",
    findings: [],
    perAgentVerdict: [],
    budgetUsd: 2,
    spentUsd: 0.05,
    budgetExhausted: false,
    batchesRun: 1,
    batchesTotal: 1,
    metrics: {
      callCount: 1,
      totalInputTokens: 500,
      totalOutputTokens: 100,
      totalCostUsd: 0.05,
      totalLatencyMs: 200,
      cacheHitRate: 0,
      byAgent: {},
      byModel: {},
    },
  };
  const out = renderAuditStdout(report);
  assert.match(out, /no findings/i);
  assert.match(out, /0 blockers/);
});

test("audit-aggregate: unknown file path falls back to inferred subsystem", () => {
  const perBatch = [
    {
      batchIndex: 0,
      files: [],
      costUsd: 0,
      latencyMs: 0,
      results: [
        {
          agent: "claude",
          verdict: "rework",
          summary: "",
          blockers: [
            { severity: "minor", category: "a11y", message: "contrast", file: "components/Hero.tsx" },
          ],
        },
      ],
    },
  ];
  // fileToCategory map intentionally empty — subsystem should be inferred from ext
  const findings = aggregateFindings(perBatch, new Map());
  assert.equal(findings.length, 1);
  assert.equal(findings[0].subsystem, "ui", "tsx should infer subsystem=ui");
});
