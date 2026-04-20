import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { run } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));

test("cli: run is exported", () => {
  assert.equal(typeof run, "function");
});

test("cli: --version prints package.json version to stdout", async () => {
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
  assert.equal(chunks.join("").trim(), pkg.version);
});
