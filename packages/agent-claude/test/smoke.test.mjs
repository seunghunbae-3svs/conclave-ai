import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAgent } from "../dist/index.js";

test("agent-claude: ClaudeAgent is exported", () => {
  assert.equal(typeof ClaudeAgent, "function");
});
