import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../dist/index.js";

test("cli: run is exported", () => {
  assert.equal(typeof run, "function");
});

test("cli: --version prints 0.0.0 to stdout", async () => {
  const chunks = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => {
    chunks.push(String(c));
    return true;
  };
  try {
    await run(["--version"]);
  } finally {
    process.stdout.write = origWrite;
  }
  assert.match(chunks.join(""), /0\.0\.0/);
});
