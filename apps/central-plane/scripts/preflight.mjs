#!/usr/bin/env node
/**
 * Preflight check for migrate / ship scripts. Catches the common footgun
 * where `wrangler.toml` still has the placeholder `database_id` because the
 * operator skipped `wrangler d1 create` or forgot to paste the output.
 *
 * We'd rather fail with a pointed error than hand a 500 "import failed" to
 * the user from the Cloudflare API.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const wranglerPath = path.resolve(here, "..", "wrangler.toml");

const PLACEHOLDER_RE = /REPLACE_WITH_/;

try {
  const content = await readFile(wranglerPath, "utf8");
  if (PLACEHOLDER_RE.test(content)) {
    const lines = content
      .split(/\r?\n/)
      .map((line, i) => ({ line, idx: i }))
      .filter(({ line }) => PLACEHOLDER_RE.test(line))
      .map(({ line, idx }) => `  line ${idx + 1}: ${line.trim()}`);
    process.stderr.write(
      [
        "",
        "conclave central-plane preflight: wrangler.toml has placeholder values.",
        "",
        ...lines,
        "",
        "Fix:",
        "  1. wrangler d1 create conclave-ai         # one-time, prints a UUID",
        "  2. edit wrangler.toml, replace REPLACE_WITH_... with the UUID",
        "  3. retry your command",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }
} catch (err) {
  process.stderr.write(`conclave preflight: could not read ${wranglerPath}: ${(err && err.message) || err}\n`);
  process.exit(1);
}
