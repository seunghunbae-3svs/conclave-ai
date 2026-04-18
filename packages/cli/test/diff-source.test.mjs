import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseRepoSlugFromRemote,
  loadPrDiff,
  loadGitDiff,
  loadFileDiff,
} from "../dist/lib/diff-source.js";

test("parseRepoSlugFromRemote: https URL", () => {
  assert.equal(
    parseRepoSlugFromRemote("https://github.com/acme/my-app.git"),
    "acme/my-app",
  );
});

test("parseRepoSlugFromRemote: ssh URL", () => {
  assert.equal(parseRepoSlugFromRemote("git@github.com:acme/my-app.git"), "acme/my-app");
});

test("parseRepoSlugFromRemote: URL without .git suffix", () => {
  assert.equal(parseRepoSlugFromRemote("https://github.com/acme/my-app"), "acme/my-app");
});

test("parseRepoSlugFromRemote: unparseable returns null", () => {
  assert.equal(parseRepoSlugFromRemote("not a url"), null);
  assert.equal(parseRepoSlugFromRemote(""), null);
});

test("loadPrDiff: builds a LoadedDiff from mocked gh output", async () => {
  const exec = async (bin, args) => {
    if (bin !== "gh") throw new Error(`unexpected bin ${bin}`);
    if (args[0] === "pr" && args[1] === "diff") {
      return { stdout: "diff --git a/x b/x\n+added" };
    }
    if (args[0] === "pr" && args[1] === "view") {
      return {
        stdout: JSON.stringify({
          headRefOid: "sha-head",
          baseRefOid: "sha-base",
          headRepository: { name: "my-app" },
          headRepositoryOwner: { login: "acme" },
          number: 42,
        }),
      };
    }
    throw new Error(`unexpected args ${args.join(" ")}`);
  };
  const loaded = await loadPrDiff(42, { execFile: exec });
  assert.equal(loaded.source, "gh-pr");
  assert.equal(loaded.repo, "acme/my-app");
  assert.equal(loaded.pullNumber, 42);
  assert.equal(loaded.newSha, "sha-head");
  assert.equal(loaded.prevSha, "sha-base");
  assert.match(loaded.diff, /\+added/);
});

test("loadPrDiff: missing repo owner throws actionable error", async () => {
  const exec = async (_bin, args) => {
    if (args[0] === "pr" && args[1] === "diff") return { stdout: "" };
    if (args[0] === "pr" && args[1] === "view") {
      return { stdout: JSON.stringify({ headRefOid: "x", number: 1 }) };
    }
    throw new Error("unexpected");
  };
  await assert.rejects(() => loadPrDiff(1, { execFile: exec }), /did not return repo owner/);
});

test("loadGitDiff: assembles from mocked git commands", async () => {
  const exec = async (bin, args) => {
    if (bin !== "git") throw new Error("unexpected bin");
    if (args[0] === "diff") return { stdout: "diff --git a/y b/y\n+y" };
    if (args[0] === "rev-parse" && args[1] === "HEAD") return { stdout: "head-sha\n" };
    if (args[0] === "rev-parse") return { stdout: "base-sha\n" };
    if (args[0] === "remote") return { stdout: "https://github.com/acme/widget.git\n" };
    return { stdout: "" };
  };
  const loaded = await loadGitDiff("origin/main", { execFile: exec });
  assert.equal(loaded.source, "git-diff");
  assert.equal(loaded.repo, "acme/widget");
  assert.equal(loaded.newSha, "head-sha");
  assert.equal(loaded.prevSha, "base-sha");
});

test("loadGitDiff: missing remote fallbacks to local/unknown", async () => {
  const exec = async (bin, args) => {
    if (args[0] === "diff") return { stdout: "diff" };
    if (args[0] === "rev-parse" && args[1] === "HEAD") return { stdout: "sha\n" };
    if (args[0] === "remote") {
      const err = new Error("no remote");
      throw err;
    }
    return { stdout: "" };
  };
  const loaded = await loadGitDiff("origin/main", { execFile: exec });
  assert.equal(loaded.repo, "local/unknown");
});

test("loadFileDiff: reads diff content from injected readFile", async () => {
  const loaded = await loadFileDiff("/tmp/x.diff", {
    readFile: async (p) => {
      assert.equal(p, "/tmp/x.diff");
      return "diff --git a/a b/a\n-old\n+new";
    },
  });
  assert.equal(loaded.source, "file");
  assert.equal(loaded.repo, "local/file");
  assert.match(loaded.diff, /\+new/);
});
