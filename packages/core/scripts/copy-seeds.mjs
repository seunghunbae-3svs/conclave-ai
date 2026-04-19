#!/usr/bin/env node
/**
 * tsc does not copy non-TS files. Post-build step that mirrors the
 * seeds/ directory from src/memory/seeds → dist/memory/seeds so the
 * bundled legacy failure-catalog JSON is available at runtime.
 */
import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const from = path.join(pkgRoot, "src", "memory", "seeds");
const to = path.join(pkgRoot, "dist", "memory", "seeds");

if (!existsSync(from)) {
  console.log(`[copy-seeds] nothing to copy (src/memory/seeds not found)`);
  process.exit(0);
}
mkdirSync(path.dirname(to), { recursive: true });
cpSync(from, to, { recursive: true });
console.log(`[copy-seeds] copied ${from} → ${to}`);
