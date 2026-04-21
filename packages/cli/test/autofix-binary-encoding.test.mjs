import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  detectEncoding,
  matchesEncodingBlocker,
  reencodeToUtf8,
  tryBinaryEncodingFix,
} from "../dist/lib/autofix-handlers/binary-encoding.js";
import { runSpecialHandlers } from "../dist/lib/autofix-handlers/index.js";

// ---- helpers --------------------------------------------------------------

async function mkTmpDir(label) {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), `conclave-autofix-${label}-`));
  return d;
}

// A fake git runner that records invocations. Returns empty stdout by
// default. Tests configure `binaryReport` to make `check-attr` respond
// with "set" or "unset".
function makeGit({ binaryReport = "unspecified", failOn = null } = {}) {
  const calls = [];
  const git = async (_bin, args, _opts) => {
    calls.push(args);
    if (failOn && failOn(args)) {
      throw new Error(`forced fail: ${args.join(" ")}`);
    }
    if (args[0] === "check-attr" && args[1] === "binary") {
      const p = args[args.length - 1];
      return { stdout: `${p}: binary: ${binaryReport}\n`, code: 0 };
    }
    return { stdout: "", code: 0 };
  };
  git.calls = calls;
  return git;
}

function utf16leBomBuffer(str) {
  const body = Buffer.from(str, "utf16le");
  return Buffer.concat([Buffer.from([0xff, 0xfe]), body]);
}

function utf16beBomBuffer(str) {
  const le = Buffer.from(str, "utf16le");
  const be = Buffer.alloc(le.length);
  for (let i = 0; i + 1 < le.length; i += 2) {
    be[i] = le[i + 1];
    be[i + 1] = le[i];
  }
  return Buffer.concat([Buffer.from([0xfe, 0xff]), be]);
}

function utf8BomBuffer(str) {
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(str, "utf8")]);
}

// ---- detectEncoding ------------------------------------------------------

test("detectEncoding: UTF-16LE BOM", () => {
  assert.equal(detectEncoding(utf16leBomBuffer("hi")), "utf-16le");
});

test("detectEncoding: UTF-16BE BOM", () => {
  assert.equal(detectEncoding(utf16beBomBuffer("hi")), "utf-16be");
});

test("detectEncoding: UTF-8 BOM", () => {
  assert.equal(detectEncoding(utf8BomBuffer("hi")), "utf-8-bom");
});

test("detectEncoding: clean UTF-8 has no BOM", () => {
  assert.equal(detectEncoding(Buffer.from("hello", "utf8")), "utf-8-clean");
});

// ---- matchesEncodingBlocker ---------------------------------------------

test("matchesEncodingBlocker: category 'source-integrity' claims", () => {
  assert.equal(
    matchesEncodingBlocker({
      severity: "blocker",
      category: "source-integrity",
      message: "file encoding broken",
      file: "src/x.ts",
    }),
    true,
  );
});

test("matchesEncodingBlocker: category 'encoding' claims", () => {
  assert.equal(
    matchesEncodingBlocker({
      severity: "major",
      category: "encoding",
      message: "fix utf-16",
      file: "src/x.ts",
    }),
    true,
  );
});

test("matchesEncodingBlocker: message 'UTF-16 BOM' claims even when category is generic", () => {
  assert.equal(
    matchesEncodingBlocker({
      severity: "blocker",
      category: "build",
      message: "file has a UTF-16 BOM",
      file: "src/x.ts",
    }),
    true,
  );
});

test("matchesEncodingBlocker: unrelated blockers are NOT claimed (bug 1 guard)", () => {
  assert.equal(
    matchesEncodingBlocker({
      severity: "blocker",
      category: "logic",
      message: "off-by-one in for loop",
      file: "src/x.ts",
    }),
    false,
  );
});

// ---- reencodeToUtf8 ------------------------------------------------------

test("reencodeToUtf8: UTF-16LE+BOM file → pure UTF-8 without BOM", async () => {
  const dir = await mkTmpDir("reencode-le");
  try {
    const f = path.join(dir, "AddressSearch.jsx");
    const jsxBody = 'import React from "react";\nexport default function X() {\n  return null;\n}\n';
    await fs.writeFile(f, utf16leBomBuffer(jsxBody));
    const readBytes = (p) => fs.readFile(p);
    const writeBytes = (p, d) => fs.writeFile(p, d);
    const summary = await reencodeToUtf8(f, { readBytes, writeBytes });
    assert.equal(summary.from, "utf-16le");
    const out = await fs.readFile(f);
    // No BOM — must start with 'i' (import)
    assert.equal(out[0], 0x69);
    // Round-trips to expected JSX
    assert.equal(out.toString("utf8"), jsxBody);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("reencodeToUtf8: UTF-16BE+BOM file → pure UTF-8 without BOM", async () => {
  const dir = await mkTmpDir("reencode-be");
  try {
    const f = path.join(dir, "x.ts");
    const body = 'const x = "hello";\n';
    await fs.writeFile(f, utf16beBomBuffer(body));
    const summary = await reencodeToUtf8(f, {
      readBytes: (p) => fs.readFile(p),
      writeBytes: (p, d) => fs.writeFile(p, d),
    });
    assert.equal(summary.from, "utf-16be");
    const out = await fs.readFile(f);
    assert.equal(out.toString("utf8"), body);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("reencodeToUtf8: UTF-8+BOM file → strips BOM", async () => {
  const dir = await mkTmpDir("reencode-u8bom");
  try {
    const f = path.join(dir, "x.ts");
    const body = 'const x = "hello";\n';
    await fs.writeFile(f, utf8BomBuffer(body));
    const summary = await reencodeToUtf8(f, {
      readBytes: (p) => fs.readFile(p),
      writeBytes: (p, d) => fs.writeFile(p, d),
    });
    assert.equal(summary.from, "utf-8-bom");
    const out = await fs.readFile(f);
    assert.equal(out[0], 0x63); // 'c'
    assert.equal(out.toString("utf8"), body);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("reencodeToUtf8: already-clean UTF-8 is left alone", async () => {
  const dir = await mkTmpDir("reencode-clean");
  try {
    const f = path.join(dir, "x.ts");
    const body = 'const y = 42;\n';
    await fs.writeFile(f, body, "utf8");
    const before = await fs.readFile(f);
    const summary = await reencodeToUtf8(f, {
      readBytes: (p) => fs.readFile(p),
      writeBytes: (p, d) => fs.writeFile(p, d),
    });
    assert.equal(summary.from, "utf-8-clean");
    const after = await fs.readFile(f);
    assert.ok(before.equals(after), "clean UTF-8 must be byte-identical after no-op");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---- tryBinaryEncodingFix — end-to-end handler --------------------------

test("tryBinaryEncodingFix: UTF-16LE+BOM file → ready fix + git add staged", async () => {
  const dir = await mkTmpDir("handler-le");
  try {
    const rel = "components/AddressSearch.jsx";
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const body = 'export default function X() { return null; }\n';
    await fs.writeFile(abs, utf16leBomBuffer(body));
    const git = makeGit({ binaryReport: "unset" });
    const blocker = {
      severity: "blocker",
      category: "source-integrity",
      message: "file is binary (UTF-16 BOM)",
      file: rel,
    };
    const res = await tryBinaryEncodingFix("claude", blocker, { cwd: dir, git });
    assert.equal(res.claimed, true);
    assert.equal(res.fix.status, "ready");
    assert.equal(res.fix.agent, "claude");
    assert.ok(Array.isArray(res.fix.appliedFiles));
    assert.equal(res.fix.appliedFiles[0], rel);
    // File should now be plain UTF-8
    const out = await fs.readFile(abs);
    assert.equal(out[0], 0x65); // 'e' (export)
    // git add was called
    assert.ok(git.calls.some((c) => c[0] === "add" && c[c.length - 1] === rel));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("tryBinaryEncodingFix: UTF-16BE+BOM file → ready fix", async () => {
  const dir = await mkTmpDir("handler-be");
  try {
    const rel = "x.ts";
    const abs = path.join(dir, rel);
    const body = 'const x = 1;\n';
    await fs.writeFile(abs, utf16beBomBuffer(body));
    const git = makeGit({ binaryReport: "unset" });
    const blocker = {
      severity: "major",
      category: "encoding",
      message: "utf-16be bom detected",
      file: rel,
    };
    const res = await tryBinaryEncodingFix("openai", blocker, { cwd: dir, git });
    assert.equal(res.claimed, true);
    assert.equal(res.fix.status, "ready");
    const out = await fs.readFile(abs);
    assert.equal(out.toString("utf8"), body);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("tryBinaryEncodingFix: UTF-8+BOM file → ready fix with BOM stripped", async () => {
  const dir = await mkTmpDir("handler-u8bom");
  try {
    const rel = "y.ts";
    const abs = path.join(dir, rel);
    const body = 'const y = 2;\n';
    await fs.writeFile(abs, utf8BomBuffer(body));
    const git = makeGit({ binaryReport: "unset" });
    const blocker = {
      severity: "blocker",
      category: "source-integrity",
      message: "utf-8 bom",
      file: rel,
    };
    const res = await tryBinaryEncodingFix("claude", blocker, { cwd: dir, git });
    assert.equal(res.claimed, true);
    assert.equal(res.fix.status, "ready");
    const out = await fs.readFile(abs);
    assert.equal(out.length, Buffer.from(body, "utf8").length);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("tryBinaryEncodingFix: already-clean UTF-8 → claimed + 'no action needed'", async () => {
  const dir = await mkTmpDir("handler-clean");
  try {
    const rel = "clean.ts";
    const abs = path.join(dir, rel);
    await fs.writeFile(abs, 'const z = 3;\n', "utf8");
    const git = makeGit({ binaryReport: "unspecified" });
    const blocker = {
      severity: "blocker",
      category: "source-integrity",
      message: "check utf-16",
      file: rel,
    };
    const res = await tryBinaryEncodingFix("claude", blocker, { cwd: dir, git });
    assert.equal(res.claimed, true);
    assert.equal(res.fix.status, "skipped");
    assert.match(res.fix.reason, /already clean UTF-8/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("tryBinaryEncodingFix: file does not exist → claimed + worker-error with clear message", async () => {
  const dir = await mkTmpDir("handler-nofile");
  try {
    const git = makeGit();
    const blocker = {
      severity: "blocker",
      category: "source-integrity",
      message: "utf-16 bom",
      file: "does/not/exist.ts",
    };
    const res = await tryBinaryEncodingFix("claude", blocker, { cwd: dir, git });
    assert.equal(res.claimed, true);
    assert.equal(res.fix.status, "worker-error");
    assert.match(res.fix.reason, /file not found/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("tryBinaryEncodingFix: handler is NOT claimed for non-encoding blockers", async () => {
  const dir = await mkTmpDir("handler-noclaim");
  try {
    const abs = path.join(dir, "a.ts");
    await fs.writeFile(abs, "const a = 1;\n", "utf8");
    const git = makeGit();
    const blocker = {
      severity: "blocker",
      category: "logic",
      message: "off-by-one error in loop",
      file: "a.ts",
    };
    const res = await tryBinaryEncodingFix("claude", blocker, { cwd: dir, git });
    assert.equal(res.claimed, false);
    // No git interactions for a non-claimed blocker
    assert.equal(git.calls.length, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("tryBinaryEncodingFix: after re-encode, git still binary → clean failure + rollback", async () => {
  const dir = await mkTmpDir("handler-stillbinary");
  try {
    const rel = "weird.bin";
    const abs = path.join(dir, rel);
    await fs.writeFile(abs, utf16leBomBuffer("hello"));
    // check-attr reports "set" — git sees this as binary regardless
    const git = makeGit({ binaryReport: "set" });
    const blocker = {
      severity: "blocker",
      category: "source-integrity",
      message: "utf-16 bom",
      file: rel,
    };
    const res = await tryBinaryEncodingFix("claude", blocker, { cwd: dir, git });
    assert.equal(res.claimed, true);
    assert.equal(res.fix.status, "worker-error");
    assert.match(res.fix.reason, /manual intervention required/);
    // Rollback path: git reset + git checkout were invoked after the stage.
    const resetCall = git.calls.find((c) => c[0] === "reset" && c[1] === "HEAD");
    const checkoutCall = git.calls.find((c) => c[0] === "checkout");
    assert.ok(resetCall, "git reset must be called for rollback");
    assert.ok(checkoutCall, "git checkout must be called for rollback");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---- registry ------------------------------------------------------------

test("runSpecialHandlers: routes UTF-16LE+BOM file through binary-encoding handler", async () => {
  const dir = await mkTmpDir("registry-route");
  try {
    const rel = "z.ts";
    const abs = path.join(dir, rel);
    await fs.writeFile(abs, utf16leBomBuffer("const z = 9;\n"));
    const git = makeGit({ binaryReport: "unset" });
    const res = await runSpecialHandlers(
      "claude",
      {
        severity: "blocker",
        category: "source-integrity",
        message: "utf-16 bom",
        file: rel,
      },
      { cwd: dir, git },
    );
    assert.equal(res.claimed, true);
    assert.equal(res.fix.status, "ready");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("runSpecialHandlers: non-encoding blocker returns claimed=false (falls through to worker pipeline)", async () => {
  const dir = await mkTmpDir("registry-noclaim");
  try {
    const git = makeGit();
    const res = await runSpecialHandlers(
      "claude",
      {
        severity: "blocker",
        category: "type-error",
        message: "TS2322 is not assignable",
        file: "src/x.ts",
      },
      { cwd: dir, git },
    );
    assert.equal(res.claimed, false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
