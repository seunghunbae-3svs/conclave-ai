import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Phase B.4b — client-side notification dedup.
 *
 * User-reported failure mode: "텔레그램 메세지에 계속 동일한게 나오거나"
 * — the same review notification is delivered multiple times. The
 * central plane SHOULD dedup but is not load-bearing for that
 * guarantee. This ledger gives the CLI itself a hard idempotency
 * fence: if we've already pushed (episodicId, verdict, contentHash)
 * to the user, we don't push it again.
 *
 * Layout: <memoryRoot>/notif-ledger/<episodicId>.json
 *   shape: { episodicId, fingerprints: [{ contentHash, sentAt }] }
 *
 * Any single notify call that produces the same fingerprint as a
 * previously-recorded one is suppressed. Different verdicts on the
 * same episodicId (rare; would only happen if the ID is reused across
 * runs — itself a bug) produce different fingerprints and pass.
 *
 * Deletion is on the operator — the ledger is small and easy to
 * inspect for diagnostics. Once the PR closes, manual cleanup is fine.
 */

export interface NotificationFingerprint {
  contentHash: string;
  sentAt: string;
}

export interface NotificationLedgerEntry {
  episodicId: string;
  fingerprints: NotificationFingerprint[];
}

export function computeFingerprint(input: {
  episodicId: string;
  verdict: "approve" | "rework" | "reject";
  blockerCount: number;
  reworkCycle?: number;
}): string {
  const tuple = JSON.stringify([
    input.episodicId,
    input.verdict,
    input.blockerCount,
    input.reworkCycle ?? 0,
  ]);
  return createHash("sha256").update(tuple).digest("hex").slice(0, 16);
}

function ledgerPath(memoryRoot: string, episodicId: string): string {
  // episodicId is "ep-<uuid>" — safe for filenames.
  const safe = episodicId.replace(/[^a-zA-Z0-9_.\-]/g, "_");
  return path.join(memoryRoot, "notif-ledger", `${safe}.json`);
}

export async function readLedger(
  memoryRoot: string,
  episodicId: string,
): Promise<NotificationLedgerEntry | null> {
  const file = ledgerPath(memoryRoot, episodicId);
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.episodicId === "string" &&
      Array.isArray(parsed.fingerprints)
    ) {
      return parsed as NotificationLedgerEntry;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Record a fingerprint and return the prior state. If the fingerprint
 * was already in the ledger, returns `{ alreadySent: true }` and the
 * caller skips notification. Best-effort: any IO failure returns
 * `{ alreadySent: false }` so a transient disk issue never silences
 * a real verdict.
 */
export async function checkAndRecordNotification(input: {
  memoryRoot: string;
  episodicId: string;
  fingerprint: string;
}): Promise<{ alreadySent: boolean; ledgerWriteFailed: boolean }> {
  const file = ledgerPath(input.memoryRoot, input.episodicId);
  try {
    const existing = await readLedger(input.memoryRoot, input.episodicId);
    if (existing && existing.fingerprints.some((f) => f.contentHash === input.fingerprint)) {
      return { alreadySent: true, ledgerWriteFailed: false };
    }
    const updated: NotificationLedgerEntry = existing ?? {
      episodicId: input.episodicId,
      fingerprints: [],
    };
    updated.fingerprints.push({
      contentHash: input.fingerprint,
      sentAt: new Date().toISOString(),
    });
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(updated, null, 2), "utf8");
    return { alreadySent: false, ledgerWriteFailed: false };
  } catch {
    return { alreadySent: false, ledgerWriteFailed: true };
  }
}
