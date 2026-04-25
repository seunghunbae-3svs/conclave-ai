import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  addRepo,
  loadRepos,
  removeRepo,
  reposPath,
  isValidSlug,
} from "../dist/lib/repos-config.js";
import { runRepos, parseReposArgv } from "../dist/commands/repos.js";

/**
 * v0.12 — repos / repos-config tests. These exercise the on-disk file
 * format, validation, and the `conclave repos` command shape. We use a
 * scratch HOME via process.env override so the tests don't trash the
 * developer's actual repos.json.
 */

async function withScratchConfigHome(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conclave-repos-test-"));
  const originals = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  };
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.XDG_CONFIG_HOME = path.join(tmp, "config");
  try {
    return await fn(tmp);
  } finally {
    for (const [k, v] of Object.entries(originals)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- 1. slug validation ---------------------------------------------------

test("isValidSlug: accepts owner/name", async () => {
  assert.equal(isValidSlug("seunghunbae-3svs/conclave-ai"), true);
  assert.equal(isValidSlug("ab/cd"), true);
});

test("isValidSlug: rejects malformed inputs", async () => {
  assert.equal(isValidSlug("just-a-name"), false);
  assert.equal(isValidSlug("owner/"), false);
  assert.equal(isValidSlug("/name"), false);
  assert.equal(isValidSlug("owner/name/extra"), false);
  assert.equal(isValidSlug(""), false);
  assert.equal(isValidSlug("owner name"), false);
  assert.equal(isValidSlug("a".repeat(201) + "/x"), false);
});

// ---- 2. on-disk persistence ----------------------------------------------

test("addRepo: persists to disk + loadRepos reads back", async () => {
  await withScratchConfigHome(() => {
    const result1 = addRepo("acme/foo", "2026-04-26T00:00:00.000Z");
    assert.equal(result1.added, true);
    assert.equal(result1.config.repos.length, 1);
    assert.equal(result1.config.repos[0].slug, "acme/foo");
    // re-load via fresh loadRepos call to verify on-disk format
    const reloaded = loadRepos();
    assert.equal(reloaded.repos.length, 1);
    assert.equal(reloaded.repos[0].slug, "acme/foo");
    assert.equal(reloaded.repos[0].addedAt, "2026-04-26T00:00:00.000Z");
  });
});

test("addRepo: idempotent — re-adding the same slug returns added=false", async () => {
  await withScratchConfigHome(() => {
    addRepo("acme/foo");
    const second = addRepo("acme/foo");
    assert.equal(second.added, false);
    assert.equal(second.config.repos.length, 1);
  });
});

test("addRepo: rejects malformed slug", async () => {
  await withScratchConfigHome(() => {
    assert.throws(() => addRepo("not-a-slug"), /invalid repo slug/);
  });
});

test("removeRepo: deletes the entry, reports removed=true", async () => {
  await withScratchConfigHome(() => {
    addRepo("acme/foo");
    addRepo("acme/bar");
    const r = removeRepo("acme/foo");
    assert.equal(r.removed, true);
    assert.equal(r.config.repos.length, 1);
    assert.equal(r.config.repos[0].slug, "acme/bar");
  });
});

test("removeRepo: missing slug returns removed=false (no-op)", async () => {
  await withScratchConfigHome(() => {
    addRepo("acme/foo");
    const r = removeRepo("acme/zzz");
    assert.equal(r.removed, false);
    assert.equal(r.config.repos.length, 1);
  });
});

test("loadRepos: missing file returns empty list (fresh install)", async () => {
  await withScratchConfigHome(() => {
    const cfg = loadRepos();
    assert.equal(cfg.version, 1);
    assert.equal(cfg.repos.length, 0);
  });
});

test("loadRepos: malformed JSON throws path-prefixed message", async () => {
  await withScratchConfigHome((tmp) => {
    // Trigger creation of dir, then write garbage
    addRepo("acme/foo");
    const p = reposPath();
    fs.writeFileSync(p, "{not valid json", "utf8");
    assert.throws(() => loadRepos(), /malformed/);
  });
});

test("loadRepos: silently filters out malformed entries (defensive parse)", async () => {
  await withScratchConfigHome(() => {
    addRepo("acme/foo");
    const p = reposPath();
    const blended = JSON.stringify({
      version: 1,
      repos: [
        { slug: "acme/foo", addedAt: "2026-04-26T00:00:00.000Z" },
        { slug: "INVALID", addedAt: "2026-04-26T00:00:00.000Z" }, // bad slug
        { slug: "acme/bar" }, // missing addedAt
        null,
        { slug: "acme/baz", addedAt: "2026-04-26T00:00:00.000Z", pollIntervalSec: 60 },
      ],
    });
    fs.writeFileSync(p, blended, "utf8");
    const cfg = loadRepos();
    assert.equal(cfg.repos.length, 2);
    assert.equal(cfg.repos[0].slug, "acme/foo");
    assert.equal(cfg.repos[1].slug, "acme/baz");
    assert.equal(cfg.repos[1].pollIntervalSec, 60);
  });
});

// ---- 3. argv parsing ------------------------------------------------------

test("parseReposArgv: empty argv → help", async () => {
  const r = parseReposArgv([]);
  assert.equal(r.subcommand, "help");
});

test("parseReposArgv: add owner/name", async () => {
  const r = parseReposArgv(["add", "acme/foo"]);
  assert.equal(r.subcommand, "add");
  assert.equal(r.slug, "acme/foo");
});

test("parseReposArgv: add without slug → error", async () => {
  const r = parseReposArgv(["add"]);
  assert.match(r.error, /missing/);
});

test("parseReposArgv: add with bad slug → error", async () => {
  const r = parseReposArgv(["add", "not-a-slug"]);
  assert.match(r.error, /doesn't look like/);
});

// ---- 4. command runner ----------------------------------------------------

test("runRepos: list on empty config prints helpful prompt", async () => {
  await withScratchConfigHome(async () => {
    let out = "";
    const code = await runRepos(
      { subcommand: "list" },
      { stdout: (s) => (out += s) },
    );
    assert.equal(code, 0);
    assert.match(out, /watch list is empty/);
  });
});

test("runRepos: add then list shows the entry", async () => {
  await withScratchConfigHome(async () => {
    let out = "";
    await runRepos(
      { subcommand: "add", slug: "acme/foo" },
      { stdout: (s) => (out += s), now: () => "2026-04-26T00:00:00.000Z" },
    );
    assert.match(out, /added acme\/foo/);
    out = "";
    await runRepos(
      { subcommand: "list" },
      { stdout: (s) => (out += s) },
    );
    assert.match(out, /1 repo on watch list/);
    assert.match(out, /acme\/foo/);
  });
});

test("runRepos: remove of missing slug exits 1", async () => {
  await withScratchConfigHome(async () => {
    let err = "";
    const code = await runRepos(
      { subcommand: "remove", slug: "acme/missing" },
      { stderr: (s) => (err += s) },
    );
    assert.equal(code, 1);
    assert.match(err, /was not on the watch list/);
  });
});
