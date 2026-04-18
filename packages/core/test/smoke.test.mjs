import { test } from "node:test";
import assert from "node:assert/strict";
import { Council } from "../dist/index.js";

test("core: Council is exported from @ai-conclave/core", () => {
  assert.equal(typeof Council, "function");
});

test("core: Council empty agents throws", () => {
  assert.throws(() => new Council({ agents: [] }), /at least one agent/);
});
