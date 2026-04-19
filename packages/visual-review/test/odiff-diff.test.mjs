import { test } from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { OdiffDiff } from "../dist/index.js";

function solidPng(w, h, [r, g, b, a]) {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
    png.data[i + 3] = a;
  }
  return new Uint8Array(PNG.sync.write(png));
}

/**
 * Mock child_process-ish spawn — captures args, fires events
 * synchronously on the next tick.
 */
function mockSpawner(responses) {
  let i = 0;
  const calls = [];
  const fn = (cmd, args) => {
    calls.push({ cmd, args: [...args] });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    const handlers = { data: { stdout: [], stderr: [] }, close: [], error: [] };
    const stdout = {
      on: (event, cb) => {
        if (event === "data") handlers.data.stdout.push(cb);
      },
    };
    const stderr = {
      on: (event, cb) => {
        if (event === "data") handlers.data.stderr.push(cb);
      },
    };
    const child = {
      stdout,
      stderr,
      on: (event, cb) => {
        handlers[event].push(cb);
      },
    };
    // Fire events asynchronously so consumers register listeners first.
    Promise.resolve().then(async () => {
      if (r.stdout) for (const cb of handlers.data.stdout) cb(Buffer.from(r.stdout));
      if (r.stderr) for (const cb of handlers.data.stderr) cb(Buffer.from(r.stderr));
      if (r.writeDiffPng) await r.writeDiffPng(calls.at(-1).args[2]);
      if (typeof r.exitCode === "number") {
        for (const cb of handlers.close) cb(r.exitCode);
      } else if (r.error) {
        for (const cb of handlers.error) cb(r.error);
      }
    });
    return child;
  };
  fn.calls = calls;
  return fn;
}

const WHITE_40 = solidPng(40, 40, [255, 255, 255, 255]);
const BLACK_40 = solidPng(40, 40, [0, 0, 0, 255]);

test("OdiffDiff: id is 'odiff'", () => {
  const d = new OdiffDiff({ binaryPath: "/nope", spawner: mockSpawner([{ exitCode: 0 }]) });
  assert.equal(d.id, "odiff");
});

test("OdiffDiff: exit code 0 → identical result with zero diff pixels", async () => {
  const fs = await import("node:fs/promises");
  const s = mockSpawner([
    {
      exitCode: 0,
      stdout: "Images are equal\n",
      writeDiffPng: async (dPath) => {
        // odiff may not write diff.png when identical — adapter should tolerate
      },
    },
  ]);
  const d = new OdiffDiff({ binaryPath: "/fake/odiff", spawner: s });
  const out = await d.diff(WHITE_40, WHITE_40);
  assert.equal(out.diffPixels, 0);
  assert.equal(out.diffRatio, 0);
  assert.equal(out.width, 40);
  assert.equal(out.height, 40);
});

test("OdiffDiff: exit code 21 + stdout pixel count → populated diff result", async () => {
  const fs = await import("node:fs/promises");
  const s = mockSpawner([
    {
      exitCode: 21,
      stdout: "Images are different (100%), 1600 diff pixels\n",
      writeDiffPng: async (dPath) => {
        await fs.writeFile(dPath, Buffer.from(solidPng(40, 40, [255, 0, 0, 255])));
      },
    },
  ]);
  const d = new OdiffDiff({ binaryPath: "/fake/odiff", spawner: s });
  const out = await d.diff(WHITE_40, BLACK_40);
  assert.equal(out.diffPixels, 1600);
  assert.equal(out.totalPixels, 1600);
  assert.equal(out.diffRatio, 1);
  assert.ok(out.diffPng.length > 0);
});

test("OdiffDiff: parses comma-separated pixel counts from stdout", async () => {
  const fs = await import("node:fs/promises");
  const s = mockSpawner([
    {
      exitCode: 21,
      stdout: "Found 12,500 diff pixels\n",
      writeDiffPng: async (dPath) => {
        await fs.writeFile(dPath, Buffer.from(solidPng(40, 40, [0, 0, 0, 255])));
      },
    },
  ]);
  const d = new OdiffDiff({ binaryPath: "/fake/odiff", spawner: s });
  const out = await d.diff(WHITE_40, WHITE_40);
  assert.equal(out.diffPixels, 12500);
});

test("OdiffDiff: passes threshold + diff-color + antialiasing flags to binary", async () => {
  const s = mockSpawner([
    {
      exitCode: 0,
      stdout: "Images are equal\n",
    },
  ]);
  const d = new OdiffDiff({ binaryPath: "/fake/odiff", spawner: s });
  await d.diff(WHITE_40, WHITE_40, {
    threshold: 0.05,
    diffColor: [0, 255, 0],
    ignoreAntialiasing: true,
  });
  const args = s.calls[0].args;
  assert.ok(args.includes("--threshold=0.05"));
  assert.ok(args.some((a) => a.startsWith("--diff-color=#00ff00")));
  assert.ok(args.includes("--antialiasing"));
});

test("OdiffDiff: ignoreAntialiasing=false omits the --antialiasing flag", async () => {
  const s = mockSpawner([{ exitCode: 0, stdout: "equal" }]);
  const d = new OdiffDiff({ binaryPath: "/fake/odiff", spawner: s });
  await d.diff(WHITE_40, WHITE_40, { ignoreAntialiasing: false });
  const args = s.calls[0].args;
  assert.ok(!args.includes("--antialiasing"));
});

test("OdiffDiff: non-zero non-21/22 exit throws with stderr tail", async () => {
  const s = mockSpawner([
    { exitCode: 127, stderr: "command not found" },
  ]);
  const d = new OdiffDiff({ binaryPath: "/fake/odiff", spawner: s });
  await assert.rejects(() => d.diff(WHITE_40, WHITE_40), /exited with code 127.*command not found/);
});

test("OdiffDiff: size-mismatched inputs are padded, same-shape output", async () => {
  const fs = await import("node:fs/promises");
  const small = solidPng(10, 10, [255, 255, 255, 255]);
  const big = solidPng(40, 40, [255, 255, 255, 255]);
  const s = mockSpawner([
    {
      exitCode: 21,
      stdout: "Images are different, 1500 diff pixels\n",
      writeDiffPng: async (dPath) => {
        await fs.writeFile(dPath, Buffer.from(solidPng(40, 40, [255, 0, 0, 255])));
      },
    },
  ]);
  const d = new OdiffDiff({ binaryPath: "/fake/odiff", spawner: s });
  const out = await d.diff(small, big);
  assert.equal(out.width, 40);
  assert.equal(out.height, 40);
});

test("OdiffDiff: passes three positional paths (before, after, diff) to binary", async () => {
  const s = mockSpawner([{ exitCode: 0, stdout: "equal" }]);
  const d = new OdiffDiff({ binaryPath: "/fake/odiff", spawner: s });
  await d.diff(WHITE_40, WHITE_40);
  const args = s.calls[0].args;
  assert.ok(args[0].endsWith("before.png"));
  assert.ok(args[1].endsWith("after.png"));
  assert.ok(args[2].endsWith("diff.png"));
});

test("OdiffDiff: stdout with no pixel count defaults to diffPixels=0", async () => {
  const s = mockSpawner([{ exitCode: 0, stdout: "something unparseable" }]);
  const d = new OdiffDiff({ binaryPath: "/fake/odiff", spawner: s });
  const out = await d.diff(WHITE_40, WHITE_40);
  assert.equal(out.diffPixels, 0);
});

test("OdiffDiff: no installed odiff-bin + no explicit binaryPath → throws actionable error on first use", async () => {
  const d = new OdiffDiff();
  // We can't trivially stub createRequire here, so we just confirm calling
  // without a spawner stub produces a missing-binary failure (one of two
  // places — either resolveOdiffBinary or the spawn itself).
  await assert.rejects(() => d.diff(WHITE_40, WHITE_40));
});
