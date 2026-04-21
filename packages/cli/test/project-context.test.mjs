import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadProjectContext,
  loadDesignContext,
  truncateOnWordBoundary,
} from "../dist/lib/project-context.js";
import { ConclaveConfigSchema } from "../dist/lib/config.js";

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeFile(p, content) {
  mkdirp(path.dirname(p));
  fs.writeFileSync(p, content);
}

function tmpRepo(name = "aic-proj-ctx-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), name));
}

// ── truncation helper ──────────────────────────────────────────────

test("truncateOnWordBoundary: short input returns unchanged", () => {
  assert.equal(truncateOnWordBoundary("hello world", 100), "hello world");
});

test("truncateOnWordBoundary: long input truncated with marker on word boundary", () => {
  const input = "word ".repeat(200); // 1000 chars
  const out = truncateOnWordBoundary(input, 50);
  assert.ok(out.endsWith("... (truncated)"));
  assert.ok(out.length <= 50 + "... (truncated)".length + 1);
  // Should not cut mid-word — previous char before the marker should not
  // be a non-space character glued to a word-fragment.
  assert.ok(!/[a-z]\.\.\. \(truncated\)$/i.test(out) || out.startsWith("word"));
});

// ── loadProjectContext ─────────────────────────────────────────────

test("loadProjectContext: returns empty when neither source present", async () => {
  const dir = tmpRepo();
  try {
    const out = await loadProjectContext(dir);
    assert.deepEqual(out, {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadProjectContext: only README present → head slice, truncation marker", async () => {
  const dir = tmpRepo();
  try {
    const readme = "# My Repo\n\n" + "alpha beta gamma delta ".repeat(60);
    writeFile(path.join(dir, "README.md"), readme);
    const out = await loadProjectContext(dir, { readmeMaxChars: 120 });
    assert.ok(out.projectContext);
    assert.ok(out.projectContext.includes("## README (head)"));
    assert.ok(out.projectContext.includes("... (truncated)"));
    // Should not include the project-context file section since absent.
    assert.ok(!out.projectContext.includes(".conclave/project-context.md"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadProjectContext: README below threshold → no truncation marker", async () => {
  const dir = tmpRepo();
  try {
    const readme = "# My Repo\n\nShort description.";
    writeFile(path.join(dir, "README.md"), readme);
    const out = await loadProjectContext(dir, { readmeMaxChars: 500 });
    assert.ok(out.projectContext);
    assert.ok(!out.projectContext.includes("... (truncated)"));
    assert.ok(out.projectContext.includes("Short description."));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadProjectContext: only project-context.md present → that section only", async () => {
  const dir = tmpRepo();
  try {
    writeFile(
      path.join(dir, ".conclave", "project-context.md"),
      "This app is a CLI for auditing code.",
    );
    const out = await loadProjectContext(dir);
    assert.ok(out.projectContext);
    assert.ok(out.projectContext.includes("## .conclave/project-context.md"));
    assert.ok(out.projectContext.includes("This app is a CLI for auditing code."));
    assert.ok(!out.projectContext.includes("## README (head)"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadProjectContext: both present → README head + full project-context combined", async () => {
  const dir = tmpRepo();
  try {
    writeFile(path.join(dir, "README.md"), "# Repo\n\nCLI for X.");
    writeFile(
      path.join(dir, ".conclave", "project-context.md"),
      "Use our reusable workflow with: cli-version: latest. Not a CI error.",
    );
    const out = await loadProjectContext(dir);
    assert.ok(out.projectContext);
    assert.ok(out.projectContext.includes("## README (head)"));
    assert.ok(out.projectContext.includes("## .conclave/project-context.md"));
    assert.ok(out.projectContext.includes("CLI for X."));
    assert.ok(out.projectContext.includes("reusable workflow"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadProjectContext: respects readmeMaxChars override", async () => {
  const dir = tmpRepo();
  try {
    const readme = "x ".repeat(1000);
    writeFile(path.join(dir, "README.md"), readme);
    const out = await loadProjectContext(dir, { readmeMaxChars: 50 });
    assert.ok(out.projectContext);
    // Head section should be ~50 chars + truncation marker. Total
    // "## README (head)\n" header + body < ~100 chars.
    const headMatch = out.projectContext.match(/## README \(head\)\n([\s\S]*)/);
    assert.ok(headMatch);
    assert.ok(headMatch[1].length < 120);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadProjectContext: empty README file is treated as absent", async () => {
  const dir = tmpRepo();
  try {
    writeFile(path.join(dir, "README.md"), "   \n\n  ");
    const out = await loadProjectContext(dir);
    assert.deepEqual(out, {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── loadDesignContext ──────────────────────────────────────────────

test("loadDesignContext: returns empty when nothing present", async () => {
  const dir = tmpRepo();
  try {
    const out = await loadDesignContext(dir);
    assert.deepEqual(out, {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadDesignContext: only design-context.md present → text only, no references", async () => {
  const dir = tmpRepo();
  try {
    writeFile(
      path.join(dir, ".conclave", "design-context.md"),
      "Brand: calm, professional. Contrast: WCAG AA.",
    );
    const out = await loadDesignContext(dir);
    assert.ok(out.designContext);
    assert.ok(out.designContext.includes("WCAG AA"));
    assert.equal(out.designReferences, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadDesignContext: 6 PNGs in design-reference/ → capped at 4 (default)", async () => {
  const dir = tmpRepo();
  try {
    const pngHeader = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const refDir = path.join(dir, ".conclave", "design-reference");
    mkdirp(refDir);
    for (let i = 0; i < 6; i++) {
      fs.writeFileSync(path.join(refDir, `ref-${i}.png`), pngHeader);
    }
    const out = await loadDesignContext(dir);
    assert.ok(out.designReferences);
    assert.equal(out.designReferences.length, 4);
    // Deterministic ordering — lexical names, so ref-0..ref-3.
    assert.equal(out.designReferences[0].filename, "ref-0.png");
    assert.equal(out.designReferences[3].filename, "ref-3.png");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadDesignContext: oversize image → dropped silently", async () => {
  const dir = tmpRepo();
  try {
    const refDir = path.join(dir, ".conclave", "design-reference");
    mkdirp(refDir);
    // One small, one > 512KB
    fs.writeFileSync(path.join(refDir, "small.png"), Buffer.alloc(1_000, 1));
    fs.writeFileSync(path.join(refDir, "huge.png"), Buffer.alloc(600_000, 2));
    const out = await loadDesignContext(dir);
    assert.ok(out.designReferences);
    assert.equal(out.designReferences.length, 1);
    assert.equal(out.designReferences[0].filename, "small.png");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadDesignContext: maxReferences=2 override", async () => {
  const dir = tmpRepo();
  try {
    const refDir = path.join(dir, ".conclave", "design-reference");
    mkdirp(refDir);
    for (let i = 0; i < 4; i++) {
      fs.writeFileSync(path.join(refDir, `a-${i}.png`), Buffer.alloc(100, 1));
    }
    const out = await loadDesignContext(dir, { maxReferences: 2 });
    assert.equal(out.designReferences.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadDesignContext: maxImageBytes=200 override drops anything larger", async () => {
  const dir = tmpRepo();
  try {
    const refDir = path.join(dir, ".conclave", "design-reference");
    mkdirp(refDir);
    fs.writeFileSync(path.join(refDir, "tiny.png"), Buffer.alloc(100, 1));
    fs.writeFileSync(path.join(refDir, "medium.png"), Buffer.alloc(300, 1));
    const out = await loadDesignContext(dir, { maxImageBytes: 200 });
    assert.ok(out.designReferences);
    assert.equal(out.designReferences.length, 1);
    assert.equal(out.designReferences[0].filename, "tiny.png");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadDesignContext: ignores non-png files in design-reference/", async () => {
  const dir = tmpRepo();
  try {
    const refDir = path.join(dir, ".conclave", "design-reference");
    mkdirp(refDir);
    fs.writeFileSync(path.join(refDir, "notes.md"), "ignore me");
    fs.writeFileSync(path.join(refDir, "ref.jpg"), Buffer.alloc(50, 1));
    fs.writeFileSync(path.join(refDir, "real.png"), Buffer.alloc(50, 1));
    const out = await loadDesignContext(dir);
    assert.ok(out.designReferences);
    assert.equal(out.designReferences.length, 1);
    assert.equal(out.designReferences[0].filename, "real.png");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadDesignContext: design-context + references combined", async () => {
  const dir = tmpRepo();
  try {
    writeFile(path.join(dir, ".conclave", "design-context.md"), "Brand guide.");
    const refDir = path.join(dir, ".conclave", "design-reference");
    mkdirp(refDir);
    fs.writeFileSync(path.join(refDir, "ref.png"), Buffer.alloc(50, 1));
    const out = await loadDesignContext(dir);
    assert.equal(out.designContext, "Brand guide.");
    assert.equal(out.designReferences.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── config schema ──────────────────────────────────────────────────

test("ConclaveConfigSchema: accepts context section with overrides", () => {
  const cfg = ConclaveConfigSchema.parse({
    version: 1,
    context: {
      readmeMaxChars: 200,
      maxDesignReferences: 2,
      maxDesignImageBytes: 100_000,
      includeDesignReferences: false,
    },
  });
  assert.equal(cfg.context.readmeMaxChars, 200);
  assert.equal(cfg.context.maxDesignReferences, 2);
  assert.equal(cfg.context.includeDesignReferences, false);
});

test("ConclaveConfigSchema: context section is optional (v0.6.3 configs still parse)", () => {
  const cfg = ConclaveConfigSchema.parse({ version: 1 });
  assert.equal(cfg.context, undefined);
});

// ── agent prompts: verify projectContext lands in rendered prompts ──

test("agent prompts: claude buildReviewPrompt includes Project context section", async () => {
  const { buildReviewPrompt } = await import("@conclave-ai/agent-claude");
  const prompt = buildReviewPrompt({
    diff: "+x",
    repo: "acme/x",
    pullNumber: 1,
    newSha: "abc",
    projectContext: "## README (head)\nA CLI for widgets.",
  });
  assert.ok(prompt.includes("# Project context"));
  assert.ok(prompt.includes("A CLI for widgets."));
  // Project context must precede the diff.
  assert.ok(prompt.indexOf("Project context") < prompt.indexOf("# Diff"));
});

test("agent prompts: openai buildReviewPrompt includes Project context section", async () => {
  const { buildReviewPrompt } = await import("@conclave-ai/agent-openai");
  const prompt = buildReviewPrompt({
    diff: "+x",
    repo: "acme/x",
    pullNumber: 1,
    newSha: "abc",
    projectContext: "Repo intent here.",
  });
  assert.ok(prompt.includes("# Project context"));
  assert.ok(prompt.includes("Repo intent here."));
});

test("agent prompts: gemini buildReviewPrompt includes Project context section", async () => {
  const { buildReviewPrompt } = await import("@conclave-ai/agent-gemini");
  const prompt = buildReviewPrompt({
    diff: "+x",
    repo: "acme/x",
    pullNumber: 1,
    newSha: "abc",
    projectContext: "Gemini sees intent too.",
  });
  assert.ok(prompt.includes("# Project context"));
  assert.ok(prompt.includes("Gemini sees intent too."));
});

test("agent prompts: claude buildReviewPrompt without projectContext → no section (backward compat)", async () => {
  const { buildReviewPrompt } = await import("@conclave-ai/agent-claude");
  const prompt = buildReviewPrompt({
    diff: "+x",
    repo: "acme/x",
    pullNumber: 1,
    newSha: "abc",
  });
  assert.ok(!prompt.includes("# Project context"));
});

test("agent prompts: design buildUserPrompt includes Project context + Design intent", async () => {
  const { buildUserPrompt } = await import("@conclave-ai/agent-design");
  const prompt = buildUserPrompt(
    {
      diff: "+x",
      repo: "acme/x",
      pullNumber: 1,
      newSha: "abc",
      projectContext: "Product intent.",
      designContext: "Brand: calm.",
    },
    ["/home"],
  );
  assert.ok(prompt.includes("# Project context"));
  assert.ok(prompt.includes("Product intent."));
  assert.ok(prompt.includes("# Design intent"));
  assert.ok(prompt.includes("Brand: calm."));
});

test("agent prompts: claude audit prompt includes Project context", async () => {
  const { buildReviewPrompt } = await import("@conclave-ai/agent-claude");
  const prompt = buildReviewPrompt({
    diff: "file contents here",
    repo: "acme/x",
    pullNumber: 0,
    newSha: "abc",
    mode: "audit",
    auditFiles: ["src/a.ts"],
    projectContext: "Audit me against intent.",
  });
  assert.ok(prompt.includes("# Project context"));
  assert.ok(prompt.includes("Audit me against intent."));
  // Audit prompt shape (not review): "# Audit target" header.
  assert.ok(prompt.includes("# Audit target"));
});
