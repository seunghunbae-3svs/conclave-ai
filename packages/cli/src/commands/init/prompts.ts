import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export interface Prompter {
  ask(question: string, opts?: { default?: string; required?: boolean }): Promise<string>;
  confirm(question: string, opts?: { default?: boolean }): Promise<boolean>;
  close(): void;
}

/**
 * readline-based prompter. Deliberately minimal — no fancy color, no
 * arrow-key menus, no external dep. `conclave init` runs once per repo
 * so we trade ergonomics for zero new dependencies and easy testing.
 */
export function createPrompter(): Prompter {
  const rl = createInterface({ input, output });
  return {
    async ask(question, opts = {}) {
      const suffix = opts.default !== undefined ? ` [${opts.default}]` : "";
      const required = opts.required ?? false;
      while (true) {
        const ans = (await rl.question(`${question}${suffix}: `)).trim();
        if (ans) return ans;
        if (opts.default !== undefined) return opts.default;
        if (!required) return "";
        output.write("  required — please enter a value\n");
      }
    },
    async confirm(question, opts = {}) {
      const defaultY = opts.default ?? true;
      const suffix = defaultY ? "[Y/n]" : "[y/N]";
      const ans = (await rl.question(`${question} ${suffix}: `)).trim().toLowerCase();
      if (!ans) return defaultY;
      return ans.startsWith("y");
    },
    close() {
      rl.close();
    },
  };
}

/**
 * Non-interactive prompter for `--yes` mode and for tests. Returns the
 * default for every question, throws if a default-less required prompt
 * is hit (same fail-fast contract as `--yes` — operator must supply all
 * required values up front via flags/env).
 */
export function createNonInteractivePrompter(env: Record<string, string | undefined> = {}): Prompter {
  return {
    async ask(question, opts = {}) {
      if (opts.default !== undefined) return opts.default;
      if (!opts.required) return "";
      throw new Error(
        `conclave init --yes: "${question}" has no default and no value was supplied via env/flag; aborting`,
      );
    },
    async confirm(_question, opts = {}) {
      return opts.default ?? true;
    },
    close() {
      // no-op
    },
  };
}
