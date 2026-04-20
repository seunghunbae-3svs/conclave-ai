import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  parseArgv,
  runInit,
} from "../dist/commands/init.js";
import { parseRemoteUrl, detectRepo } from "../dist/commands/init/repo-detect.js";
import { writeConfig, buildConfigFor, CONFIG_FILENAME, DEFAULT_CONFIG } from "../dist/commands/init/config-writer.js";
import { writeWorkflow, WORKFLOW_PATH, WORKFLOW_CONTENT, REUSABLE_REF } from "../dist/commands/init/workflow-writer.js";

// ---- parseArgv ------------------------------------------------------------

test("parseArgv: defaults", () => {
  const a = parseArgv([]);
  assert.equal(a.yes, false);
  assert.equal(a.reconfigure, false);
  assert.equal(a.cwd, ".");
  assert.equal(a.repo, undefined);
});

test("parseArgv: --yes + --reconfigure + --repo", () => {
  const a = parseArgv(["--yes", "--reconfigure", "--repo", "acme/x", "--cwd", "/tmp/x"]);
  assert.equal(a.yes, true);
  assert.equal(a.reconfigure, true);
  assert.equal(a.repo, "acme/x");
  assert.equal(a.cwd, "/tmp/x");
});

// ---- parseRemoteUrl -------------------------------------------------------

test("parseRemoteUrl: https with .git suffix", () => {
  const r = parseRemoteUrl("https://github.com/acme/service.git");
  assert.deepEqual({ owner: r.owner, name: r.name, slug: r.slug }, { owner: "acme", name: "service", slug: "acme/service" });
});

test("parseRemoteUrl: https without .git suffix", () => {
  const r = parseRemoteUrl("https://github.com/acme/service");
  assert.equal(r.slug, "acme/service");
});

test("parseRemoteUrl: ssh scp-like git@github.com:owner/name.git", () => {
  const r = parseRemoteUrl("git@github.com:acme/service.git");
  assert.equal(r.slug, "acme/service");
});

test("parseRemoteUrl: ssh:// protocol form", () => {
  const r = parseRemoteUrl("ssh://git@github.com/acme/service.git");
  assert.equal(r.slug, "acme/service");
});

test("parseRemoteUrl: rejects non-GitHub hosts loud", () => {
  assert.equal(parseRemoteUrl("https://gitlab.com/acme/service.git"), null);
  assert.equal(parseRemoteUrl("git@bitbucket.org:acme/service.git"), null);
});

test("parseRemoteUrl: rejects malformed / empty", () => {
  assert.equal(parseRemoteUrl(""), null);
  assert.equal(parseRemoteUrl("not-a-url"), null);
  assert.equal(parseRemoteUrl("https://github.com/owner-only"), null);
});

test("parseRemoteUrl: handles trailing slash", () => {
  const r = parseRemoteUrl("https://github.com/acme/service/");
  assert.equal(r.slug, "acme/service");
});

// ---- detectRepo -----------------------------------------------------------

test("detectRepo: calls `git remote get-url origin` with injected runner", async () => {
  const calls = [];
  const run = async (bin, args, opts) => {
    calls.push({ bin, args: [...args], cwd: opts?.cwd });
    return { stdout: "https://github.com/acme/service.git\n" };
  };
  const r = await detectRepo({ run, cwd: "/workspace" });
  assert.equal(r.slug, "acme/service");
  assert.deepEqual(calls[0].args, ["remote", "get-url", "origin"]);
  assert.equal(calls[0].cwd, "/workspace");
});

test("detectRepo: throws friendly error when runner fails", async () => {
  const run = async () => {
    throw new Error("fatal: not a git repository");
  };
  await assert.rejects(() => detectRepo({ run }), /could not read git remote/);
});

test("detectRepo: throws when remote is not GitHub", async () => {
  const run = async () => ({ stdout: "https://gitlab.com/acme/service.git\n" });
  await assert.rejects(() => detectRepo({ run }), /could not parse git remote/);
});

// ---- config-writer --------------------------------------------------------

async function mkTmpDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("buildConfigFor: base config has v0.4 defaults", () => {
  const c = buildConfigFor("acme/service");
  assert.equal(c.version, 1);
  assert.equal(c.repo, "acme/service");
  assert.equal(c.budget.perPrUsd, 2.0);
  assert.equal(c.sharing.mode, "hashes");
  assert.deepEqual(c.agents, ["claude", "openai", "gemini"]);
  assert.equal(c.integrations.telegram.enabled, true);
});

test("buildConfigFor: filters agents to selected-only", () => {
  const c = buildConfigFor("acme/service", ["claude"]);
  assert.deepEqual(c.agents, ["claude"]);
  assert.deepEqual(c.council.domains.code.tier1, ["claude"]);
  assert.deepEqual(c.council.domains.code.tier2, ["claude"]);
});

test("writeConfig: creates new file with repo slug", async () => {
  const dir = await mkTmpDir("conclave-init-");
  try {
    const r = await writeConfig({ cwd: dir, repoSlug: "acme/service" });
    assert.equal(r.created, true);
    assert.equal(r.skipped, false);
    const written = JSON.parse(await fs.readFile(r.path, "utf8"));
    assert.equal(written.repo, "acme/service");
    assert.equal(written.version, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("writeConfig: skips existing file unless force=true", async () => {
  const dir = await mkTmpDir("conclave-init-");
  try {
    await writeConfig({ cwd: dir, repoSlug: "first/repo" });
    const r2 = await writeConfig({ cwd: dir, repoSlug: "second/repo" });
    assert.equal(r2.skipped, true);
    assert.equal(r2.created, false);
    const still = JSON.parse(await fs.readFile(r2.path, "utf8"));
    assert.equal(still.repo, "first/repo");

    const r3 = await writeConfig({ cwd: dir, repoSlug: "third/repo", force: true });
    assert.equal(r3.created, true);
    const overwritten = JSON.parse(await fs.readFile(r3.path, "utf8"));
    assert.equal(overwritten.repo, "third/repo");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---- workflow-writer ------------------------------------------------------

test("writeWorkflow: creates file with reusable-workflow ref", async () => {
  const dir = await mkTmpDir("conclave-init-");
  try {
    const r = await writeWorkflow({ cwd: dir });
    assert.equal(r.created, true);
    const body = await fs.readFile(r.path, "utf8");
    assert.ok(body.includes(REUSABLE_REF), `workflow body missing ref: ${REUSABLE_REF}`);
    assert.ok(body.includes("secrets: inherit"), "workflow body missing secrets: inherit");
    assert.ok(body.includes("pull_request"), "workflow body missing pull_request trigger");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("writeWorkflow: mkdir -p on .github/workflows", async () => {
  const dir = await mkTmpDir("conclave-init-");
  try {
    const r = await writeWorkflow({ cwd: dir });
    assert.equal(path.relative(dir, r.path), path.join(".github", "workflows", "conclave.yml"));
    const stat = await fs.stat(r.path);
    assert.ok(stat.isFile());
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("writeWorkflow: skips existing unless force=true", async () => {
  const dir = await mkTmpDir("conclave-init-");
  try {
    await fs.mkdir(path.join(dir, ".github", "workflows"), { recursive: true });
    await fs.writeFile(path.join(dir, ".github", "workflows", "conclave.yml"), "# user edits\n");
    const r = await writeWorkflow({ cwd: dir });
    assert.equal(r.skipped, true);
    const still = await fs.readFile(r.path, "utf8");
    assert.equal(still, "# user edits\n");

    const r2 = await writeWorkflow({ cwd: dir, force: true });
    assert.equal(r2.created, true);
    const overwritten = await fs.readFile(r2.path, "utf8");
    assert.ok(overwritten.includes(REUSABLE_REF));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---- runInit orchestrator (DI) -------------------------------------------

function makePrompter(answers = {}) {
  const calls = [];
  return {
    calls,
    async ask(q) {
      calls.push(q);
      return answers[calls.length - 1] ?? "";
    },
    async confirm() {
      return true;
    },
    close() {},
  };
}

test("runInit: happy path with explicit --repo, no keys → all stubs, files written", async () => {
  const dir = await mkTmpDir("conclave-init-");
  const stdout = [];
  const stderr = [];
  try {
    const code = await runInit(
      { yes: true, reconfigure: false, repo: "acme/service", cwd: dir, skipOauth: true, help: false },
      {
        prompter: makePrompter(),
        stdout: (s) => stdout.push(s),
        stderr: (s) => stderr.push(s),
      },
    );
    assert.equal(code, 0, stderr.join(""));
    const cfg = JSON.parse(await fs.readFile(path.join(dir, CONFIG_FILENAME), "utf8"));
    assert.equal(cfg.repo, "acme/service");
    const wf = await fs.readFile(path.join(dir, WORKFLOW_PATH), "utf8");
    assert.ok(wf.includes(REUSABLE_REF));
    const outJoined = stdout.join("");
    assert.ok(outJoined.includes("• repo: acme/service"));
    assert.ok(outJoined.includes("conclave init complete"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("runInit: existing config + no --reconfigure → skip both writes", async () => {
  const dir = await mkTmpDir("conclave-init-");
  const stdout = [];
  try {
    // seed files
    await fs.writeFile(path.join(dir, CONFIG_FILENAME), '{"version":1,"repo":"pre/existing"}\n');
    await fs.mkdir(path.join(dir, ".github", "workflows"), { recursive: true });
    await fs.writeFile(path.join(dir, ".github", "workflows", "conclave.yml"), "# user edit\n");

    const code = await runInit(
      { yes: true, reconfigure: false, repo: "acme/service", cwd: dir, skipOauth: true, help: false },
      { prompter: makePrompter(), stdout: (s) => stdout.push(s), stderr: () => {} },
    );
    assert.equal(code, 0);
    const cfg = JSON.parse(await fs.readFile(path.join(dir, CONFIG_FILENAME), "utf8"));
    assert.equal(cfg.repo, "pre/existing"); // unchanged
    const wf = await fs.readFile(path.join(dir, ".github", "workflows", "conclave.yml"), "utf8");
    assert.equal(wf, "# user edit\n"); // unchanged
    assert.ok(stdout.join("").includes("skip:"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("runInit: --reconfigure overwrites both files", async () => {
  const dir = await mkTmpDir("conclave-init-");
  try {
    await fs.writeFile(path.join(dir, CONFIG_FILENAME), '{"repo":"old/repo"}\n');
    const code = await runInit(
      { yes: true, reconfigure: true, repo: "new/repo", cwd: dir, skipOauth: true, help: false },
      { prompter: makePrompter(), stdout: () => {}, stderr: () => {} },
    );
    assert.equal(code, 0);
    const cfg = JSON.parse(await fs.readFile(path.join(dir, CONFIG_FILENAME), "utf8"));
    assert.equal(cfg.repo, "new/repo");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("runInit: no --repo + git remote fails → exit 1 with helpful message", async () => {
  const stderr = [];
  const code = await runInit(
    { yes: true, reconfigure: false, cwd: ".", skipOauth: true, help: false },
    {
      prompter: makePrompter(),
      detectRepoDeps: {
        run: async () => {
          throw new Error("fatal: not a git repository");
        },
      },
      stdout: () => {},
      stderr: (s) => stderr.push(s),
    },
  );
  assert.equal(code, 1);
  assert.ok(stderr.join("").includes("could not read git remote"));
});

test("runInit: collected API keys narrow the written agent set", async () => {
  const dir = await mkTmpDir("conclave-init-");
  try {
    const code = await runInit(
      { yes: false, reconfigure: false, repo: "acme/service", cwd: dir, skipOauth: true, help: false },
      {
        // prompt answers in order: ANTHROPIC / OPENAI / GEMINI
        prompter: makePrompter({ 0: "sk-ant-xxx", 1: "", 2: "" }),
        stdout: () => {},
        stderr: () => {},
      },
    );
    assert.equal(code, 0);
    const cfg = JSON.parse(await fs.readFile(path.join(dir, CONFIG_FILENAME), "utf8"));
    assert.deepEqual(cfg.agents, ["claude"]);
    assert.deepEqual(cfg.council.domains.code.tier1, ["claude"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
