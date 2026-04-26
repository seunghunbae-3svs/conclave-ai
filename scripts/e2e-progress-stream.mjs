#!/usr/bin/env node
/**
 * v0.11 — live E2E progress stream demo.
 *
 * Fires a realistic timeline of notifyProgress emissions against a real
 * Telegram bot. The same physical message is created on the first emit
 * and edited-in-place on every subsequent emit, demonstrating the
 * primary v0.11 promise: "리뷰 도중 무엇이 일어나고 있는지 실시간으로 본다".
 *
 * USAGE:
 *   TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... \
 *     node scripts/e2e-progress-stream.mjs
 *
 * Each phase is paced ~1.2s apart so a human watching the chat sees
 * the message visibly grow line-by-line. The pacing also stays under
 * Telegram's ~1 edit/sec/chat budget without needing a debounce.
 */

import { TelegramNotifier } from "../packages/integration-telegram/dist/index.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
if (!token || !chatId) {
  console.error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID required");
  process.exit(1);
}

const notifier = new TelegramNotifier({
  token,
  chatId: Number(chatId),
  // Force direct path for this demo; central path requires CONCLAVE_TOKEN
  // + a deployed central plane and a linked install, which is what we
  // exercise separately via the Worker's own integration tests.
  useCentralPlane: false,
  includeActionButtons: true,
});

const episodicId = `ep-e2e-${Date.now()}`;
const repo = "seunghunbae-3svs/eventbadge";
const pullNumber = 42;

const timeline = [
  {
    stage: "review-started",
    payload: {
      repo,
      pullNumber,
      agentIds: ["claude", "openai", "gemini"],
    },
  },
  {
    stage: "visual-capture-started",
    payload: { repo, pullNumber, routes: ["/", "/dashboard"] },
  },
  {
    stage: "visual-capture-done",
    payload: { repo, pullNumber, artifactCount: 4, totalMs: 8420 },
  },
  {
    stage: "tier1-done",
    payload: { repo, pullNumber, blockerCount: 2, rounds: 1 },
  },
  {
    stage: "escalating-to-tier2",
    payload: { repo, pullNumber, reason: "tier-1 verdicts split (2 rework, 1 approve)" },
  },
  {
    stage: "tier2-done",
    payload: { repo, pullNumber, blockerCount: 1, rounds: 2 },
  },
  {
    stage: "autofix-iter-started",
    payload: { repo, pullNumber, iteration: 1 },
  },
  {
    stage: "autofix-iter-done",
    payload: { repo, pullNumber, iteration: 1, fixesVerified: 1 },
  },
];

console.log(`[e2e] episodic: ${episodicId}`);
console.log(`[e2e] target chat: ${chatId}`);
console.log(`[e2e] firing ${timeline.length} stages with 1.2s pacing\n`);

for (const [i, { stage, payload }] of timeline.entries()) {
  const t0 = Date.now();
  await notifier.notifyProgress({ episodicId, stage, payload });
  const dt = Date.now() - t0;
  console.log(`[e2e] ${i + 1}/${timeline.length} ${stage} (${dt}ms)`);
  if (i < timeline.length - 1) {
    await new Promise((r) => setTimeout(r, 1200));
  }
}

console.log(`\n[e2e] timeline complete — single Telegram message updated ${timeline.length} times`);
