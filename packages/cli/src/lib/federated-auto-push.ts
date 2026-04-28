import {
  HttpFederatedSyncTransport,
  NoopFederatedSyncTransport,
  runFederatedSync,
  type AnswerKey,
  type FailureEntry,
  type FederatedSyncTransport,
} from "@conclave-ai/core";
import type { ConclaveConfig } from "./config.js";

export interface AutoPushInput {
  config: ConclaveConfig;
  /** Delta from the latest recordOutcome call — only these get pushed. */
  written: {
    answerKeys: readonly AnswerKey[];
    failures: readonly FailureEntry[];
  };
  /** Optional bearer token for the federation endpoint. */
  apiToken?: string;
  /** Test seam — inject a fake transport. Defaults to HTTP/Noop based on config. */
  transport?: FederatedSyncTransport;
}

export interface AutoPushOutput {
  /** True when something was actually attempted on the wire. */
  attempted: boolean;
  /** Server-acknowledged count from the push (0 on failures or skips). */
  pushed: number;
  /** Why the push didn't fire (when attempted=false). */
  skipReason?: string;
  /** Set when the push attempted but threw. Caller decides whether to log. */
  error?: string;
}

/**
 * H3 #14 — federation opt-in switch, made live. After a successful
 * `OutcomeWriter.recordOutcome(...)` call, push only the freshly-written
 * answer-keys + failures through the federated transport. Pulls are
 * deliberately suppressed here — they belong on the explicit
 * `conclave sync` path so we don't put network latency on every PR
 * merge.
 *
 * Best-effort by design: any error short-circuits to {error} and the
 * caller renders it as a stderr warning. The user's outcome (merge,
 * reject, rework) has already happened.
 */
export async function autoPushOutcome(input: AutoPushInput): Promise<AutoPushOutput> {
  const fed = input.config.federated;
  if (!fed || !fed.enabled) {
    return { attempted: false, pushed: 0, skipReason: "federation disabled" };
  }
  if (!fed.autoPush) {
    return { attempted: false, pushed: 0, skipReason: "federated.autoPush is false" };
  }
  if (!fed.endpoint) {
    return { attempted: false, pushed: 0, skipReason: "federated.endpoint not configured" };
  }
  if (input.written.answerKeys.length === 0 && input.written.failures.length === 0) {
    return { attempted: false, pushed: 0, skipReason: "no entries written this outcome" };
  }

  const transport: FederatedSyncTransport =
    input.transport ??
    new HttpFederatedSyncTransport({
      endpoint: fed.endpoint,
      ...(input.apiToken ? { apiToken: input.apiToken } : {}),
    });
  if (transport instanceof NoopFederatedSyncTransport) {
    return { attempted: false, pushed: 0, skipReason: "noop transport" };
  }

  try {
    const result = await runFederatedSync({
      transport,
      answerKeys: input.written.answerKeys,
      failures: input.written.failures,
      pullDisabled: true,
    });
    return { attempted: true, pushed: result.accepted };
  } catch (err) {
    return {
      attempted: true,
      pushed: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
