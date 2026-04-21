import path from "node:path";
import {
  BudgetTracker,
  Council,
  EfficiencyGate,
  FileSystemFederatedBaselineStore,
  FileSystemMemoryStore,
  InMemoryPlainSummaryCache,
  MetricsRecorder,
  OutcomeWriter,
  TieredCouncil,
  buildFrequencyMap,
  formatAnswerKeyForPrompt,
  formatFailureForPrompt,
  generatePlainSummary,
  type Agent,
  type MetricsSink,
  type PlainSummary,
  type PlainSummaryBlocker,
  type PlainSummaryLocale,
  type ReviewContext,
  type ReviewDomain,
  type TieredCouncilOutcome,
} from "@conclave-ai/core";
import { ClaudeAgent } from "@conclave-ai/agent-claude";
import { DesignAgent } from "@conclave-ai/agent-design";
import { OpenAIAgent } from "@conclave-ai/agent-openai";
import { GeminiAgent } from "@conclave-ai/agent-gemini";
import { OllamaAgent } from "@conclave-ai/agent-ollama";
import { GrokAgent } from "@conclave-ai/agent-grok";
import { LangfuseMetricsSink } from "@conclave-ai/observability-langfuse";
import { TelegramNotifier } from "@conclave-ai/integration-telegram";
import { DiscordNotifier } from "@conclave-ai/integration-discord";
import { SlackNotifier } from "@conclave-ai/integration-slack";
import { EmailNotifier } from "@conclave-ai/integration-email";
import type { Notifier } from "@conclave-ai/core";
import { fetchDeployStatus } from "@conclave-ai/scm-github";
import { loadConfig, resolveMemoryRoot } from "../lib/config.js";
import { loadProjectContext, loadDesignContext } from "../lib/project-context.js";
import { loadPrDiff, loadGitDiff, loadFileDiff, type LoadedDiff } from "../lib/diff-source.js";
import { renderPlainSummarySection, renderReview, verdictToExitCode } from "../lib/output.js";
import { buildPlatforms, type PlatformId } from "../lib/platform-factory.js";
import {
  detectDomain,
  extractChangedFilesFromDiff,
  type DomainDetectionResult,
} from "../lib/domain-detect.js";
import { ClaudeHaikuPlainSummaryLlm } from "../lib/plain-summary-llm.js";
import { resolveTierIds } from "../lib/tier-resolver.js";

type ReviewDomainInput = "code" | "design";
interface ReviewArgs {
  pr?: number;
  diff?: string;
  base?: string;
  visual: boolean;
  noVisual: boolean;
  help: boolean;
  domain?: ReviewDomainInput;
  noPlainSummary: boolean;
  plainSummaryOnly: boolean;
  plainSummaryLocale?: PlainSummaryLocale;
}
function parseArgv(argv: string[]): ReviewArgs {
  const out: ReviewArgs = {
    help: false,
    visual: false,
    noVisual: false,
    noPlainSummary: false,
    plainSummaryOnly: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--visual") out.visual = true;
    else if (a === "--no-visual") out.noVisual = true;
    else if (a === "--no-plain-summary") out.noPlainSummary = true;
    else if (a === "--plain-summary-only") out.plainSummaryOnly = true;
    else if (a === "--plain-summary-locale" && argv[i + 1]) {
      const v = argv[i + 1];
      if (v === "en" || v === "ko") out.plainSummaryLocale = v;
      i += 1;
    } else if (a === "--pr" && argv[i + 1]) {
      const n = Number.parseInt(argv[i + 1]!, 10);
      if (!Number.isNaN(n)) out.pr = n;
      i += 1;
    } else if (a === "--diff" && argv[i + 1]) {
      out.diff = argv[i + 1];
      i += 1;
    } else if (a === "--base" && argv[i + 1]) {
      out.base = argv[i + 1];
      i += 1;
    } else if (a === "--domain" && argv[i + 1]) {
      const d = argv[i + 1];
      if (d === "code" || d === "design") out.domain = d;
      i += 1;
    }
  }
  return out;
}

const HELP = `conclave review — run a council review on the current branch

Usage:
  conclave review [--pr N] [--diff <file>] [--base <ref>] [--visual|--no-visual] [--domain code|design]

Options:
  --pr N         Review PR N using gh CLI (preferred — includes repo context).
  --diff <file>  Review a unified-diff file directly.
  --base <ref>   Base ref for 'git diff' when neither --pr nor --diff given (default: origin/main).
  --domain       "code" or "design" — explicit override. Omit to let Conclave
                 auto-detect from the diff (v0.5.3+). UI-signal files flip the
                 run to "mixed" (code agents + Design agent).
  --visual       Force-enable before/after visual diff (needs platform tokens + playwright).
  --no-visual    Force-disable visual diff for this run (overrides .conclaverc.json).
  --no-plain-summary  Disable the plain-language (non-dev) summary for this run.
  --plain-summary-locale <en|ko>  Override the summary locale (default from .conclaverc.json).
  --plain-summary-only  Post ONLY the plain summary to the PR comment, skip the technical block.

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
  // v0.6.4 — load project + design context from the repo root (configDir
  // is the directory holding .conclaverc.json; it's where users drop
  // `.conclave/project-context.md` etc.). Silent-skip when absent.
  const ctxCfg = config.context;
  const projectCtxLoaded = await loadProjectContext(configDir, {
    ...(ctxCfg?.readmeMaxChars ? { readmeMaxChars: ctxCfg.readmeMaxChars } : {}),
  });

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

  // 2. Retrieve RAG context from memory (+ federated frequency rerank if available)
  const store = new FileSystemMemoryStore({ root: memoryRoot });
  const queryText = `${loaded.repo} ${loaded.diff.slice(0, 4_000)}`;
  let federatedFrequency: ReadonlyMap<string, number> | undefined;
  if (config.federated?.enabled) {
    const baselineStore = new FileSystemFederatedBaselineStore({
      root: path.join(memoryRoot, "federated"),
    });
    const cached = await baselineStore.read();
    if (cached.length > 0) federatedFrequency = buildFrequencyMap(cached);
  }
  const retrieval = await store.retrieve({
    query: queryText,
    repo: loaded.repo,
    k: 8,
    ...(federatedFrequency ? { federatedFrequency } : {}),
  });

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

  // 4. Resolve the review domain.
  //    - Explicit `--domain code|design` always wins (Level-3 override,
  //      mirrors pre-v0.5.3 behavior).
  //    - Otherwise, when `autoDetect.enabled` (default true), inspect
  //      the diff's changed-file list. Any UI-signal hit flips the run
  //      into "mixed" mode — code agents + Design agent together.
  //    - When `autoDetect.enabled: false` and no `--domain`, fall back
  //      to "code" (legacy v0.5.2 default).
  const autoDetectCfg = config.autoDetect ?? { enabled: true };
  let resolvedDomain: "code" | "design" | "mixed";
  let detection: DomainDetectionResult | null = null;
  if (args.domain) {
    resolvedDomain = args.domain;
    process.stdout.write(
      `conclave review: domain: ${resolvedDomain} (explicit --domain)\n`,
    );
  } else if (autoDetectCfg.enabled === false) {
    resolvedDomain = "code";
    process.stdout.write(
      `conclave review: domain: code (autoDetect disabled)\n`,
    );
  } else {
    const changed = extractChangedFilesFromDiff(loaded.diff);
    const detectOpts: Parameters<typeof detectDomain>[1] = {};
    if (autoDetectCfg.uiSignals) detectOpts.uiSignals = autoDetectCfg.uiSignals;
    if (autoDetectCfg.excludes) detectOpts.excludes = autoDetectCfg.excludes;
    detection = detectDomain(changed, detectOpts);
    resolvedDomain = detection.domain;
    process.stdout.write(
      `conclave review: auto-detected domain: ${detection.domain} (reason: ${detection.reason})\n`,
    );
  }

  // The core `ReviewDomain` is "code" | "design" — "mixed" is a
  // CLI-layer concept. When mixed, send "design" to the context so
  // DesignAgent's branch logic (and any design-tuned config in
  // `domains.design.*`) lights up; code agents ignore the label.
  const ctxDomain: ReviewDomain = resolvedDomain === "code" ? "code" : "design";

  // For tier-build we may need the "code" domain config (mixed pulls
  // from BOTH). For non-mixed, fall through to the standard path.
  const codeDomainCfg = config.council.domains?.["code"];
  const designDomainCfg = config.council.domains?.["design"];
  const domainConfig =
    resolvedDomain === "code"
      ? codeDomainCfg
      : resolvedDomain === "design"
        ? designDomainCfg
        : (codeDomainCfg ?? designDomainCfg);
  const useTiered = Boolean(domainConfig);

  function buildAgent(id: string, modelOverride?: string): Agent | null {
    const modelOpt = modelOverride ? { model: modelOverride } : {};
    if (id === "claude") {
      if (!process.env["ANTHROPIC_API_KEY"]) return null;
      return new ClaudeAgent({ gate, ...modelOpt });
    }
    if (id === "design") {
      if (!process.env["ANTHROPIC_API_KEY"]) {
        process.stderr.write("conclave review: ANTHROPIC_API_KEY not set — skipping Design agent\n");
        return null;
      }
      return new DesignAgent({ gate, ...modelOpt });
    }
    if (id === "openai") {
      if (!process.env["OPENAI_API_KEY"]) {
        process.stderr.write("conclave review: OPENAI_API_KEY not set — skipping OpenAI agent\n");
        return null;
      }
      return new OpenAIAgent({ gate, ...modelOpt });
    }
    if (id === "gemini") {
      const hasKey = !!(process.env["GOOGLE_API_KEY"] || process.env["GEMINI_API_KEY"]);
      if (!hasKey) {
        process.stderr.write("conclave review: GOOGLE_API_KEY / GEMINI_API_KEY not set — skipping Gemini agent\n");
        return null;
      }
      return new GeminiAgent({ gate, ...modelOpt });
    }
    if (id === "ollama") {
      // Ollama has no API key; we assume the daemon is running at
      // OLLAMA_BASE_URL (default http://localhost:11434/v1).
      return new OllamaAgent({ gate, ...modelOpt });
    }
    if (id === "grok") {
      if (!process.env["XAI_API_KEY"]) {
        process.stderr.write("conclave review: XAI_API_KEY not set — skipping Grok agent\n");
        return null;
      }
      return new GrokAgent({ gate, ...modelOpt });
    }
    return null;
  }

  type CouncilLike = {
    deliberate: (ctx: ReviewContext) => Promise<TieredCouncilOutcome | Awaited<ReturnType<Council["deliberate"]>>>;
  };
  let council: CouncilLike;

  if (useTiered && domainConfig) {
    // For "mixed" runs, union tier-1 / tier-2 across code + design
    // domain configs (deduped, preserving order: code first, then any
    // design-only additions) and auto-inject "design" if a stale config
    // left it out. See `lib/tier-resolver.ts` for the full rule — it's
    // kept pure + exported so the merge logic is unit-testable.
    const resolved = resolveTierIds({
      resolvedDomain,
      codeDomainCfg,
      designDomainCfg,
    });
    const tier1Ids = [...resolved.tier1Ids];
    const tier2Ids = [...resolved.tier2Ids];
    const tier1Models = resolved.tier1Models;
    const tier2Models = resolved.tier2Models;
    const tier1: Agent[] = [];
    for (const id of tier1Ids) {
      const a = buildAgent(id, tier1Models[id]);
      if (a) tier1.push(a);
    }
    const tier2: Agent[] = [];
    for (const id of tier2Ids) {
      const a = buildAgent(id, tier2Models[id]);
      if (a) tier2.push(a);
    }
    // v0.6.2 diagnostic — surface the resolved tier-1 (and, when
    // relevant, tier-2) agent list BEFORE council runs so users can
    // immediately see whether e.g. the Design agent made it in after
    // a mixed-domain auto-detect. Prints the actually-built agent ids
    // (credential-skipped agents don't show up), matching what the
    // council will deliberate with.
    const tier1IdLog = tier1.map((a) => a.id).join(", ");
    process.stdout.write(`conclave review: tier-1 agents: [${tier1IdLog}]\n`);
    if (tier2.length > 0) {
      const tier2IdLog = tier2.map((a) => a.id).join(", ");
      process.stdout.write(`conclave review: tier-2 agents: [${tier2IdLog}]\n`);
    }
    if (tier1.length === 0) {
      process.stderr.write(
        `conclave review: no tier-1 agents available for domain "${resolvedDomain}". Set at least one agent's API key.\n`,
      );
      process.exit(1);
      return;
    }
    // Mixed always escalates (design always-escalates per decision #26;
    // code portion benefits from tier-2 cross-review anyway).
    const alwaysEscalate =
      resolvedDomain === "mixed"
        ? (designDomainCfg?.alwaysEscalate ?? domainConfig.alwaysEscalate ?? true)
        : domainConfig.alwaysEscalate;
    const tier1MaxRounds =
      resolvedDomain === "mixed"
        ? (designDomainCfg?.tier1MaxRounds ?? domainConfig.tier1MaxRounds)
        : domainConfig.tier1MaxRounds;
    const tier2MaxRounds =
      resolvedDomain === "mixed"
        ? (designDomainCfg?.tier2MaxRounds ?? domainConfig.tier2MaxRounds)
        : domainConfig.tier2MaxRounds;
    council = new TieredCouncil({
      tier1Agents: tier1,
      tier2Agents: tier2,
      tier1MaxRounds,
      tier2MaxRounds,
      alwaysEscalate,
    });
  } else {
    // Legacy flat-Council path — used when config.council.domains is absent.
    const flatAgents: Agent[] = [];
    for (const id of config.agents) {
      const a = buildAgent(id);
      if (a) flatAgents.push(a);
    }
    if (flatAgents.length === 0) {
      process.stderr.write("conclave review: no agents available. Set at least ANTHROPIC_API_KEY.\n");
      process.exit(1);
      return;
    }
    council = new Council({
      agents: flatAgents,
      maxRounds: config.council.maxRounds,
      enableDebate: config.council.enableDebate,
    });
  }

  // 5. Deliberate — first read deploy status from GH check-suites so
  //    agents can factor it in. Failure here never blocks review; we
  //    fall back to `unknown` per fetchDeployStatus's default.
  const deployStatus = loaded.source === "gh-pr"
    ? await fetchDeployStatus(loaded.repo, loaded.newSha).catch(() => "unknown" as const)
    : ("unknown" as const);
  if (deployStatus !== "unknown") {
    process.stdout.write(`  deploy: ${deployStatus}\n`);
  }
  // v0.6.4 — design-context + brand reference PNGs load only when the
  // resolved domain is design or mixed. Code-only runs skip the design
  // load entirely (avoids an unused disk scan on non-UI PRs).
  const designCtxLoaded =
    resolvedDomain === "design" || resolvedDomain === "mixed"
      ? await loadDesignContext(configDir, {
          ...(ctxCfg?.maxDesignReferences !== undefined
            ? { maxReferences: ctxCfg.maxDesignReferences }
            : {}),
          ...(ctxCfg?.maxDesignImageBytes !== undefined
            ? { maxImageBytes: ctxCfg.maxDesignImageBytes }
            : {}),
        })
      : {};

  const reviewCtx: ReviewContext = {
    diff: loaded.diff,
    repo: loaded.repo,
    pullNumber: loaded.pullNumber,
    newSha: loaded.newSha,
    answerKeys: retrieval.answerKeys.map(formatAnswerKeyForPrompt),
    failureCatalog: retrieval.failures.map(formatFailureForPrompt),
    domain: ctxDomain,
    deployStatus,
  };
  if (loaded.prevSha) reviewCtx.prevSha = loaded.prevSha;
  if (projectCtxLoaded.projectContext) {
    reviewCtx.projectContext = projectCtxLoaded.projectContext;
  }
  if (designCtxLoaded.designContext) {
    reviewCtx.designContext = designCtxLoaded.designContext;
  }
  // includeDesignReferences defaults to true; honor it when present.
  if (
    designCtxLoaded.designReferences &&
    designCtxLoaded.designReferences.length > 0 &&
    (ctxCfg?.includeDesignReferences ?? true)
  ) {
    reviewCtx.designReferences = designCtxLoaded.designReferences;
  }

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
  const tieredOutcome =
    useTiered && "tier1Outcome" in outcome
      ? (outcome as TieredCouncilOutcome)
      : null;
  const renderInput: Parameters<typeof renderReview>[0] = {
    repo: loaded.repo,
    pullNumber: loaded.pullNumber,
    sha: loaded.newSha,
    source: loaded.source,
    councilVerdict: outcome.verdict,
    consensus: outcome.consensusReached,
    results: outcome.results,
    metrics: gate.metrics.summary(),
    rounds: outcome.rounds,
    domain: resolvedDomain,
    ...(outcome.earlyExit !== undefined ? { earlyExit: outcome.earlyExit } : {}),
  };
  if (tieredOutcome) {
    renderInput.tier = {
      escalated: tieredOutcome.escalated,
      reason: tieredOutcome.escalationReason,
      tier1Rounds: tieredOutcome.tier1Outcome.rounds,
      ...(tieredOutcome.tier2Outcome ? { tier2Rounds: tieredOutcome.tier2Outcome.rounds } : {}),
    };
  }

  // 7a. v0.6.1 — plain-language summary for non-dev stakeholders. One
  //     cheap LLM call (claude-haiku-4-5). Disabled by --no-plain-summary
  //     or `output.plainSummary.enabled: false` in config. Failures here
  //     never kill the review; we fall back to the original output.
  const plainCfg = config.output?.plainSummary;
  const plainEnabled =
    !args.noPlainSummary &&
    (plainCfg === undefined ? true : plainCfg.enabled);
  let plainSummary: PlainSummary | undefined;
  if (plainEnabled) {
    try {
      const locale: PlainSummaryLocale =
        args.plainSummaryLocale ?? plainCfg?.locale ?? "en";
      const deliveries = plainCfg?.deliveries ?? ["telegram", "pr-comment"];
      const blockers: PlainSummaryBlocker[] = [];
      const seen = new Set<string>();
      for (const r of outcome.results) {
        for (const b of r.blockers) {
          // Drop nit-level: non-devs don't need typo comments surfaced.
          if (b.severity === "nit") continue;
          const sev: "major" | "minor" = b.severity === "blocker" || b.severity === "major" ? "major" : "minor";
          const key = `${sev}|${b.category}|${b.file ?? ""}|${b.message.slice(0, 60)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const pb: PlainSummaryBlocker = {
            severity: sev,
            category: b.category,
            oneLine: b.message.replace(/\n+/g, " ").slice(0, 220),
          };
          if (b.file) pb.file = b.file;
          blockers.push(pb);
        }
      }
      const diffStats = summarizeDiff(loaded.diff);
      const subject: Parameters<typeof generatePlainSummary>[0]["subject"] = { repo: loaded.repo };
      if (loaded.pullNumber) subject.prNumber = loaded.pullNumber;
      if (loaded.newSha) subject.sha = loaded.newSha;
      const prUrl =
        loaded.pullNumber && loaded.source === "gh-pr"
          ? `https://github.com/${loaded.repo}/pull/${loaded.pullNumber}`
          : undefined;
      plainSummary = await generatePlainSummary(
        {
          mode: "review",
          verdict: outcome.verdict,
          subject,
          changes: diffStats,
          blockers,
          locale,
        },
        {
          llm: new ClaudeHaikuPlainSummaryLlm(),
          cache: new InMemoryPlainSummaryCache(),
          ...(prUrl ? { fullReportUrl: prUrl } : {}),
        },
      );
      // Emit for telemetry visibility in stderr — keeps stdout (which the
      // workflow greps for the PR comment) clean unless --plain-summary-only.
      process.stderr.write(
        `conclave review: plain summary ready (${locale}, ${deliveries.join("+")})\n`,
      );
    } catch (err) {
      process.stderr.write(
        `conclave review: plain summary generation failed — ${(err as Error).message}\n`,
      );
      plainSummary = undefined;
    }
  }

  // Decide what goes to stdout (which the wrapper workflow pipes into the
  // PR comment): technical block (+ plain appended), or plain only.
  const deliveries = plainCfg?.deliveries ?? ["telegram", "pr-comment"];
  const appendPlainToPr = plainEnabled && !args.noPlainSummary && deliveries.includes("pr-comment");
  if (args.plainSummaryOnly && plainSummary) {
    process.stdout.write(
      `conclave review — ${loaded.repo}${loaded.pullNumber ? ` #${loaded.pullNumber}` : ""}\n`,
    );
    process.stdout.write(`  sha: ${loaded.newSha.slice(0, 12)}\n\n`);
    process.stdout.write(renderPlainSummarySection(plainSummary));
  } else {
    process.stdout.write(renderReview(renderInput));
    if (plainSummary && appendPlainToPr) {
      process.stdout.write(renderPlainSummarySection(plainSummary));
    }
  }
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
    // v0.4.4 — dual-path: CONCLAVE_TOKEN routes through the central plane
    // (no per-repo bot token needed). Direct-bot path still works when
    // CONCLAVE_TOKEN is absent (self-hosted / v0.3-style installs).
    //
    // v0.6.3: trim before deciding so a whitespace-only secret expansion
    // from a consumer-repo workflow is treated as absent (matches the
    // trim in TelegramNotifier's constructor).
    const hasConclaveToken = (process.env["CONCLAVE_TOKEN"] ?? "").trim().length > 0;
    const hasToken = !!process.env["TELEGRAM_BOT_TOKEN"];
    const hasChat = tg?.chatId !== undefined || !!process.env["TELEGRAM_CHAT_ID"];
    if (hasConclaveToken) {
      const opts: ConstructorParameters<typeof TelegramNotifier>[0] = {};
      if (tg?.includeActionButtons !== undefined) opts.includeActionButtons = tg.includeActionButtons;
      try {
        notifiers.push(new TelegramNotifier(opts));
      } catch (err) {
        process.stderr.write(
          `conclave review: Telegram notifier (central) init failed — ${(err as Error).message}\n`,
        );
      }
    } else if (tg?.enabled === true && !hasToken) {
      process.stderr.write(
        "conclave review: neither CONCLAVE_TOKEN nor TELEGRAM_BOT_TOKEN set — skipping Telegram notifier\n",
      );
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
    // Only pass plainSummary to notifiers if the "telegram" delivery is
    // enabled for plain summary (Telegram is our primary non-dev surface).
    const telegramDelivery = plainEnabled && deliveries.includes("telegram") && plainSummary;
    const notifyInput = {
      outcome,
      ctx: reviewCtx,
      episodicId: episodic.id,
      totalCostUsd: gate.metrics.summary().totalCostUsd,
      ...(loaded.pullNumber && loaded.source === "gh-pr"
        ? { prUrl: `https://github.com/${loaded.repo}/pull/${loaded.pullNumber}` }
        : {}),
      ...(telegramDelivery ? { plainSummary } : {}),
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
          config.visual?.platforms ?? ["vercel", "netlify", "cloudflare", "railway", "render", "deployment-status"];
        const { platforms, skipped } = await buildPlatforms(platformIds);
        for (const sk of skipped) {
          process.stderr.write(`conclave review: visual platform "${sk.id}" skipped — ${sk.reason}\n`);
        }
        if (platforms.length === 0) {
          process.stderr.write("conclave review: visual enabled but no platforms available — skipping\n");
        } else {
          const visualMod = await import("@conclave-ai/visual-review");
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

/**
 * Lightweight diff parser for the plain-summary changes block. Walks the
 * unified-diff text once, counting `+` / `-` lines (excluding headers)
 * and collecting unique file paths sorted by total churn. We want rough
 * numbers for the prose — do not use this for anything security-critical.
 */
export function summarizeDiff(diff: string): {
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  topFiles: string[];
} {
  const perFile = new Map<string, { added: number; removed: number }>();
  let currentFile: string | null = null;
  let linesAdded = 0;
  let linesRemoved = 0;
  const lines = diff.split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice("+++ b/".length).trim();
      if (currentFile === "/dev/null") currentFile = null;
      else if (!perFile.has(currentFile)) perFile.set(currentFile, { added: 0, removed: 0 });
      continue;
    }
    if (line.startsWith("--- a/")) continue;
    if (line.startsWith("diff --git ") || line.startsWith("index ") || line.startsWith("@@ ")) continue;
    if (!currentFile) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      linesAdded += 1;
      perFile.get(currentFile)!.added += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      linesRemoved += 1;
      perFile.get(currentFile)!.removed += 1;
    }
  }
  const topFiles = [...perFile.entries()]
    .sort((a, b) => b[1].added + b[1].removed - (a[1].added + a[1].removed))
    .slice(0, 5)
    .map(([f]) => f);
  return {
    filesChanged: perFile.size,
    linesAdded,
    linesRemoved,
    topFiles,
  };
}
