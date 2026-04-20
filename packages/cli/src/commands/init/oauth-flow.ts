import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { CentralClient, type DevicePollResponse } from "./central-client.js";

const execFile = promisify(execFileCb);

export interface OauthFlowDeps {
  client?: CentralClient;
  /** Override for tests; defaults to `execFile("gh", ...)` to set repo secret. */
  setGhSecret?: (opts: { repoSlug: string; name: string; value: string }) => Promise<void>;
  /** Sleep used in poll loop; injected so tests don't wait real seconds. */
  sleep?: (ms: number) => Promise<void>;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  /** Wall-clock now; injected so tests can make the device expire on schedule. */
  now?: () => number;
}

export interface OauthFlowResult {
  kind: "success";
  token: string;
  rotated: boolean;
}

export type OauthFlowExit =
  | OauthFlowResult
  | { kind: "denied"; reason?: string }
  | { kind: "expired" }
  | { kind: "error"; message: string };

async function defaultSetGhSecret(opts: { repoSlug: string; name: string; value: string }): Promise<void> {
  await execFile("gh", ["secret", "set", opts.name, "--repo", opts.repoSlug, "--body", opts.value]);
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run the full GitHub OAuth device flow against the central plane and,
 * on success, install the returned CONCLAVE_TOKEN as a repo secret via
 * `gh secret set`. Returns a structured exit so the caller can produce
 * a user-friendly summary without parsing error strings.
 *
 * This function is deliberately long on user-visible text — setup-only
 * commands benefit from narrating every step so the operator doesn't
 * wonder if the CLI is hung.
 */
export async function runOauthFlow(repoSlug: string, deps: OauthFlowDeps = {}): Promise<OauthFlowExit> {
  const stdout = deps.stdout ?? ((s) => process.stdout.write(s));
  const stderr = deps.stderr ?? ((s) => process.stderr.write(s));
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? (() => Date.now());
  const client = deps.client ?? new CentralClient();

  let startResp;
  try {
    startResp = await client.startDeviceFlow(repoSlug);
  } catch (err) {
    return { kind: "error", message: (err as Error).message };
  }

  stdout(
    [
      "",
      "• GitHub OAuth:",
      `  1. Open this URL in a browser:     ${startResp.verification_uri}`,
      `  2. Enter this code when prompted:  ${startResp.user_code}`,
      `  3. Authorize Conclave AI access.`,
      "",
      "Waiting for authorization…",
      "",
    ].join("\n"),
  );

  const expiresAtMs = new Date(startResp.expires_at).getTime();
  let intervalSec = startResp.interval_sec;

  // Poll loop — capped by server-reported expires_at. Handles pending +
  // slow_down backoff + terminal states (success / denied / expired).
  while (now() < expiresAtMs) {
    await sleep(intervalSec * 1000);

    let pollResp: DevicePollResponse;
    try {
      pollResp = await client.pollDeviceFlow(startResp.device_code_id);
    } catch (err) {
      // Transient network hiccup — warn, but keep polling. If the error
      // persists, the device will expire and we'll exit via the loop.
      stderr(`  (poll warning: ${(err as Error).message.slice(0, 200)}; retrying)\n`);
      continue;
    }

    switch (pollResp.status) {
      case "pending":
        stdout("  still waiting…\n");
        continue;
      case "slow_down":
        intervalSec = pollResp.interval_sec ?? intervalSec + 5;
        stdout(`  GitHub says slow down — backing off to ${intervalSec}s between polls\n`);
        continue;
      case "expired":
        return { kind: "expired" };
      case "denied":
        return { kind: "denied", reason: pollResp.reason };
      case "already_succeeded":
        // Unusual — someone polled before us. Treat as expired; a re-init
        // will mint a fresh token.
        return { kind: "expired" };
      case "success": {
        stdout(`  ✓ authorized. Installing CONCLAVE_TOKEN as repo secret…\n`);
        try {
          const setSecret = deps.setGhSecret ?? defaultSetGhSecret;
          await setSecret({ repoSlug, name: "CONCLAVE_TOKEN", value: pollResp.token });
          stdout(`  ✓ CONCLAVE_TOKEN stored on ${repoSlug}\n`);
        } catch (err) {
          stderr(
            `  ⚠ failed to run \`gh secret set\`: ${(err as Error).message}\n` +
              `  Set it manually: gh secret set CONCLAVE_TOKEN --repo ${repoSlug} --body '${pollResp.token}'\n`,
          );
        }
        return { kind: "success", token: pollResp.token, rotated: Boolean(pollResp.rotated) };
      }
      case "error":
        return { kind: "error", message: pollResp.message ?? "central plane returned an unstructured error" };
      default:
        // TypeScript exhaustiveness — any new status should hit this only
        // if the server added a state the CLI hasn't learned about yet.
        return { kind: "error", message: `unknown status: ${JSON.stringify(pollResp)}` };
    }
  }

  return { kind: "expired" };
}
