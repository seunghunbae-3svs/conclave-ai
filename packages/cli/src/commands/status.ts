/**
 * `conclave status` — single-call install summary (H1 #2, v0.13.16+).
 *
 * Print one screen of state about THIS install: which bot is wired up,
 * is the webhook bound, how many chats are linked, what the last few
 * cycles did, has anything errored recently.
 *
 * Replaces the 4-hour PR #32 debugging session ("did the click reach
 * the worker? is it the right bot? is the chat linked? are recent
 * cycles passing?") with one HTTP call to /admin/install-summary.
 *
 * Auth: same Bearer-CONCLAVE_TOKEN gate as `conclave doctor`. The
 * token is read from env or `conclave config` storage; we don't
 * surface it on stdout.
 */

import { hydrateEnvFromStorage } from "../lib/credentials.js";

const DEFAULT_WORKER_BASE = "https://conclave-ai.seunghunbae.workers.dev";
const HTTP_TIMEOUT_MS = 8_000;

export interface StatusDeps {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  readonly workerBase?: string;
  readonly stdout?: (s: string) => void;
  readonly stderr?: (s: string) => void;
}

export interface StatusBot {
  id: number;
  username?: string;
  firstName?: string;
}

export interface StatusWebhook {
  outcome: "bound" | "dropped" | "wrong-url" | "no-bot-token" | "telegram-unreachable";
  expected: string | null;
  actual: string | null;
  pendingUpdates: number;
  lastErrorMessage: string | null;
  lastErrorDate: number | null;
}

export interface StatusRecentCycle {
  pr: number;
  episodic: string;
  at: string;
}

export interface StatusSummary {
  ok: boolean;
  install: { id: string; repo: string };
  bot: StatusBot | null;
  webhook: StatusWebhook;
  linkedChats: number;
  recentCycles: StatusRecentCycle[];
}

/**
 * Fetch + render the install summary. Pure I/O is injectable so the
 * formatting can be unit-tested without spinning up the worker.
 */
export async function runStatus(
  argv: readonly string[],
  deps: StatusDeps = {},
): Promise<{ code: number; summary?: StatusSummary }> {
  const stdout = deps.stdout ?? ((s: string) => process.stdout.write(s));
  const stderr = deps.stderr ?? ((s: string) => process.stderr.write(s));
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const env = deps.env ?? process.env;
  const verbose = argv.includes("--verbose") || argv.includes("-v");
  const json = argv.includes("--json");

  const token = env.CONCLAVE_TOKEN;
  if (!token) {
    stderr("conclave status: CONCLAVE_TOKEN not set. Run `conclave config` first.\n");
    return { code: 1 };
  }
  const base = (deps.workerBase ?? env.CONCLAVE_CENTRAL_URL ?? DEFAULT_WORKER_BASE).replace(/\/$/, "");

  if (!fetchImpl) {
    stderr("conclave status: no fetch implementation available (need Node 18+ or a polyfill).\n");
    return { code: 1 };
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  let summary: StatusSummary;
  try {
    const res = await fetchImpl(`${base}/admin/install-summary`, {
      headers: { authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (res.status === 401) {
      stderr("conclave status: 401 — CONCLAVE_TOKEN not recognised by the central plane.\n");
      return { code: 1 };
    }
    if (res.status === 404) {
      stderr("conclave status: 404 — central plane lacks /admin/install-summary. Redeploy the worker (cli@0.13.16+ requires worker v0.13.16+).\n");
      return { code: 1 };
    }
    if (!res.ok) {
      stderr(`conclave status: HTTP ${res.status} from central plane.\n`);
      return { code: 1 };
    }
    summary = (await res.json()) as StatusSummary;
  } catch (err) {
    clearTimeout(t);
    stderr(`conclave status: ${err instanceof Error ? err.message : String(err)}\n`);
    return { code: 1 };
  }

  if (json) {
    stdout(JSON.stringify(summary, null, 2) + "\n");
    return { code: 0, summary };
  }
  stdout(formatStatusOneLine(summary) + "\n");
  if (verbose) stdout(formatStatusVerbose(summary));
  return { code: 0, summary };
}

/**
 * One-line headline. Easy to scan; suitable as the default terminal
 * output. Includes traffic-light for the loop-relevant pieces.
 *
 *   conclave install: acme/x | bot=@Conclave_AI | webhook=bound (0 pending) | 1 chat | 5 cycles in last 7d
 */
export function formatStatusOneLine(s: StatusSummary): string {
  const bot = s.bot
    ? `bot=@${s.bot.username ?? `id:${s.bot.id}`}`
    : "bot=NOT-CONFIGURED";
  const wh = s.webhook;
  const whBadge =
    wh.outcome === "bound"
      ? `webhook=bound (${wh.pendingUpdates} pending)`
      : `webhook=${wh.outcome}`;
  const chats = `${s.linkedChats} chat${s.linkedChats === 1 ? "" : "s"}`;
  const recent = `${s.recentCycles.length} recent cycle${s.recentCycles.length === 1 ? "" : "s"}`;
  return `conclave install: ${s.install.repo} | ${bot} | ${whBadge} | ${chats} | ${recent}`;
}

/**
 * Multi-line breakdown shown with --verbose. Surfaces the last error
 * timestamps and recent-cycle PRs.
 */
export function formatStatusVerbose(s: StatusSummary): string {
  const lines: string[] = [];
  lines.push(`  install id:    ${s.install.id}`);
  if (s.bot) {
    lines.push(`  bot:           @${s.bot.username ?? "?"} (${s.bot.firstName ?? "?"}, id ${s.bot.id})`);
  } else {
    lines.push(`  bot:           NOT CONFIGURED — set TELEGRAM_BOT_TOKEN on the worker`);
  }
  lines.push(`  webhook:       ${s.webhook.outcome}`);
  if (s.webhook.expected) lines.push(`    expected:    ${s.webhook.expected}`);
  if (s.webhook.actual !== null) lines.push(`    actual:      ${s.webhook.actual || "(empty)"}`);
  if (s.webhook.lastErrorMessage) {
    const ago = s.webhook.lastErrorDate
      ? ` (${secondsAgo(s.webhook.lastErrorDate)} ago)`
      : "";
    lines.push(`    last error:  ${s.webhook.lastErrorMessage}${ago}`);
  }
  lines.push(`  linked chats:  ${s.linkedChats}`);
  if (s.recentCycles.length === 0) {
    lines.push(`  recent cycles: none yet`);
  } else {
    lines.push(`  recent cycles:`);
    for (const c of s.recentCycles) {
      lines.push(`    PR #${c.pr}  ${c.episodic.slice(0, 14)}…  ${c.at}`);
    }
  }
  return lines.join("\n") + "\n";
}

function secondsAgo(unix: number): string {
  const delta = Math.max(0, Math.floor(Date.now() / 1000 - unix));
  if (delta < 60) return `${delta}s`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h`;
  return `${Math.floor(delta / 86400)}d`;
}

/** Entry point for the bin dispatcher. */
export async function status(argv: string[]): Promise<void> {
  await hydrateEnvFromStorage();
  const { code } = await runStatus(argv);
  if (code !== 0) process.exit(code);
}
