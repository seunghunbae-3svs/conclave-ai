import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchPrState, classifyTransition } from "../dist/index.js";

function mockRun(response) {
  const calls = [];
  const run = async (bin, args) => {
    calls.push({ bin, args: [...args] });
    return { stdout: typeof response === "function" ? response(bin, args) : response };
  };
  run.calls = calls;
  return run;
}

test("fetchPrState: open PR maps to state=open + headSha", async () => {
  const run = mockRun(
    JSON.stringify({
      state: "OPEN",
      headRefOid: "sha-head",
      updatedAt: "2026-04-19T10:00:00Z",
    }),
  );
  const state = await fetchPrState("acme/app", 42, { run });
  assert.equal(state.state, "open");
  assert.equal(state.headSha, "sha-head");
  assert.equal(state.repo, "acme/app");
  assert.equal(state.prNumber, 42);
  assert.equal(state.mergeCommitSha, undefined);
});

test("fetchPrState: merged PR includes mergeCommitSha", async () => {
  const run = mockRun(
    JSON.stringify({
      state: "MERGED",
      headRefOid: "sha-head",
      mergeCommit: { oid: "sha-merge" },
      updatedAt: "2026-04-19T12:00:00Z",
    }),
  );
  const state = await fetchPrState("acme/app", 7, { run });
  assert.equal(state.state, "merged");
  assert.equal(state.mergeCommitSha, "sha-merge");
});

test("fetchPrState: closed PR maps to state=closed", async () => {
  const run = mockRun(
    JSON.stringify({
      state: "CLOSED",
      headRefOid: "sha-head",
      updatedAt: "2026-04-19T09:00:00Z",
    }),
  );
  const state = await fetchPrState("acme/app", 99, { run });
  assert.equal(state.state, "closed");
});

test("fetchPrState: unknown state string throws", async () => {
  const run = mockRun(JSON.stringify({ state: "WEIRD", headRefOid: "s" }));
  await assert.rejects(() => fetchPrState("acme/app", 1, { run }), /unknown PR state/);
});

test("fetchPrState: missing headRefOid throws", async () => {
  const run = mockRun(JSON.stringify({ state: "OPEN" }));
  await assert.rejects(() => fetchPrState("acme/app", 1, { run }), /missing headRefOid/);
});

test("fetchPrState: invokes gh with --repo + --json flags", async () => {
  const run = mockRun(
    JSON.stringify({ state: "OPEN", headRefOid: "s", updatedAt: "2026-04-19T00:00:00Z" }),
  );
  await fetchPrState("acme/app", 3, { run });
  assert.deepEqual(run.calls[0].args, [
    "pr",
    "view",
    "3",
    "--repo",
    "acme/app",
    "--json",
    "state,mergeCommit,headRefOid,updatedAt",
  ]);
});

test("classifyTransition: merged → merged", () => {
  const out = classifyTransition(
    { repo: "a/b", prNumber: 1, state: "merged", headSha: "x", updatedAt: "" },
    "reviewed-sha",
  );
  assert.equal(out, "merged");
});

test("classifyTransition: closed without merge → rejected", () => {
  const out = classifyTransition(
    { repo: "a/b", prNumber: 1, state: "closed", headSha: "x", updatedAt: "" },
    "reviewed-sha",
  );
  assert.equal(out, "rejected");
});

test("classifyTransition: open with advanced head → reworked", () => {
  const out = classifyTransition(
    { repo: "a/b", prNumber: 1, state: "open", headSha: "new-sha", updatedAt: "" },
    "old-sha",
  );
  assert.equal(out, "reworked");
});

test("classifyTransition: open with same head → pending", () => {
  const out = classifyTransition(
    { repo: "a/b", prNumber: 1, state: "open", headSha: "same-sha", updatedAt: "" },
    "same-sha",
  );
  assert.equal(out, "pending");
});
