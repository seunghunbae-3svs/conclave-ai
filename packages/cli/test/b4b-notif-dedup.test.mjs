/**
 * Phase B.4b — notification dedup ledger.
 *
 * User-reported: "텔레그램 메세지에 계속 동일한게 나오거나" — same
 * notification fired multiple times. Now we have a client-side
 * idempotency ledger.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkAndRecordNotification,
  computeFingerprint,
  readLedger,
} from "../dist/lib/notification-ledger.js";

function freshFs() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aic-b4b-"));
}
function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

test("B.4b: same (episodicId, verdict, blockerCount, cycle) → second send returns alreadySent:true", async () => {
  const root = freshFs();
  try {
    const fp = computeFingerprint({
      episodicId: "ep-1",
      verdict: "rework",
      blockerCount: 2,
      reworkCycle: 0,
    });
    const a = await checkAndRecordNotification({ memoryRoot: root, episodicId: "ep-1", fingerprint: fp });
    assert.equal(a.alreadySent, false, "first send must not be dedup'd");

    const b = await checkAndRecordNotification({ memoryRoot: root, episodicId: "ep-1", fingerprint: fp });
    assert.equal(b.alreadySent, true, "second send with same fingerprint MUST be dedup'd");

    const c = await checkAndRecordNotification({ memoryRoot: root, episodicId: "ep-1", fingerprint: fp });
    assert.equal(c.alreadySent, true, "third+ send same — still dedup'd");
  } finally {
    cleanup(root);
  }
});

test("B.4b: different verdicts on same episodicId → different fingerprints, both pass", async () => {
  const root = freshFs();
  try {
    const fp1 = computeFingerprint({ episodicId: "ep-1", verdict: "rework", blockerCount: 2 });
    const fp2 = computeFingerprint({ episodicId: "ep-1", verdict: "approve", blockerCount: 0 });
    assert.notEqual(fp1, fp2);

    const a = await checkAndRecordNotification({ memoryRoot: root, episodicId: "ep-1", fingerprint: fp1 });
    const b = await checkAndRecordNotification({ memoryRoot: root, episodicId: "ep-1", fingerprint: fp2 });
    assert.equal(a.alreadySent, false);
    assert.equal(b.alreadySent, false, "verdict change → still send");
    // Now repeat first → dedup'd.
    const c = await checkAndRecordNotification({ memoryRoot: root, episodicId: "ep-1", fingerprint: fp1 });
    assert.equal(c.alreadySent, true);
  } finally {
    cleanup(root);
  }
});

test("B.4b: different reworkCycle → different fingerprints (cycle 0 vs cycle 1 vs cycle 2 all distinct)", async () => {
  const fps = [
    computeFingerprint({ episodicId: "ep-1", verdict: "rework", blockerCount: 1, reworkCycle: 0 }),
    computeFingerprint({ episodicId: "ep-1", verdict: "rework", blockerCount: 1, reworkCycle: 1 }),
    computeFingerprint({ episodicId: "ep-1", verdict: "rework", blockerCount: 1, reworkCycle: 2 }),
  ];
  assert.equal(new Set(fps).size, 3, "each rework cycle is a distinct event for dedup purposes");
});

test("B.4b: different episodicIds tracked independently (no cross-talk)", async () => {
  const root = freshFs();
  try {
    const fp = computeFingerprint({ episodicId: "ep-A", verdict: "rework", blockerCount: 1 });
    const a = await checkAndRecordNotification({ memoryRoot: root, episodicId: "ep-A", fingerprint: fp });
    assert.equal(a.alreadySent, false);
    // Same fingerprint hash but DIFFERENT episodicId folder → independent.
    const b = await checkAndRecordNotification({
      memoryRoot: root,
      episodicId: "ep-B",
      fingerprint: fp,
    });
    assert.equal(b.alreadySent, false, "different episodicId must not be dedup'd against ep-A's ledger");
  } finally {
    cleanup(root);
  }
});

test("B.4b: ledger persists across processes (round-trip via disk)", async () => {
  const root = freshFs();
  try {
    const fp = computeFingerprint({ episodicId: "ep-X", verdict: "approve", blockerCount: 0 });
    await checkAndRecordNotification({ memoryRoot: root, episodicId: "ep-X", fingerprint: fp });

    // Simulate a fresh process — re-read from disk.
    const reread = await readLedger(root, "ep-X");
    assert.ok(reread);
    assert.equal(reread.fingerprints.length, 1);
    assert.equal(reread.fingerprints[0].contentHash, fp);
  } finally {
    cleanup(root);
  }
});

test("B.4b: ledger absent → readLedger returns null without throwing", async () => {
  const root = freshFs();
  try {
    const r = await readLedger(root, "ep-never-existed");
    assert.equal(r, null);
  } finally {
    cleanup(root);
  }
});

test("B.4b: corrupt ledger file → treat as no-prior (don't silence real notifications)", async () => {
  const root = freshFs();
  try {
    const dir = path.join(root, "notif-ledger");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "ep-corrupt.json"), "{not json", "utf8");
    const r = await readLedger(root, "ep-corrupt");
    assert.equal(r, null);
    // checkAndRecord should NOT crash on a corrupt file.
    const fp = computeFingerprint({ episodicId: "ep-corrupt", verdict: "rework", blockerCount: 1 });
    const out = await checkAndRecordNotification({
      memoryRoot: root,
      episodicId: "ep-corrupt",
      fingerprint: fp,
    });
    // First call after corrupt-recovery → alreadySent should be false (corrupt reads as null).
    assert.equal(out.alreadySent, false);
  } finally {
    cleanup(root);
  }
});
