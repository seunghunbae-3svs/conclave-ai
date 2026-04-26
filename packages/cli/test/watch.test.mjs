import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseWatchArgv,
  runWatch,
} from "../dist/commands/watch.js";
import {
  diffPolls,
  pollOpenPrs,
  dispatchReviewWorkflow,
} from "../dist/lib/notification-poller.js";

/**
 * v0.12 — `conclave watch` + notification-poller tests.
 */

// ---- 1. argv parsing ------------------------------------------------------

test("parseWatchArgv: defaults", () => {
  const r = parseWatchArgv([]);
  assert.equal(r.intervalSec, 30);
  assert.equal(r.workflow, "conclave-review.yml");
  assert.equal(r.once, false);
  assert.equal(r.includeDrafts, false);
  assert.equal(r.includeBots, false);
});

test("parseWatchArgv: --interval clamps to MIN", () => {
  const r = parseWatchArgv(["--interval", "1"]);
  assert.match(r.error, /≥ 5/);
});

test("parseWatchArgv: --once + flags", () => {
  const r = parseWatchArgv(["--once", "--include-drafts", "--workflow", "custom.yml"]);
  assert.equal(r.once, true);
  assert.equal(r.includeDrafts, true);
  assert.equal(r.workflow, "custom.yml");
});

test("parseWatchArgv: unknown flag → error", () => {
  const r = parseWatchArgv(["--xyz"]);
  assert.match(r.error, /unknown arg/);
});

// ---- 2. diffPolls ---------------------------------------------------------

const mkPr = (overrides = {}) => ({
  repoSlug: "acme/foo",
  number: 1,
  headSha: "aaaa1111",
  title: "test pr",
  state: "open",
  updatedAt: "2026-04-26T00:00:00Z",
  authorLogin: "alice",
  draft: false,
  ...overrides,
});

test("diffPolls: identifies new PRs", () => {
  const prev = new Map();
  const cur = [mkPr({ number: 1 }), mkPr({ number: 2 })];
  const d = diffPolls(prev, cur);
  assert.equal(d.newPrs.length, 2);
  assert.equal(d.updated.length, 0);
  assert.equal(d.closed.length, 0);
});

test("diffPolls: head sha change → updated, not new", () => {
  const prev = new Map([
    ["acme/foo#1", mkPr({ number: 1, headSha: "old" })],
  ]);
  const cur = [mkPr({ number: 1, headSha: "new" })];
  const d = diffPolls(prev, cur);
  assert.equal(d.newPrs.length, 0);
  assert.equal(d.updated.length, 1);
  assert.equal(d.updated[0].headSha, "new");
});

test("diffPolls: PR absent in current → closed", () => {
  const prev = new Map([
    ["acme/foo#1", mkPr({ number: 1 })],
    ["acme/foo#2", mkPr({ number: 2 })],
  ]);
  const cur = [mkPr({ number: 1 })];
  const d = diffPolls(prev, cur);
  assert.equal(d.closed.length, 1);
  assert.equal(d.closed[0], "acme/foo#2");
});

test("diffPolls: same head sha → neither new nor updated (steady state)", () => {
  const prev = new Map([
    ["acme/foo#1", mkPr({ number: 1, headSha: "abc" })],
  ]);
  const cur = [mkPr({ number: 1, headSha: "abc" })];
  const d = diffPolls(prev, cur);
  assert.equal(d.newPrs.length, 0);
  assert.equal(d.updated.length, 0);
});

// ---- 3. pollOpenPrs (with mocked gh) --------------------------------------

test("pollOpenPrs: parses gh api response into snapshots", async () => {
  const ghRun = async (cmd, args) => {
    assert.equal(cmd, "gh");
    assert.deepEqual(args, ["api", "repos/acme/foo/pulls?state=open&per_page=50"]);
    return {
      stdout: JSON.stringify([
        {
          number: 7,
          title: "fix things",
          state: "open",
          head: { sha: "deadbeef" },
          user: { login: "alice" },
          draft: false,
          updated_at: "2026-04-26T01:00:00Z",
        },
      ]),
      stderr: "",
    };
  };
  const prs = await pollOpenPrs("acme/foo", { ghRun });
  assert.equal(prs.length, 1);
  assert.equal(prs[0].number, 7);
  assert.equal(prs[0].headSha, "deadbeef");
  assert.equal(prs[0].authorLogin, "alice");
});

test("pollOpenPrs: skips entries without head.sha", async () => {
  const ghRun = async () => ({
    stdout: JSON.stringify([
      { number: 1, head: { sha: "ok" }, state: "open", user: { login: "u" }, draft: false, title: "ok", updated_at: "" },
      { number: 2, head: {}, state: "open", user: { login: "u" }, draft: false, title: "no-sha", updated_at: "" },
    ]),
    stderr: "",
  });
  const prs = await pollOpenPrs("acme/foo", { ghRun });
  assert.equal(prs.length, 1);
  assert.equal(prs[0].number, 1);
});

test("pollOpenPrs: ENOENT → friendly install hint", async () => {
  const ghRun = async () => {
    const err = Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
    throw err;
  };
  await assert.rejects(
    pollOpenPrs("acme/foo", { ghRun }),
    /gh.*CLI not found/,
  );
});

// ---- 4. dispatchReviewWorkflow --------------------------------------------

test("dispatchReviewWorkflow: invokes gh workflow run with -f pr_number=N", async () => {
  let captured;
  const ghRun = async (cmd, args) => {
    captured = { cmd, args };
    return { stdout: "", stderr: "" };
  };
  await dispatchReviewWorkflow(
    {
      repoSlug: "acme/foo",
      number: 12,
      headSha: "x",
      title: "t",
      state: "open",
      updatedAt: "",
      authorLogin: "alice",
      draft: false,
    },
    "conclave-review.yml",
    { ghRun },
  );
  assert.deepEqual(captured.args, [
    "workflow",
    "run",
    "conclave-review.yml",
    "--repo",
    "acme/foo",
    "-f",
    "pr_number=12",
  ]);
});

// ---- 5. runWatch (full loop with mocked gh) -------------------------------

test("runWatch: empty watch list → exit 2", async () => {
  let err = "";
  const result = await runWatch(parseWatchArgv(["--once"]), {
    stdout: () => {},
    stderr: (s) => {
      err += s;
    },
    loadReposFn: () => ({ version: 1, repos: [] }),
  });
  assert.equal(result.code, 2);
  assert.match(err, /watch list is empty/);
});

test("runWatch: dispatches new PR in first cycle", async () => {
  let dispatched = [];
  const result = await runWatch(parseWatchArgv(["--once"]), {
    stdout: () => {},
    stderr: () => {},
    loadReposFn: () => ({
      version: 1,
      repos: [{ slug: "acme/foo", addedAt: "2026-04-26T00:00:00Z" }],
    }),
    pollFn: async () => [mkPr({ number: 5 })],
    dispatchFn: async (pr, wf) => {
      dispatched.push({ slug: pr.repoSlug, number: pr.number, workflow: wf });
    },
  });
  assert.equal(result.code, 0);
  assert.equal(result.cycles, 1);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].number, 5);
  assert.equal(dispatched[0].workflow, "conclave-review.yml");
});

test("runWatch: skips drafts by default + bot authors", async () => {
  let dispatched = [];
  await runWatch(parseWatchArgv(["--once"]), {
    stdout: () => {},
    stderr: () => {},
    loadReposFn: () => ({
      version: 1,
      repos: [{ slug: "acme/foo", addedAt: "" }],
    }),
    pollFn: async () => [
      mkPr({ number: 1, draft: true }),
      mkPr({ number: 2, authorLogin: "dependabot[bot]" }),
      mkPr({ number: 3, authorLogin: "alice" }),
    ],
    dispatchFn: async (pr) => {
      dispatched.push(pr.number);
    },
  });
  // Only #3 (non-draft, human author) gets dispatched.
  assert.deepEqual(dispatched, [3]);
});

test("runWatch: --include-drafts overrides draft skip", async () => {
  let dispatched = [];
  await runWatch(parseWatchArgv(["--once", "--include-drafts"]), {
    stdout: () => {},
    stderr: () => {},
    loadReposFn: () => ({
      version: 1,
      repos: [{ slug: "acme/foo", addedAt: "" }],
    }),
    pollFn: async () => [mkPr({ number: 1, draft: true })],
    dispatchFn: async (pr) => {
      dispatched.push(pr.number);
    },
  });
  assert.deepEqual(dispatched, [1]);
});

test("runWatch: head sha change in 2nd cycle → re-dispatch as 'updated'", async () => {
  let dispatched = [];
  let cycleCount = 0;
  await runWatch(parseWatchArgv(["--interval", "5"]), {
    stdout: () => {},
    stderr: () => {},
    loadReposFn: () => ({
      version: 1,
      repos: [{ slug: "acme/foo", addedAt: "" }],
    }),
    pollFn: async () => {
      cycleCount += 1;
      const sha = cycleCount === 1 ? "old-sha" : "new-sha";
      return [mkPr({ number: 1, headSha: sha })];
    },
    dispatchFn: async (pr) => {
      dispatched.push({ number: pr.number, headSha: pr.headSha });
    },
    sleep: async () => {}, // skip the 5s wait
    maxCycles: 2,
  });
  // First cycle: new PR → dispatched at old-sha. Second cycle: head sha
  // changed → dispatched again at new-sha.
  assert.equal(dispatched.length, 2);
  assert.equal(dispatched[0].headSha, "old-sha");
  assert.equal(dispatched[1].headSha, "new-sha");
});

test("runWatch: same head sha across cycles → not re-dispatched", async () => {
  let dispatched = 0;
  await runWatch(parseWatchArgv(["--interval", "5"]), {
    stdout: () => {},
    stderr: () => {},
    loadReposFn: () => ({
      version: 1,
      repos: [{ slug: "acme/foo", addedAt: "" }],
    }),
    pollFn: async () => [mkPr({ number: 1, headSha: "stable" })],
    dispatchFn: async () => {
      dispatched += 1;
    },
    sleep: async () => {},
    maxCycles: 3,
  });
  // First cycle dispatches once (PR is new). Subsequent cycles see no
  // change → no further dispatch.
  assert.equal(dispatched, 1);
});

test("runWatch: per-repo poll failure does not stop the loop", async () => {
  let dispatched = 0;
  let stderrText = "";
  await runWatch(parseWatchArgv(["--once"]), {
    stdout: () => {},
    stderr: (s) => {
      stderrText += s;
    },
    loadReposFn: () => ({
      version: 1,
      repos: [
        { slug: "acme/broken", addedAt: "" },
        { slug: "acme/healthy", addedAt: "" },
      ],
    }),
    pollFn: async (slug) => {
      if (slug === "acme/broken") throw new Error("simulated poll failure");
      return [mkPr({ repoSlug: slug, number: 1 })];
    },
    dispatchFn: async () => {
      dispatched += 1;
    },
  });
  assert.equal(dispatched, 1);
  assert.match(stderrText, /acme\/broken poll failed/);
});
