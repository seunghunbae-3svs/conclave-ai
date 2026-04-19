import type { AnswerKey, FailureEntry } from "../memory/schema.js";
import { redactAll } from "./redact.js";
import type { FederatedBaseline } from "./schema.js";
import type { FederatedSyncTransport } from "./transport.js";

export interface RunSyncInput {
  transport: FederatedSyncTransport;
  answerKeys: readonly AnswerKey[];
  failures: readonly FailureEntry[];
  /** Collect + redact but don't push or pull. Useful for inspection. */
  dryRun?: boolean;
  /** ISO timestamp — pull baselines newer than this. */
  since?: string;
  /** Skip the push half of the round-trip. */
  pushDisabled?: boolean;
  /** Skip the pull half of the round-trip. */
  pullDisabled?: boolean;
}

export interface RunSyncResult {
  /** Redacted payload that was (or would have been) pushed. */
  pushed: FederatedBaseline[];
  /** Baselines received from the server. `[]` on dryRun. */
  pulled: FederatedBaseline[];
  /** Server-acknowledged count from push. 0 on dryRun. */
  accepted: number;
  dryRun: boolean;
  transportId: string;
}

/**
 * runFederatedSync — orchestrates the round-trip. All privacy-sensitive
 * transformation happens here (via `redactAll`); the transport only
 * ever sees the already-redacted `FederatedBaseline[]`.
 *
 * `dryRun: true` makes this function pure — no network I/O — so it's
 * safe to expose via `conclave sync --dry-run` for users who want to
 * audit exactly what leaves their machine before opting in.
 */
export async function runFederatedSync(input: RunSyncInput): Promise<RunSyncResult> {
  const toSend = redactAll(input.answerKeys, input.failures);
  const dryRun = input.dryRun ?? false;

  let accepted = 0;
  if (!dryRun && !input.pushDisabled && toSend.length > 0) {
    const res = await input.transport.push(toSend);
    accepted = res.accepted;
  }

  const pulled = dryRun || input.pullDisabled ? [] : await input.transport.pull(input.since);

  return {
    pushed: toSend,
    pulled,
    accepted,
    dryRun,
    transportId: input.transport.id,
  };
}
