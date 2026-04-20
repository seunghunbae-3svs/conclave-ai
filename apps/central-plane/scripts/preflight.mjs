#!/usr/bin/env node
/**
 * Preflight check for migrate / ship scripts.
 *
 * Checks ONLY fields that are load-bearing at the invocation level:
 *   - `database_id` must be real (needed by both migrate:prod and ship)
 *
 * Fields that are runtime-optional (e.g. `GITHUB_CLIENT_ID` — unset just
 * makes /oauth/device/* return 503 until it's provided) are NOT checked.
 * Blocking on them forces operators to register OAuth before they can
 * even deploy, which is backwards: deploy first, then register OAuth
 * once the Worker URL is known (GitHub OAuth App requires that URL).
 *
 * Comments in wrangler.toml are ignored. Only uncommented key=value
 * lines are inspected.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const wranglerPath = path.resolve(here, "..", "wrangler.toml");

const REQUIRED_FIELDS = ["database_id"];

function parseAssignments(toml) {
  // Extremely narrow TOML reader — only what this preflight needs.
  // Skips lines that are comments (start with # after any whitespace)
  // or inside-quoted values are treated as full-line comments if the
  // very first non-whitespace char is #.
  const out = new Map();
  for (const rawLine of toml.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("[")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip inline comment starting with " #" (space-hash) — TOML uses
    // # but quoted strings can contain #. We only look at the UNQUOTED
    // suffix. This heuristic is fine for our curated wrangler.toml.
    if (value.startsWith('"')) {
      const closeQuote = value.indexOf('"', 1);
      if (closeQuote > 0) value = value.slice(0, closeQuote + 1);
    }
    // Unquote string values for placeholder comparison.
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    out.set(key, value);
  }
  return out;
}

try {
  const content = await readFile(wranglerPath, "utf8");
  const assignments = parseAssignments(content);
  const failures = [];
  for (const field of REQUIRED_FIELDS) {
    const v = assignments.get(field);
    if (!v || v.startsWith("REPLACE_WITH_")) {
      failures.push({ field, value: v ?? "(missing)" });
    }
  }
  if (failures.length > 0) {
    process.stderr.write(
      [
        "",
        "conclave central-plane preflight: wrangler.toml needs these before deploy/migrate:",
        "",
        ...failures.map((f) => `  ${f.field} = ${JSON.stringify(f.value)}`),
        "",
        "Fix:",
        "  1. wrangler d1 create conclave-ai      # one-time; prints a UUID",
        "  2. paste the UUID into wrangler.toml as database_id",
        "  3. retry your command",
        "",
        "(GITHUB_CLIENT_ID placeholder is OK at deploy time — runtime returns 503",
        " from /oauth/device/* until you set it. Deploy first, register OAuth second.)",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }
} catch (err) {
  process.stderr.write(`conclave preflight: could not read ${wranglerPath}: ${(err && err.message) || err}\n`);
  process.exit(1);
}
