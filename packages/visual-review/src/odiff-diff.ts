import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import type { DiffOptions, DiffResult, VisualDiff } from "./diff.js";

export interface OdiffAdapterOptions {
  /** Override the resolved odiff binary. Useful for tests + custom installs. */
  binaryPath?: string;
  /** Provide an explicit spawn function for tests. Default `child_process.spawn`. */
  spawner?: (cmd: string, args: readonly string[]) => {
    stdout: { on(event: "data", cb: (chunk: Buffer) => void): void };
    stderr: { on(event: "data", cb: (chunk: Buffer) => void): void };
    on(event: "close" | "error", cb: (arg: number | Error) => void): void;
  };
}

/**
 * OdiffDiff — wraps `odiff-bin` (a Zig port of odiff, ~6-8× faster than
 * pixelmatch on large images) behind the same `VisualDiff` interface as
 * `PixelmatchDiff`. Opt-in; the shipping default stays pixelmatch because
 * odiff is an out-of-process CLI and the fork + file I/O eats the
 * speed win for small diffs.
 *
 * Size-mismatched inputs are padded with opaque magenta (matching
 * PixelmatchDiff's behavior) before invocation so the DiffResult shape
 * is interchangeable.
 */
export class OdiffDiff implements VisualDiff {
  readonly id = "odiff";
  private readonly binaryPath: string | undefined;
  private readonly spawner: NonNullable<OdiffAdapterOptions["spawner"]>;

  constructor(opts: OdiffAdapterOptions = {}) {
    this.binaryPath = opts.binaryPath;
    this.spawner = opts.spawner ?? ((cmd, args) => spawn(cmd, [...args]));
  }

  async diff(
    before: Uint8Array,
    after: Uint8Array,
    opts: DiffOptions = {},
  ): Promise<DiffResult> {
    const binary = this.binaryPath ?? resolveOdiffBinary();
    const beforePng = PNG.sync.read(Buffer.from(before));
    const afterPng = PNG.sync.read(Buffer.from(after));
    const width = Math.max(beforePng.width, afterPng.width);
    const height = Math.max(beforePng.height, afterPng.height);

    const beforePadded = padToSize(beforePng, width, height);
    const afterPadded = padToSize(afterPng, width, height);

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aic-odiff-"));
    try {
      const bPath = path.join(tmp, "before.png");
      const aPath = path.join(tmp, "after.png");
      const dPath = path.join(tmp, "diff.png");
      await fs.writeFile(bPath, PNG.sync.write(beforePadded));
      await fs.writeFile(aPath, PNG.sync.write(afterPadded));

      const threshold = opts.threshold ?? 0.1;
      const ignoreAA = opts.ignoreAntialiasing ?? true;
      const args: string[] = [
        bPath,
        aPath,
        dPath,
        `--threshold=${threshold}`,
      ];
      if (ignoreAA) args.push("--antialiasing");
      if (opts.diffColor) {
        const [r, g, b] = opts.diffColor;
        args.push(`--diff-color=#${toHex(r)}${toHex(g)}${toHex(b)}`);
      }

      const { exitCode, stdout, stderr } = await runBinary(this.spawner, binary, args);

      // odiff exit codes (from docs):
      //   0  — images identical
      //   21 — images different (pixel diff)
      //   22 — layout differ (size mismatch — we already padded, shouldn't happen)
      //   any other non-zero → error
      if (exitCode !== 0 && exitCode !== 21 && exitCode !== 22) {
        throw new Error(
          `OdiffDiff: odiff exited with code ${exitCode}. stderr: ${stderr.slice(0, 300)}`,
        );
      }

      const diffPixels = parseDiffPixels(stdout);
      let diffPngBytes: Uint8Array;
      try {
        diffPngBytes = new Uint8Array(await fs.readFile(dPath));
      } catch {
        // odiff may skip writing diff.png when images are identical.
        const empty = new PNG({ width, height });
        empty.data.fill(0);
        diffPngBytes = new Uint8Array(PNG.sync.write(empty));
      }

      const totalPixels = width * height;
      return {
        diffPng: diffPngBytes,
        diffPixels,
        totalPixels,
        diffRatio: totalPixels === 0 ? 0 : diffPixels / totalPixels,
        width,
        height,
      };
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }
}

function padToSize(source: PNG, width: number, height: number): PNG {
  if (source.width === width && source.height === height) return source;
  const padded = new PNG({ width, height });
  for (let i = 0; i < padded.data.length; i += 4) {
    padded.data[i] = 255;
    padded.data[i + 1] = 0;
    padded.data[i + 2] = 255;
    padded.data[i + 3] = 255;
  }
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const s = (source.width * y + x) << 2;
      const d = (width * y + x) << 2;
      padded.data[d] = source.data[s] ?? 0;
      padded.data[d + 1] = source.data[s + 1] ?? 0;
      padded.data[d + 2] = source.data[s + 2] ?? 0;
      padded.data[d + 3] = source.data[s + 3] ?? 0;
    }
  }
  return padded;
}

function toHex(v: number): string {
  return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
}

/**
 * Parse odiff's stdout for the diff pixel count. odiff prints lines like:
 *   `Images are different (0.0523%), 427 pixels`
 * We match the trailing integer; fall back to 0 if the output format
 * changes in a future release.
 */
function parseDiffPixels(stdout: string): number {
  const m = stdout.match(/(\d[\d,]*)\s*(?:pixels|diff pixels)/i);
  if (!m || !m[1]) return 0;
  return parseInt(m[1].replace(/,/g, ""), 10) || 0;
}

function resolveOdiffBinary(): string {
  // Dynamic resolve so the peer-optional dep doesn't break builds for
  // users who don't install odiff-bin.
  try {
    const req = createRequire(import.meta.url);
    const pkgPath = req.resolve("odiff-bin/package.json");
    return path.join(path.dirname(pkgPath), "bin", "odiff" + (process.platform === "win32" ? ".exe" : ""));
  } catch {
    throw new Error(
      "OdiffDiff: `odiff-bin` package is not installed. Run `pnpm add odiff-bin` in your repo (and approve its postinstall) to use this adapter.",
    );
  }
}

interface BinaryResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runBinary(
  spawner: NonNullable<OdiffAdapterOptions["spawner"]>,
  cmd: string,
  args: readonly string[],
): Promise<BinaryResult> {
  return new Promise((resolve, reject) => {
    const child = spawner(cmd, args);
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
    });
    child.on("error", (e) => reject(e));
    child.on("close", (code: number | Error) => {
      if (typeof code === "number") {
        resolve({ exitCode: code, stdout: out, stderr: err });
      } else {
        reject(code);
      }
    });
  });
}
