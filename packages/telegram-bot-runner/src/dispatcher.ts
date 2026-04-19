import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { GhLike, Outcome } from "./types.js";

const execFile = promisify(execFileCallback);

export function defaultEventTypeFor(outcome: Outcome): string {
  switch (outcome) {
    case "merged":
      return "conclave-merge";
    case "reworked":
      return "conclave-rework";
    case "rejected":
      return "conclave-reject";
  }
}

export const defaultGh: GhLike = async (bin, args, opts) => {
  const { stdout, stderr } = await execFile(bin, args as string[], {
    ...(opts?.timeout ? { timeout: opts.timeout } : {}),
    ...(opts?.input ? { input: opts.input } : {}),
    maxBuffer: 5 * 1024 * 1024,
  });
  return { stdout, stderr };
};

/**
 * Fire a `repository_dispatch` event on `repo` with `event_type` and the
 * given client_payload. Uses gh CLI so authentication flows through the
 * already-configured token (ORCHESTRATOR_PAT in the conclave GH Actions
 * context) without us having to handle HTTPS ourselves.
 *
 * Invokes: gh api repos/:owner/:repo/dispatches -f event_type=... --input -
 * with the payload piped on stdin. That lets us pass arbitrarily nested
 * JSON client_payloads without fighting gh's -F/-f escaping.
 */
export async function dispatchRepositoryEvent(
  gh: GhLike,
  repo: string,
  eventType: string,
  clientPayload: Record<string, unknown>,
): Promise<void> {
  const body = JSON.stringify({ event_type: eventType, client_payload: clientPayload });
  await gh("gh", ["api", `repos/${repo}/dispatches`, "--method", "POST", "--input", "-"], { input: body });
}
