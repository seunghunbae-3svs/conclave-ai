import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export interface Prompter {
  ask(question: string, opts?: { default?: string; required?: boolean }): Promise<string>;
  /**
   * Prompt for a sensitive value (API key, token). Input is not echoed;
   * each character shows as `*` so the user can see the length.
   * Falls back to `ask` when stdin is not a TTY (CI, piped input).
   */
  askSecret(question: string, opts?: { required?: boolean }): Promise<string>;
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
    async askSecret(question, opts = {}) {
      const required = opts.required ?? false;
      while (true) {
        const ans = (await readMaskedLine(`${question}: `)).trim();
        if (ans) return ans;
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
 * Read a line from stdin with each character echoed as `*`. Uses raw
 * mode for masked input. Falls back to plain readline when stdin is
 * not a TTY (CI piped input) — in that case the input is still not
 * echoed (since the source isn't a terminal), so no leakage.
 */
function readMaskedLine(prompt: string): Promise<string> {
  output.write(prompt);
  const isTTY = input.isTTY === true;
  if (!isTTY) {
    return new Promise<string>((resolve) => {
      let buf = "";
      const onData = (chunk: Buffer | string) => {
        buf += chunk.toString("utf8");
        const nl = buf.indexOf("\n");
        if (nl >= 0) {
          input.removeListener("data", onData);
          input.pause();
          resolve(buf.slice(0, nl).replace(/\r$/, ""));
        }
      };
      input.resume();
      input.on("data", onData);
    });
  }
  return new Promise<string>((resolve) => {
    let buffer = "";
    const originalRaw = input.isRaw ?? false;
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    const finish = () => {
      input.removeListener("data", onData);
      input.setRawMode(originalRaw);
      input.pause();
      output.write("\n");
      resolve(buffer);
    };
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n") {
          finish();
          return;
        }
        if (c === "\u0003") {
          input.setRawMode(originalRaw);
          process.exit(130);
        }
        if (c === "\u0004" && buffer.length === 0) {
          finish();
          return;
        }
        if (c === "\u007f" || c === "\b") {
          if (buffer.length > 0) {
            buffer = buffer.slice(0, -1);
            output.write("\b \b");
          }
          continue;
        }
        buffer += c;
        output.write("*");
      }
    };
    input.on("data", onData);
  });
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
    async askSecret(question, opts = {}) {
      if (!opts.required) return "";
      throw new Error(
        `conclave init --yes: secret "${question}" has no value; set it via env/flag before running`,
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
