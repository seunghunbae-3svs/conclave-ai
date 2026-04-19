import {
  BudgetTracker,
  Council,
  EfficiencyGate,
  FileSystemMemoryStore,
  MetricsRecorder,
  OutcomeWriter,
  formatAnswerKeyForPrompt,
  formatFailureForPrompt,
  type MetricsSink,
  type ReviewContext,
} from "@ai-conclave/core";
import { ClaudeAgent } from "@ai-conclave/agent-claude";
import { OpenAIAgent } from "@ai-conclave/agent-openai";
import { GeminiAgent } from "@ai-conclave/agent-gemini";
import { LangfuseMetricsSink } from "@ai-conclave/observability-langfuse";
import { TelegramNotifier } from "@ai-conclave/integration-telegram";
import { DiscordNotifier } from "@ai-conclave/integration-discord";
import { SlackNotifier } from "@ai-conclave/integration-slack";
import { EmailNotifier } from "@ai-conclave/integration-email";
import type { Notifier } from "@ai-conclave/core";
import { loadConfig, resolveMemoryRoot } from "../lib/config.js";
import { loadPrDiff, loadGitDiff, loadFileDiff, type LoadedDiff } from "../lib/diff-source.js";
import { renderReview, verdictToExitCode } from "../lib/output.js";
import { buildPlatforms, type PlatformId } from "../lib/platform-factory.js";

function parseArgv(argv: string[]): {
  pr?: number;
  diff?: string;
  base?: string;
  visual: boolean;
  noVisual: boolean;
  help: boolean;
} {
  const out: {
    pr?: number;
    diff?: string;
    base?: string;
    visual: boolean;
    noVisual: boolean;
    help: boolean;
  } = { help: false, visual: false, noVisual: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--visual") out.visual = true;
    else if (a === "--no-visual") out.noVisual = true;
    else if (a === "--pr" && argv[i + 1]) {
      const n = Number.parseInt(argv[i + 1]!, 10);
      if (!Number.isNaN(n)) out.pr = n;
      i += 1;
    } else if (a === "--diff" && argv[i + 1]) {
      out.diff = argv[i + 1];
      i += 1;
    } else if (a === "--base" && argv[i + 1]) {
      out.base = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

const HELP = `conclave review — run a council review on the current branch

Usage:
  conclave review [--pr N] [--diff <file>] [--base <ref>] [--visual|--no-visual]

Options:
  --pr N         Review PR N using gh CLI (preferred — includes repo context).
  --diff <file>  Review a unified-diff file directly.
  --base <ref>   Base ref for 'git diff' when neither --pr nor --diff given (default: origin/main).
  --visual       Force-enable before/after visual diff (needs platform tokens + playwright).
  --no-visual    Force-disable visual diff for this run (overrides .conclaverc.json).

Environment:
  ANTHROPIC_API_KEY   required — Claude review call.

Visual review reads platform tokens from env: VERCEL_TOKEN, NETLIFY_TOKEN,
CLOUDFLARE_API_TOKEN + account/project, or falls back to gh CLI via the
deployment-status adapter.
`;

export async function review(argv: string[]): Promise<void> {
  const args = parseArgv(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  const { config, configDir } = await loadConfig();
  const memoryRoot = resolveMemoryRoot(config, configDir);

  // 1. Load diff
  let loaded: LoadedDiff;
  if (args.pr !== undefined) {
    loaded = await loadPrDiff(args.pr);
  } else if (args.diff) {
    loaded = await loadFileDiff(args.diff);
  } else {
    loaded = await loadGitDiff(args.base ?? "origin/main");
  }

  if (!loaded.diff.trim()) {
    process.stderr.write("conclave review: empty diff — nothing to review.\n");
    process.exit(0);
    return;
  }

  // 2. Retrieve RAG context from memory
  const store = new FileSystemMemoryStore({ root: memoryRoot });
  const queryText = `${loaded.repo} ${loaded.diff.slice(0, 4_000)}`;
  const retrieval = await store.retrieve({ query: queryText, repo: loaded.repo, k: 8 });

  // 3. Build the efficiency gate with config-driven budget + optional Langfuse sink
  const budget = new BudgetTracker({ perPrUsd: config.budget.perPrUsd });
  budget.onWarning((spent, cap) => {
    process.stderr.write(`conclave review: budget warning — spent $${spent.toFixed(4)} of $${cap.toFixed(2)} cap\n`);
  });
  let langfuseSink: LangfuseMetricsSink | null = null;
  const sink: MetricsSink | undefined = (() => {
    const lf = config.observability?.langfuse;
    if (!lf?.enabled) return undefined;
    if (!process.env["LANGFUSE_PUBLIC_KEY"] || !process.env["LANGFUSE_SECRET_KEY"]) {
      process.stderr.write(
        "conclave review: langfuse configured but LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY not set — skipping\n",
      );
      return undefined;
    }
    const sinkOpts: ConstructorParameters<typeof LangfuseMetricsSink>[0] = {};
    if (lf.baseUrl) sinkOpts.baseUrl = lf.baseUrl;
    sinkOpts.traceId = `conclave-${loaded.repo.replace(/\//g, "-")}-${loaded.pullNumber || "local"}-${loaded.newSha.slice(0, 8)}`;
    langfuseSink = new LangfuseMetricsSink(sinkOpts);
    return langfuseSink;
  })();
  const metrics = sink ? new MetricsRecorder({ sink }) : new MetricsRecorder();
  const gate = new EfficiencyGate({ budget, metrics });

  // 4. Instantiate the council. Agents enabled in config.agents. An agent
  //    is only included if its credentials are available; others are skipped
  //    with a warning so a missing key doesn't block review.
  const agents = [];
  for (const id of config.agents) {
    if (id === "claude") {
      if (!process.env["ANTHROPIC_API_KEY"]) continue;
      agents.push(new ClaudeAgent({ gate }));
    } else if (id === "openai") {
      if (!process.env["OPENAI_API_KEY"]) {
        process.stderr.write("conclave review: OPENAI_API_KEY not set — skipping OpenAI agent\n");
        continue;
      }
      agents.push(new OpenAIAgent({ gate }));
    } else if (id === "gemini") {
      const hasKey = !!(process.env["GOOGLE_API_KEY"] || process.env["GEMINI_API_KEY"]);
      if (!hasKey) {
        process.stderr.write("conclave review: GOOGLE_API_KEY / GEMINI_API_KEY not set — skipping Gemini agent\n");
        continue;
      }
      agents.push(new GeminiAgent({ gate }));
    }
  }
  if (agents.length === 0) {
    process.stderr.write("conclave review: no agents available. Set at least ANTHROPIC_API_KEY.\n");
    process.exit(1);
    return;
  }
  const council = new Council({ agents });

  // 5. Deliberate
  const reviewCtx: ReviewContext = {
    diff: loaded.diff,
    repo: loaded.repo,
    pullNumber: loaded.pullNumber,
    newSha: loaded.newSha,
    answerKeys: retrieval.answerKeys.map(formatAnswerKeyForPrompt),
    failureCatalog: retrieval.failures.map(formatFailureForPrompt),
  };
  if (loaded.prevSha) reviewCtx.prevSha = loaded.prevSha;

  const outcome = await council.deliberate(reviewCtx);

  // 6. Persist the episodic entry (outcome: "pending") so `conclave
  //    record-outcome` can classify it later into answer-keys / failures.
  const writer = new OutcomeWriter({ store });
  const episodic = await writer.writeReview({
    ctx: reviewCtx,
    reviews: outcome.results,
    councilVerdict: outcome.verdict,
    costUsd: gate.metrics.summary().totalCostUsd,
  });

  // 7. Render + exit with a verdict-derived code
  process.stdout.write(
    renderReview({
      repo: loaded.repo,
      pullNumber: loaded.pullNumber,
      sha: loaded.newSha,
      source: loaded.source,
      councilVerdict: outcome.verdict,
      consensus: outcome.consensusReached,
      results: outcome.results,
      metrics: gate.metrics.summary(),
    }),
  );
  process.stdout.write(
    `\nepisodic: ${episodic.id}\n` +
      `  when the PR lands, close the loop with:\n` +
      `    conclave record-outcome --id ${episodic.id} --result merged\n`,
  );

  // 8. Optional integrations — equal-weight per decision #24. Missing
  //    credentials skip with stderr warning; integration failures never
  //    kill the review exit code.
  const notifiers: Notifier[] = [];
  const tg = config.integrations?.telegram;
  if (tg?.enabled !== false) {
    const hasToken = !!process.env["TELEGRAM_BOT_TOKEN"];
    const hasChat = tg?.chatId !== undefined || !!process.env["TELEGRAM_CHAT_ID"];
    if (tg?.enabled === true && !hasToken) {
      process.stderr.write("conclave review: TELEGRAM_BOT_TOKEN not set — skipping Telegram notifier\n");
    } else if (hasToken && hasChat) {
      const opts: ConstructorParameters<typeof TelegramNotifier>[0] = {};
      if (tg?.chatId !== undefined) opts.chatId = tg.chatId;
      if (tg?.includeActionButtons !== undefined) opts.includeActionButtons = tg.includeActionButtons;
      try {
        notifiers.push(new TelegramNotifier(opts));
      } catch (err) {
        process.stderr.write(`conclave review: Telegram notifier init failed — ${(err as Error).message}\n`);
      }
    }
  }
  const dc = config.integrations?.discord;
  if (dc?.enabled !== false) {
    const hasUrl = !!(dc?.webhookUrl || process.env["DISCORD_WEBHOOK_URL"]);
    if (dc?.enabled === true && !hasUrl) {
      process.stderr.write(
        "conclave review: DISCORD_WEBHOOK_URL not set — skipping Discord notifier\n",
      );
    } else if (hasUrl) {
      const opts: ConstructorParameters<typeof DiscordNotifier>[0] = {};
      if (dc?.webhookUrl) opts.webhookUrl = dc.webhookUrl;
      if (dc?.username) opts.username = dc.username;
      if (dc?.avatarUrl) opts.avatarUrl = dc.avatarUrl;
      try {
        notifiers.push(new DiscordNotifier(opts));
      } catch (err) {
        process.stderr.write(`conclave review: Discord notifier init failed — ${(err as Error).message}\n`);
      }
    }
  }
  const sl = config.integrations?.slack;
  if (sl?.enabled !== false) {
    const hasUrl = !!(sl?.webhookUrl || process.env["SLACK_WEBHOOK_URL"]);
    if (sl?.enabled === true && !hasUrl) {
      process.stderr.write("conclave review: SLACK_WEBHOOK_URL not set — skipping Slack notifier\n");
    } else if (hasUrl) {
      const opts: ConstructorParameters<typeof SlackNotifier>[0] = {};
      if (sl?.webhookUrl) opts.webhookUrl = sl.webhookUrl;
      if (sl?.username) opts.username = sl.username;
      if (sl?.iconUrl) opts.iconUrl = sl.iconUrl;
      if (sl?.iconEmoji) opts.iconEmoji = sl.iconEmoji;
      try {
        notifiers.push(new SlackNotifier(opts));
      } catch (err) {
        process.stderr.write(`conclave review: Slack notifier init failed — ${(err as Error).message}\n`);
      }
    }
  }
  const em = config.integrations?.email;
  if (em?.enabled !== false) {
    const fromConfigured = !!(em?.from || process.env["CONCLAVE_EMAIL_FROM"]);
    const toConfigured = !!(em?.to || process.env["CONCLAVE_EMAIL_TO"]);
    const transportReady = !!process.env["RESEND_API_KEY"];
    if (em?.enabled === true && (!fromConfigured || !toConfigured || !transportReady)) {
      process.stderr.write(
        "conclave review: email integration enabled but missing from / to / RESEND_API_KEY — skipping\n",
      );
    } else if (fromConfigured && toConfigured && transportReady) {
      const opts: ConstructorParameters<typeof EmailNotifier>[0] = {};
      if (em?.from) opts.from = em.from;
      if (em?.to) opts.to = em.to;
      if (em?.subjectOverride) opts.subjectOverride = em.subjectOverride;
      try {
        notifiers.push(new EmailNotifier(opts));
      } catch (err) {
        process.stderr.write(`conclave review: Email notifier init failed — ${(err as Error).message}\n`);
      }
    }
  }
  if (notifiers.length > 0) {
    const notifyInput = {
      outcome,
      ctx: reviewCtx,
      episodicId: episodic.id,
      totalCostUsd: gate.metrics.summary().totalCostUsd,
      ...(loaded.pullNumber && loaded.source === "gh-pr"
        ? { prUrl: `https://github.com/${loaded.repo}/pull/${loaded.pullNumber}` }
        : {}),
    };
    await Promise.all(
      notifiers.map(async (n) => {
        try {
          await n.notifyReview(notifyInput);
        } catch (err) {
          process.stderr.write(`conclave review: ${n.id} notifier failed — ${(err as Error).message}\n`);
        }
      }),
    );
  }

  // 9. Optional visual diff (before/after preview screenshots). CLI flag
  //    overrides config. Failures are logged but never fail the review —
  //    code review verdict always wins.
  const visualFromConfig = config.visual?.enabled ?? false;
  const visualEnabled = args.noVisual ? false : args.visual || visualFromConfig;
  if (visualEnabled) {
    if (!loaded.prevSha) {
      process.stderr.write(
        "conclave review: --visual set but no base SHA available (pullNumber=0 or git diff had no base) — skipping\n",
      );
    } else {
      try {
        const platformIds: PlatformId[] =
          config.visual?.platforms ?? ["vercel", "netlify", "cloudflare", "deployment-status"];
        const { platforms, skipped } = await buildPlatforms(platformIds);
        for (const sk of skipped) {
          process.stderr.write(`conclave review: visual platform "${sk.id}" skipped — ${sk.reason}\n`);
        }
        if (platforms.length === 0) {
          process.stderr.write("conclave review: visual enabled but no platforms available — skipping\n");
        } else {
          const visualMod = await import("@ai-conclave/visual-review");
          const { runVisualReview } = visualMod;
          const visualInput: Parameters<typeof runVisualReview>[0] = {
            repo: loaded.repo,
            beforeSha: loaded.prevSha,
            afterSha: loaded.newSha,
            platforms,
            captureOptions: {
              width: config.visual?.width ?? 1280,
              height: config.visual?.height ?? 800,
              fullPage: config.visual?.fullPage ?? true,
            },
            diffOptions: { threshold: config.visual?.diffThreshold ?? 0.1 },
            waitSeconds: config.visual?.waitSeconds ?? 60,
          };
          // Vision judge (semantic "regression vs intentional") auto-runs
          // when ANTHROPIC_API_KEY is available. Uses Claude vision.
          if (process.env["ANTHROPIC_API_KEY"]) {
            visualInput.judge = new visualMod.ClaudeVisionJudge();
            visualInput.judgeContext = {
              codeReviewContext: {
                repo: loaded.repo,
                pullNumber: loaded.pullNumber,
                diff: loaded.diff,
              },
            };
          }
          const vResult = await runVisualReview(visualInput);
          process.stdout.write(
            `\n── visual review ──\n` +
              `  severity:   ${vResult.severity}\n` +
              `  diff ratio: ${(vResult.diff.diffRatio * 100).toFixed(2)}% ` +
              `(${vResult.diff.diffPixels.toLocaleString()} / ${vResult.diff.totalPixels.toLocaleString()} px)\n` +
              `  before url: ${vResult.before.url} (${vResult.before.provider})\n` +
              `  after url:  ${vResult.after.url} (${vResult.after.provider})\n` +
              `  paths:\n` +
              `    before:   ${vResult.paths.before}\n` +
              `    after:    ${vResult.paths.after}\n` +
              `    diff:     ${vResult.paths.diff}\n`,
          );
          if (vResult.judgment) {
            const j = vResult.judgment;
            process.stdout.write(
              `  judgment:   ${j.category} (conf ${(j.confidence * 100).toFixed(0)}%)\n` +
                `    ${j.summary}\n`,
            );
            if (j.concerns.length > 0) {
              process.stdout.write(`  concerns:\n`);
              for (const c of j.concerns) {
                process.stdout.write(`    [${c.severity.toUpperCase()}] (${c.kind}) ${c.message}\n`);
              }
            }
          }
        }
      } catch (err) {
        process.stderr.write(`conclave review: visual diff failed — ${(err as Error).message}\n`);
      }
    }
  }

  if (langfuseSink) {
    await langfuseSink.shutdown();
  }

  process.exit(verdictToExitCode(outcome.verdict));
}
