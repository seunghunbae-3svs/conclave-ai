#!/usr/bin/env node
/**
 * scripts/dev-loop/run-next.mjs
 *
 * Autonomous development orchestrator. Reads `.dev-loop-state.json` +
 * `docs/dev-roadmap.md` to figure out the next pending item, spawns
 * Claude Code headless to do the work, then advances the state.
 *
 * Operating contract (mirrors the human contract in dev-roadmap.md):
 *
 *   1. ONE item per run. Pick the lowest-numbered pending item.
 *   2. Spawn `claude --print --dangerously-skip-permissions` with a
 *      prompt that lays out the rules (verify before commit, no
 *      destructive operations, etc.).
 *   3. Detect whether the agent actually shipped (commit + push +
 *      `pnpm test` green). If yes → advance state.
 *      If no → increment consecutiveFailures.
 *   4. Hard stops:
 *        - frozen=true → exit 0 (manual unfreeze required)
 *        - consecutiveFailures >= 3 → freeze + exit 0
 *        - perRunCapUsd or perDayCapUsd exceeded → exit 0 with notice
 *   5. The state file (`.dev-loop-state.json`) is committed at the
 *      end of every run so the next run picks up where this one left
 *      off, even if the runner is reboot-ephemeral.
 *
 * Inputs (env):
 *   ANTHROPIC_API_KEY   required — passed through to claude CLI
 *   DEV_LOOP_ITEM       optional — override the next-item picker.
 *                       Used by the workflow_dispatch input so an
 *                       operator can resume mid-roadmap manually.
 *   DEV_LOOP_DRY_RUN    when "true" — print the prompt + plan but
 *                       DO NOT spawn claude (used by the workflow's
 *                       smoke test).
 *
 * Exit codes:
 *   0  normal — including frozen / cap-reached / dry-run
 *   2  misuse — missing env, can't read roadmap
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync, execSync } from "node:child_process";
import path from "node:path";

const STATE_FILE = ".dev-loop-state.json";
const ROADMAP_FILE = "docs/dev-roadmap.md";
const HARD_FREEZE_AFTER_FAILS = 3;
const PROMPT_VERSION = "v0.13.21-2026-04-27";

const repoRoot = process.cwd();

function readJson(relPath) {
  const full = path.join(repoRoot, relPath);
  if (!existsSync(full)) return null;
  return JSON.parse(readFileSync(full, "utf8"));
}

function writeJson(relPath, obj) {
  writeFileSync(path.join(repoRoot, relPath), JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function readText(relPath) {
  const full = path.join(repoRoot, relPath);
  if (!existsSync(full)) return null;
  return readFileSync(full, "utf8");
}

function gitOutput(args) {
  try {
    return execSync(`git ${args}`, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    }).trimEnd();
  } catch {
    return "";
  }
}

/**
 * Send a Telegram message to every chat linked to the conclave-ai
 * install. Goes through the central plane's `/dev-loop/notify` route
 * (added in v0.13.22) so we reuse the existing TELEGRAM_BOT_TOKEN +
 * telegram_links wiring instead of registering separate bot
 * credentials in GitHub.
 *
 * Auth: CONCLAVE_TOKEN — the same install token review/rework/merge
 * workflows already use, no new secret needed.
 *
 * Silent no-op when CONCLAVE_TOKEN is missing, so the loop keeps
 * working even before notification is wired.
 */
async function notifyTelegram(text) {
  const token = process.env.CONCLAVE_TOKEN;
  const apiBase = process.env.CONCLAVE_CENTRAL_URL || "https://conclave-ai.seunghunbae.workers.dev";
  if (!token) return;
  try {
    const res = await fetch(`${apiBase}/dev-loop/notify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ event: "dev-loop", text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      process.stderr.write(`Telegram notify failed: ${res.status} ${body.slice(0, 200)}\n`);
    }
  } catch (err) {
    process.stderr.write(`Telegram notify error: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

/**
 * Parse the roadmap markdown to extract the ordered list of items
 * (e.g. "H1.5 A", "H1.5 B", "H1.5 C", "H2 #6", ...). Used both to
 * advance currentItem when an item ships AND to validate that
 * DEV_LOOP_ITEM (if provided) is a known item.
 *
 * Item shape recognition is by leading-text heuristic on the
 * roadmap's bullet-list lines. Order is the order they appear in
 * the markdown.
 */
export function extractRoadmapItems(markdown) {
  const items = [];
  const lines = markdown.split("\n");
  // Track current horizon header so we can prefix bullets.
  let horizon = "";
  for (const raw of lines) {
    const m = raw.match(/^##\s+(H[1-4](?:\.[0-9]+)?)\b/);
    if (m) {
      horizon = m[1];
      continue;
    }
    // A. / B. / C. bullets (used in H1.5)
    const ab = raw.match(/^\*\*([A-Z])\.\s+(.+?)\*\*/);
    if (ab && horizon) {
      items.push({ id: `${horizon} ${ab[1]}`, label: ab[2].slice(0, 60) });
      continue;
    }
    // 1. / 2. / 3. ... bullets (numbered) — used in H1, H2, H3, H4
    const num = raw.match(/^(\d+)\.\s+\*\*(.+?)\*\*/);
    if (num && horizon) {
      items.push({ id: `${horizon} #${num[1]}`, label: num[2].slice(0, 60) });
      continue;
    }
  }
  return items;
}

/**
 * Pick the next pending item — i.e. the item AFTER `lastShipped` in
 * roadmap order. Returns null when the roadmap is exhausted.
 */
export function pickNextItem(items, lastShipped) {
  if (items.length === 0) return null;
  if (!lastShipped) return items[0];
  const idx = items.findIndex((it) => it.id === lastShipped);
  if (idx < 0) {
    // lastShipped not in list anymore (rename / removal). Fall back
    // to currentItem heuristic by parsing horizon.
    return items[0];
  }
  return items[idx + 1] ?? null;
}

function isUtcSameDay(isoA, isoB) {
  return isoA.slice(0, 10) === isoB.slice(0, 10);
}

function maybeResetDailySpend(state, nowIso) {
  if (!state.lastSpendResetDate || !isUtcSameDay(state.lastSpendResetDate, nowIso)) {
    state.totalSpentUsdToday = 0;
    state.lastSpendResetDate = nowIso;
  }
}

function buildPrompt(item, state) {
  const now = new Date().toISOString();
  return [
    `# Conclave AI dev-loop run (${PROMPT_VERSION}, ${now})`,
    ``,
    `You are running inside an autonomous GitHub Actions cron loop on the conclave-ai repo. Your job for THIS run:`,
    ``,
    `## Current item`,
    `**${item.id}** — ${item.label}`,
    ``,
    `Read \`docs/dev-roadmap.md\` for the full description of this item, then implement, test, commit, and ship as you would in an interactive session. ONE item only — don't try to do the next item too.`,
    ``,
    `## Operating contract (MUST follow)`,
    `1. Implement the change in code.`,
    `2. Add hermetic unit tests.`,
    `3. Build affected packages: \`pnpm -C <package> build\`.`,
    `4. Run \`pnpm -C <package> test\`. If any test fails, fix and re-run before committing.`,
    `5. Commit with a clear message including the item id (e.g. "feat(...): xxx (${item.id}, v...)").`,
    `6. Push to main: \`git push origin main\` (no force, no skip-hooks).`,
    `7. If this introduces a new public CLI feature: trigger a release with \`gh workflow run release.yml -f bump=patch\`, wait for completion, then bump the workflow defaults (\`.github/workflows/{review,rework,merge}.yml\` cli-version) and move v0.4 floating tag to the new HEAD.`,
    `8. Update \`docs/dev-roadmap.md\` to mark this item as ✅ shipped.`,
    `9. **DO NOT** modify \`.dev-loop-state.json\` — the orchestrator handles that.`,
    ``,
    `## Hard rules`,
    `- NEVER force-push to main.`,
    `- NEVER \`git reset --hard\`.`,
    `- NEVER skip CI hooks (\`--no-verify\`).`,
    `- NEVER trigger \`conclave audit\` (live cost). H1.5 A's deliverable is the CODE+VERIFICATION readiness; the actual audit run is a separate Bae-triggered action.`,
    `- LLM cost cap for THIS run: $${state.perRunCapUsd.toFixed(2)}.`,
    ``,
    `## What I've already done (history)`,
    state.history.map((h) => `- ${h.item} → ${h.version} at ${h.shippedAt}`).join("\n"),
    ``,
    `## Stop conditions`,
    `- If you cannot complete the item in this run, commit whatever you have under a feature branch (NOT main) and exit. The orchestrator will mark this run as a failure but won't repeat the work.`,
    `- If the item depends on operator action (e.g. \`wrangler login\`), explain what the operator needs to do and exit without committing.`,
    `- If \`pnpm test\` fails after 3 fix attempts, exit. Don't ship a known-broken state.`,
    ``,
    `## After completion`,
    `Print a one-line summary on stdout in this exact shape so the orchestrator can parse it:`,
    `\`\`\``,
    `DEVLOOP_RESULT: { "shipped": true, "version": "cli@0.13.X", "commit": "<sha>", "summary": "<one sentence>" }`,
    `\`\`\``,
    ``,
    `Or on failure / partial progress:`,
    `\`\`\``,
    `DEVLOOP_RESULT: { "shipped": false, "reason": "<one sentence>", "summary": "<what got done>" }`,
    `\`\`\``,
    ``,
    `Begin.`,
  ].join("\n");
}

/**
 * Parse the agent's stdout for `DEVLOOP_RESULT: {...}` line.
 * Resilient to multiple lines / surrounding chatter.
 */
export function parseAgentResult(stdout) {
  const re = /DEVLOOP_RESULT:\s*(\{[^\n]*\})/m;
  const m = stdout.match(re);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const dryRun = process.env.DEV_LOOP_DRY_RUN === "true";
  if (!apiKey && !dryRun) {
    process.stderr.write("ANTHROPIC_API_KEY not set\n");
    process.exit(2);
  }

  const state = readJson(STATE_FILE);
  if (!state) {
    process.stderr.write(`${STATE_FILE} not found at repo root\n`);
    process.exit(2);
  }
  const roadmap = readText(ROADMAP_FILE);
  if (!roadmap) {
    process.stderr.write(`${ROADMAP_FILE} not found\n`);
    process.exit(2);
  }

  const nowIso = new Date().toISOString();
  maybeResetDailySpend(state, nowIso);

  if (state.frozen) {
    process.stdout.write(`dev-loop FROZEN: ${state.frozenReason ?? "(no reason given)"}\n`);
    process.stdout.write(`Reset .dev-loop-state.json {frozen:false} to resume.\n`);
    return;
  }
  if (state.consecutiveFailures >= HARD_FREEZE_AFTER_FAILS) {
    state.frozen = true;
    state.frozenReason = `auto-freeze after ${state.consecutiveFailures} consecutive failures`;
    writeJson(STATE_FILE, state);
    process.stdout.write(`dev-loop AUTO-FROZEN after ${state.consecutiveFailures} failures.\n`);
    await notifyTelegram(
      `🚨 dev-loop AUTO-FROZEN\n${state.consecutiveFailures} consecutive failures. Manual intervention needed.\n\nFix the underlying issue, then:\n  - Edit .dev-loop-state.json: frozen=false, consecutiveFailures=0\n  - Or trigger: gh workflow run dev-loop.yml -f mode=real`,
    );
    return;
  }
  if (state.totalSpentUsdToday >= state.perDayCapUsd) {
    process.stdout.write(`dev-loop DAY-CAP REACHED ($${state.totalSpentUsdToday}/$${state.perDayCapUsd}). Try again tomorrow.\n`);
    await notifyTelegram(
      `💸 dev-loop day cap reached\nSpent: $${state.totalSpentUsdToday.toFixed(2)} / $${state.perDayCapUsd}\nResumes tomorrow (UTC).`,
    );
    return;
  }

  const items = extractRoadmapItems(roadmap);
  let nextItem;
  if (process.env.DEV_LOOP_ITEM) {
    nextItem = items.find((i) => i.id === process.env.DEV_LOOP_ITEM);
    if (!nextItem) {
      process.stderr.write(`DEV_LOOP_ITEM "${process.env.DEV_LOOP_ITEM}" not found in roadmap. Available: ${items.map((i) => i.id).join(", ")}\n`);
      process.exit(2);
    }
  } else {
    nextItem = pickNextItem(items, state.lastShipped);
  }
  if (!nextItem) {
    process.stdout.write("dev-loop: roadmap exhausted — no pending items 🎉\n");
    await notifyTelegram(
      `🎉 Roadmap complete!\nAll ${items.length} items shipped. Conclave AI is feature-complete per the H1–H4 plan.`,
    );
    return;
  }

  state.currentItem = nextItem.id;
  writeJson(STATE_FILE, state);

  const prompt = buildPrompt(nextItem, state);
  if (dryRun) {
    process.stdout.write("--- DRY-RUN: prompt that would be sent to claude ---\n");
    process.stdout.write(prompt + "\n");
    process.stdout.write("--- END PROMPT ---\n");
    process.stdout.write(`Next item: ${nextItem.id}\n`);
    return;
  }

  await notifyTelegram(
    `🚀 dev-loop run started\nItem: ${nextItem.id} — ${nextItem.label}\nSpent today: $${state.totalSpentUsdToday.toFixed(2)} / $${state.perDayCapUsd}\nFailures so far: ${state.consecutiveFailures}/3`,
  );

  // OP-1 — per-item retry counter so a stuck item can't burn cycles
  // forever. The reset/ceiling logic is extracted as `evaluatePerItemCeiling`
  // so OP-2's hermetic tests can simulate the state machine without
  // spawning real claude processes.
  const PER_ITEM_RETRY_CEILING = 3;
  const ceilingCheck = evaluatePerItemCeiling(
    state.perItemRetries,
    nextItem.id,
    PER_ITEM_RETRY_CEILING,
  );
  state.perItemRetries = ceilingCheck.next;
  if (ceilingCheck.shouldFreeze) {
    state.frozen = true;
    state.frozenReason = `per-item ceiling: ${nextItem.id} failed ${ceilingCheck.next.count}× in a row — manual investigation required`;
    writeJson(STATE_FILE, state);
    process.stdout.write(
      `dev-loop AUTO-FROZEN — ${nextItem.id} hit per-item retry ceiling ${PER_ITEM_RETRY_CEILING}\n`,
    );
    await notifyTelegram(
      `🚨 dev-loop FROZEN — same-item retry ceiling\nItem ${nextItem.id} failed ${ceilingCheck.next.count} times in a row. Same item won't be retried automatically. Investigate the Actions log; once you understand the failure: edit .dev-loop-state.json (frozen=false, perItemRetries={}), then \`gh workflow run dev-loop.yml -f mode=real\`.`,
    );
    return;
  }

  // Spawn Claude Code in headless / non-interactive mode.
  // --dangerously-skip-permissions because the workflow's git/test
  // permissions are already gated by the runner's permissions block.
  // OP-1 — maxBuffer raised from 50MB to 200MB. A long claude session
  // produces tens of MB of stdout (transcript + tool calls echoed
  // back); 50MB hit a hard SIGTERM from Node when claude rambled on a
  // large refactor (status=null in the postmortem with no diagnostic).
  // 200MB is a comfortable ceiling that bounds runaway buffers but
  // doesn't false-trip on legit long sessions.
  const r = spawnSync(
    "claude",
    ["--print", "--dangerously-skip-permissions"],
    {
      cwd: repoRoot,
      input: prompt,
      stdio: ["pipe", "pipe", "inherit"],
      encoding: "utf8",
      env: { ...process.env, ANTHROPIC_API_KEY: apiKey },
      maxBuffer: 200 * 1024 * 1024,
    },
  );
  const stdout = r.stdout ?? "";
  process.stdout.write(stdout);

  if (r.status !== 0) {
    // OP-1 — disambiguate the exit shape so operators can tell apart
    //   - status=number ≠ 0 : claude returned non-zero exit code
    //   - status=null + signal=SIGTERM : killed by Node (timeout / OOM-kill / stdout overflow)
    //   - status=null + error.code=ENOENT : spawn failed (claude not on PATH)
    //   - status=null + error.code=ERR_CHILD_PROCESS_STDIO_MAXBUFFER : maxBuffer exceeded
    //   - status=null + signal=null : impossible-but-defensive
    // Pre-OP-1, all 5 of these printed identically as "claude exited null".
    const diag = describeSpawnFailure(r);
    state.consecutiveFailures += 1;
    state.perItemRetries.count += 1;
    writeJson(STATE_FILE, state);
    process.stderr.write(
      `claude failed: ${diag.short}\n  detail: ${diag.detail}\n  consecutiveFailures=${state.consecutiveFailures} perItem=${state.perItemRetries.count}/${PER_ITEM_RETRY_CEILING}\n`,
    );
    await notifyTelegram(
      `❌ ${nextItem.id} failed (${diag.short})\n${diag.detail}\n\nFailures: ${state.consecutiveFailures}/3 (item retry ${state.perItemRetries.count}/${PER_ITEM_RETRY_CEILING})\n${diag.hint}`,
    );
    return;
  }

  const result = parseAgentResult(stdout);
  if (!result) {
    state.consecutiveFailures += 1;
    state.perItemRetries.count += 1;
    writeJson(STATE_FILE, state);
    process.stderr.write(
      `agent stdout did not contain DEVLOOP_RESULT line; treating as failure (perItem ${state.perItemRetries.count}/${PER_ITEM_RETRY_CEILING})\n`,
    );
    await notifyTelegram(
      `❌ ${nextItem.id} failed\nNo DEVLOOP_RESULT line in stdout (likely workflow timeout — check Actions log).\nFailures: ${state.consecutiveFailures}/3 (item retry ${state.perItemRetries.count}/${PER_ITEM_RETRY_CEILING})`,
    );
    return;
  }

  const headSha = gitOutput("rev-parse HEAD");
  if (result.shipped === true) {
    state.lastShipped = nextItem.id;
    state.lastShippedAt = nowIso;
    state.consecutiveFailures = 0;
    state.perItemRetries = { item: null, count: 0 }; // OP-1 — reset on ship.
    state.history.push({
      item: nextItem.id,
      shippedAt: nowIso,
      version: result.version ?? "(unknown)",
      commit: headSha,
    });
    writeJson(STATE_FILE, state);
    process.stdout.write(`✓ ${nextItem.id} shipped (commit ${headSha.slice(0, 8)}, ${result.version ?? "?"})\n`);
    await notifyTelegram(
      `✅ ${nextItem.id} shipped\n${nextItem.label}\nVersion: ${result.version ?? "?"}\nCommit: ${headSha.slice(0, 8)}\nSummary: ${result.summary ?? "(no summary)"}\n\nNext run in ~12h.`,
    );
  } else {
    state.consecutiveFailures += 1;
    state.perItemRetries.count += 1;
    writeJson(STATE_FILE, state);
    process.stdout.write(
      `✗ ${nextItem.id} not shipped — ${result.reason ?? "(no reason)"}; consecutiveFailures=${state.consecutiveFailures} perItem=${state.perItemRetries.count}/${PER_ITEM_RETRY_CEILING}\n`,
    );
    await notifyTelegram(
      `❌ ${nextItem.id} not shipped\nReason: ${result.reason ?? "(no reason)"}\nWhat got done: ${result.summary ?? "(none)"}\nFailures: ${state.consecutiveFailures}/3 (item retry ${state.perItemRetries.count}/${PER_ITEM_RETRY_CEILING})`,
    );
  }
}

/**
 * OP-2 — pure state-transition helper for the per-item retry guard.
 * Inputs: the previous `perItemRetries` shape (may be `null` /
 * `undefined` / `{}` for fresh state), the item id we're ABOUT to
 * try, and the ceiling. Returns:
 *   - `next`: the perItemRetries shape that should be persisted.
 *     - new item OR fresh state → `{ item: id, count: 0 }`
 *     - same item retried → `{ item: id, count: prior.count }` unchanged
 *   - `shouldFreeze`: true iff the resulting count is >= ceiling.
 *
 * The CALLER is responsible for incrementing count on a failed run;
 * this helper only handles the "should we proceed before spawning"
 * decision.
 */
export function evaluatePerItemCeiling(prev, itemId, ceiling) {
  let next;
  if (!prev || prev.item !== itemId) {
    next = { item: itemId, count: 0 };
  } else {
    next = { item: itemId, count: prev.count };
  }
  return { next, shouldFreeze: next.count >= ceiling };
}

/**
 * OP-1 — classify a spawnSync failure into a human-readable
 * (short, detail, hint) tuple. Pre-OP-1 this was a single line
 * "claude exited null" with no info; the postmortem on H1.5 B's
 * 5 retry crashes spent half a day re-deriving what the failure
 * shape was. Now it tells you on the first line.
 *
 * Exported for hermetic testing.
 */
export function describeSpawnFailure(r) {
  // r is the spawnSync return object: { status, signal, error?, stdout, stderr }
  if (r.error) {
    const code = r.error.code ?? "(no code)";
    const msg = r.error.message ?? String(r.error);
    if (code === "ENOENT") {
      return {
        short: "spawn ENOENT",
        detail: `claude binary not on PATH (msg: ${msg})`,
        hint: "Install Claude Code CLI on the runner: `npm i -g @anthropic-ai/claude-code`",
      };
    }
    if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      return {
        short: "stdout buffer overflow",
        detail: `claude exceeded the maxBuffer cap (raised to 200MB; this means the session was unusually verbose)`,
        hint: "Consider scoping the next prompt smaller, OR raising maxBuffer further in run-next.mjs",
      };
    }
    return {
      short: `spawn ${code}`,
      detail: `Node could not spawn claude — ${msg}`,
      hint: "Check the Actions log for the underlying error (PATH, permissions, executable bit)",
    };
  }
  if (r.signal) {
    if (r.signal === "SIGTERM" || r.signal === "SIGKILL") {
      return {
        short: `killed by ${r.signal}`,
        detail: `claude was killed by Node — likely the workflow's timeout-minutes hit, or the OS killed it for OOM`,
        hint: "Check Actions log: was the run >90 min (workflow timeout)? Or did the runner hit memory pressure?",
      };
    }
    return {
      short: `signal ${r.signal}`,
      detail: `claude received signal ${r.signal} (uncommon)`,
      hint: "Check Actions log for the runtime context",
    };
  }
  if (typeof r.status === "number" && r.status !== 0) {
    return {
      short: `exit ${r.status}`,
      detail: `claude exited with non-zero status ${r.status}`,
      hint: "Check stderr / Actions log for claude's error message",
    };
  }
  // Defensive: status null AND signal null AND no error — should never happen.
  return {
    short: "unknown failure",
    detail: `spawnSync returned status=${r.status} signal=${r.signal} error=${r.error ?? "(none)"} — please file an issue`,
    hint: "This shape was previously printed as 'claude exited null'; OP-1 makes it impossible to hit silently",
  };
}

const invokedDirectly = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`;
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`dev-loop run-next failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(2);
  });
}
