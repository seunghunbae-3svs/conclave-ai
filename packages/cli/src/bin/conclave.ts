#!/usr/bin/env node
import { run } from "../index.js";

run(process.argv.slice(2)).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`conclave: ${msg}\n`);
  process.exit(1);
});
