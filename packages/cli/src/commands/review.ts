import path from "node:path";
import {
  BudgetTracker,
  Council,
  EfficiencyGate,
  FileSystemCalibrationStore,
  FileSystemFederatedBaselineStore,
  FileSystemMemoryStore,
  InMemoryPlainSummaryCache,
  MetricsRecorder,
  OutcomeWriter,
  TieredCouncil,
  applyFailureGate,
  buildFrequencyMap,
  computeAllAgentScores,
  deriveAgentWeights,
  formatAnswerKeyForPrompt,
  formatFailureForPrompt,
  generatePlainSummary,
  integrateChunkOutcomes,
  newEpisodicId,
  splitDiff,
  type CouncilOutcome,
  type FailureGateResult,
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
import type { Notifier } from "@conclave-ai/core";
import { buildNotifiers } from "../lib/notifier-factory.js";
import { emitProgress } from "../lib/progress-emit.js";
import { pushEpisodicAnchor } from "../lib/episodic-anchor.js";
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
import { buildReviewJson, serializeReviewJson } from "../lib/review-json-output.js";
import { resolveKey } from "../lib/credentials.js";
import { runVisualCapture, type VisualCaptureResult } from "../lib/visual-capture.js";
import { matchBaselinesToArtifacts, saveDesignBaseline } from "../lib/design-baseline.js";
import { findPriorEpisodicId } from "../lib/episodic-chain.js";
import type { ViewportSpec } from "@conclave-ai/visual-review";

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
  /** v0.13.2 — suppress all notifyReview + notifyProgress emissions.
   * Used by `conclave autofix`'s spawned `conclave review --json` so
   * the autofix-internal verdict fetch doesn't push a duplicate
   * verdict message to Telegram (the upstream review already
   * notified). Affects: Telegram, Discord, Slack, Email. */
  noNotify: boolean;
  plainSummaryLocale?: PlainSummaryLocale;
  /** v0.7.1 — structured JSON output on stdout (for autofix + downstream tools). */
  json: boolean;
  /**
   * v0.8 — autonomous pipeline. `--rework-cycle N` advertises the current
   * cycle to the notifier. The GitHub workflow extracts N from the
   * HEAD commit's `[conclave-rework-cycle:N]` marker (rework commits
   * carry it) or defaults to 0 on human-authored commits.
   */
  reworkCycle?: number;
  /** v0.8 — override the configured `autonomy.maxReworkCycles`. */
  maxReworkCycles?: number;
  /** v0.9.0 — comma-separated route overrides for multi-modal capture. */
  visualRoutes?: string[];
  /** v0.9.0 — bypass the deploy-status=success gate (local dev). */
  skipDeployWait: boolean;
  /**
   * v0.13.22 — after visual capture, save the "after" screenshots as the
   * new design system baseline in `.conclave/design/baseline/`. The review
   * still runs normally; this just also records the result as the new
   * golden reference for future baseline-drift comparisons.
   */
  captureBaseline: boolean;
}
export function parseArgv(argv: string[]): ReviewArgs {
  const out: ReviewArgs = {
    help: false,
    visual: false,
    noVisual: false,
    noPlainSummary: false,
    plainSummaryOnly: false,
    json: false,
    skipDeployWait: false,
    noNotify: false,
    captureBaseline: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--visual") out.visual = true;
    else if (a === "--no-visual") out.noVisual = true;
    else if (a === "--capture-baseline") out.captureBaseline = true;
    else if (a === "--no-plain-summary") out.noPlainSummary = true;
    else if (a === "--plain-summary-only") out.plainSummaryOnly = true;
    else if (a === "--json") out.json = true;
    else if (a === "--skip-deploy-wait") out.skipDeployWait = true;
    else if (a === "--no-notify") out.noNotify = true;
    else if (a === "--visual-routes" && argv[i + 1]) {
      out.visualRoutes = argv[i + 1]!
        .split(",")
        .map((r) => r.trim())
        .filter((r) => r.length > 0);
      i += 1;
    } else if (a === "--plain-summary-locale" && argv[i + 1]) {
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
    } else if (a === "--rework-cycle" && argv[i + 1]) {
      const n = Number.parseInt(argv[i + 1]!, 10);
      if (!Number.isNaN(n) && n >= 0) out.reworkCycle = n;
      i += 1;
    } else if (a === "--max-rework-cycles" && argv[i + 1]) {
      const n = Number.parseInt(argv[i + 1]!, 10);
      if (!Number.isNaN(n) && n >= 0) out.maxReworkCycles = n;
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
  --visual       Force-enable multi-modal visual review (needs platform tokens + playwright).
  --no-visual    Force-disable visual diff + capture for this run (overrides config).
  --visual-routes <list>  v0.9.0 — comma-separated route overrides for multi-modal capture
                 (e.g. "/,/login,/dashboard"). Bypasses auto-detection.
  --skip-deploy-wait  v0.9.0 — capture screenshots even if deploy-status isn't "success".
                 Useful during local dev when no deploy system is wired up.
  --capture-baseline  v0.13.22 — after visual capture, save the "after" screenshots as
                 the new design system baseline in .conclave/design/baseline/. The
                 review still runs normally. Use on a known-good PR to establish
                 the golden reference for future baseline-drift comparisons.
  --no-plain-summary  Disable the plain-language (non-dev) summary for this run.
  --plain-summary-locale <en|ko>  Override the summary locale (default from .conclaverc.json).
  --plain-summary-only  Post ONLY the plain summary to the PR comment, skip the technical block.
  --json         v0.7.1 — emit a single structured JSON object to stdout instead
                 of the ANSI-colored human block. Exit code is preserved
                 (0 approve / 1 rework / 2 reject). Use this to pipe into
                 'conclave autofix --verdict -' or downstream tools.
  --rework-cycle N  v0.8 — advertise the current auto-rework cycle to the
                 notifier. Used by the autonomous pipeline to decide
                 whether to fire the next rework (cycle < max) or show
                 the manual-review keyboard (cycle == max). Default 0.
                 The GitHub workflow extracts this from the HEAD commit's
                 [conclave-rework-cycle:N] marker automatically.
  --max-rework-cycles N  v0.8 — override the config autonomy.maxReworkCycles
                 for this run. Clamped to a hard ceiling of 5.

Environment:
  ANTHROPIC_API_KEY   required — Claude review call.

Visual review reads platform tokens from env: VERCEL_TOKEN, NETLIFY_TOKEN,
CLOUDFLARE_API_TOKEN + account/project, or falls back to gh CLI via the
deployment-status adapter.

v0.9.0 multi-modal: when --visual is on and the resolved domain is "design" or
"mixed", Conclave captures one Playwright screenshot per (route × viewport)
against BOTH the base and head SHA previews, then feeds the before/after pairs
to DesignAgent's Mode A (vision) for visual-quality judgment — logo slop,
brand drift, layout regressions the text-only reviewers can't catch.
`;

export async function review(argv: string[]): Promise<void> {
  const args = parseArgv(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  // v0.7.1 — when --json, route all informational/diagnostic stdout writes
  // to stderr so stdout stays reserved for the single JSON payload. stderr
  // still carries the tier agent list, deploy status, etc.
  const infoOut: (s: string) => void = args.json
    ? (s) => process.stderr.write(s)
    : (s) => process.stdout.write(s);
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
    infoOut(
      `conclave review: domain: ${resolvedDomain} (explicit --domain)\n`,
    );
  } else if (autoDetectCfg.enabled === false) {
    resolvedDomain = "code";
    infoOut(
      `conclave review: domain: code (autoDetect disabled)\n`,
    );
  } else {
    const changed = extractChangedFilesFromDiff(loaded.diff);
    const detectOpts: Parameters<typeof detectDomain>[1] = {};
    if (autoDetectCfg.uiSignals) detectOpts.uiSignals = autoDetectCfg.uiSignals;
    if (autoDetectCfg.excludes) detectOpts.excludes = autoDetectCfg.excludes;
    detection = detectDomain(changed, detectOpts);
    resolvedDomain = detection.domain;
    infoOut(
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
    // v0.7.4 — credentials resolve from env FIRST, then the stored file
    // (~/.config/conclave/credentials.json). One-time `conclave config`
    // populates storage; subsequent runs + subprocess spawns pick it up
    // without the parent shell setting any env var.
    if (id === "claude") {
      const key = resolveKey("anthropic");
      if (!key) return null;
      return new ClaudeAgent({ apiKey: key, gate, ...modelOpt });
    }
    if (id === "design") {
      const key = resolveKey("anthropic");
      if (!key) {
        process.stderr.write("conclave review: anthropic key not set (env or `conclave config`) — skipping Design agent\n");
        return null;
      }
      return new DesignAgent({ apiKey: key, gate, ...modelOpt });
    }
    if (id === "openai") {
      const key = resolveKey("openai");
      if (!key) {
        process.stderr.write("conclave review: openai key not set (env or `conclave config`) — skipping OpenAI agent\n");
        return null;
      }
      return new OpenAIAgent({ apiKey: key, gate, ...modelOpt });
    }
    if (id === "gemini") {
      const key = resolveKey("gemini");
      if (!key) {
        process.stderr.write("conclave review: gemini key not set (env or `conclave config`) — skipping Gemini agent\n");
        return null;
      }
      return new GeminiAgent({ apiKey: key, gate, ...modelOpt });
    }
    if (id === "ollama") {
      // Ollama has no API key; we assume the daemon is running at
      // OLLAMA_BASE_URL (default http://localhost:11434/v1).
      return new OllamaAgent({ gate, ...modelOpt });
    }
    if (id === "grok") {
      const key = resolveKey("xai");
      if (!key) {
        process.stderr.write("conclave review: xai key not set (env or `conclave config`) — skipping Grok agent\n");
        return null;
      }
      return new GrokAgent({ apiKey: key, gate, ...modelOpt });
    }
    return null;
  }

  // H2 #10 — derive agent weights from past episodic outcomes. Weights
  // soften the "any reject blocks" rule for low-trust agents (score < 0.5
  // → can't single-handedly reject, demoted to rework). Brand-new agents
  // (< 5 samples) keep full weight by default. Best-effort: a calibration
  // failure here NEVER kills the review — fall back to flat weights.
  const agentScoringEnabled = config.council?.agentScoreRouting !== false;
  let agentWeights: Map<string, number> | undefined;
  if (agentScoringEnabled) {
    try {
      const scores = await computeAllAgentScores(store);
      agentWeights = deriveAgentWeights(scores);
      const weighted = [...agentWeights.entries()]
        .filter(([, w]) => w < 1.0)
        .map(([a, w]) => `${a}=${w.toFixed(2)}`);
      if (weighted.length > 0) {
        infoOut(`conclave review: agent score weights — ${weighted.join(", ")}\n`);
      }
    } catch (err) {
      process.stderr.write(
        `conclave review: agent-score routing skipped — ${(err as Error).message}\n`,
      );
    }
  }

  type CouncilLike = {
    deliberate: (ctx: ReviewContext) => Promise<TieredCouncilOutcome | Awaited<ReturnType<Council["deliberate"]>>>;
  };
  let council: CouncilLike;
  // v0.7.1 — resolved tier ids captured for the --json emitter. Plain
  // Council runs leave these empty (json path uses `results` length
  // instead for tier1Count).
  let tier1IdsResolved: string[] = [];
  let tier2IdsResolved: string[] = [];

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
    infoOut(`conclave review: tier-1 agents: [${tier1IdLog}]\n`);
    if (tier2.length > 0) {
      const tier2IdLog = tier2.map((a) => a.id).join(", ");
      infoOut(`conclave review: tier-2 agents: [${tier2IdLog}]\n`);
    }
    // Cache the resolved tier id lists so the --json emitter below has
    // access (pure outcome object doesn't carry this — the agents field
    // is per-deliberation, whereas tierNIds is the *config*'d roster).
    tier1IdsResolved = tier1.map((a) => a.id);
    tier2IdsResolved = tier2.map((a) => a.id);
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
      ...(agentWeights ? { agentWeights } : {}),
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
      ...(agentWeights ? { agentWeights } : {}),
    });
  }

  // 5. Deliberate — first read deploy status from GH check-suites so
  //    agents can factor it in. Failure here never blocks review; we
  //    fall back to `unknown` per fetchDeployStatus's default.
  const deployStatus = loaded.source === "gh-pr"
    ? await fetchDeployStatus(loaded.repo, loaded.newSha).catch(() => "unknown" as const)
    : ("unknown" as const);
  if (deployStatus !== "unknown") {
    infoOut(`  deploy: ${deployStatus}\n`);
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

  // 4a. v0.11 — pre-generate the episodic id so progress streaming has a
  //     stable anchor BEFORE deliberation starts. The same id is later
  //     handed to OutcomeWriter.writeReview so the persisted episodic
  //     entry shares the id with the Telegram timeline message.
  const episodicId = newEpisodicId();

  // 4a-bis. v0.11 — build notifiers up-front so notifyProgress can fire
  //     during phase boundaries (visual capture, deliberation). The same
  //     instances are reused for the final notifyReview call below.
  // v0.13.2 — `--no-notify` produces an empty array so emitProgress
  //     and the final notifyReview both no-op. Used by autofix's
  //     spawned review to avoid double-notifying the same verdict.
  const notifiers: Notifier[] = args.noNotify ? [] : buildNotifiers(config);

  // v0.11 — review-started progress stage. Fires before any work that
  // a user would notice (visual capture, deliberation). Carries the
  // tier-1 + tier-2 agent ids resolved earlier so the user can see at
  // a glance which council is about to run.
  await emitProgress(notifiers, {
    episodicId,
    stage: "review-started",
    payload: {
      repo: loaded.repo,
      ...(loaded.pullNumber ? { pullNumber: loaded.pullNumber } : {}),
      agentIds:
        tier1IdsResolved.length > 0
          ? [...tier1IdsResolved, ...tier2IdsResolved.filter((id) => !tier1IdsResolved.includes(id))]
          : config.agents,
    },
  });

  // 4b. v0.9.0 — multi-modal visual capture. Runs BEFORE the council so
  //     DesignAgent's Mode A (vision) gets real screenshots. Only when:
  //       (a) domain is design or mixed (text-only code PRs skip entirely)
  //       (b) --visual or config visual.enabled
  //       (c) deploy-status=success (unless --skip-deploy-wait)
  //       (d) we have a base SHA to compare against (prevSha)
  //     Failures here NEVER kill the review — DesignAgent falls back to
  //     Mode B (text-UI) when artifacts are empty. Cost: only paid when
  //     visual is explicitly opted in; vision calls ~4x text cost.
  // v0.13 — visual review zero-config. Old default (v0.9-v0.12):
  //   args.noVisual ? false : args.visual || (config.visual.enabled ?? false)
  // Pre-v0.13 the user had to either pass --visual or flip
  // `visual.enabled: true` in config to get screenshot-aware design
  // review on UI PRs. v0.13 flips the default: when the auto-detected
  // domain is design or mixed AND visual.enabled isn't EXPLICITLY
  // false, visual fires automatically. Code-only PRs still skip.
  // Three knobs honored, in order of precedence:
  //   1. --no-visual        → always off
  //   2. --visual           → always on
  //   3. visual.enabled = true   → always on
  //   4. visual.enabled = false  → always off
  //   5. visual.enabled unset    → on iff domain is design/mixed (v0.13 default)
  const visualConfigSetting = config.visual?.enabled;
  const domainWantsVisual = resolvedDomain === "design" || resolvedDomain === "mixed";
  const visualEnabled = args.noVisual
    ? false
    : args.visual ||
      visualConfigSetting === true ||
      (visualConfigSetting === undefined && domainWantsVisual);
  let visualCaptureResult: VisualCaptureResult | null = null;
  if (visualEnabled && domainWantsVisual) {
    if (!loaded.prevSha) {
      process.stderr.write(
        "conclave review: --visual set but no base SHA available (pullNumber=0 or git diff had no base) — skipping capture\n",
      );
    } else {
      try {
        const visualCfg = config.visual;
        const platformIds: PlatformId[] =
          visualCfg?.platforms ?? ["vercel", "netlify", "cloudflare", "railway", "render", "deployment-status"];
        const { platforms, skipped: platformsSkipped } = await buildPlatforms(platformIds);
        for (const sk of platformsSkipped) {
          process.stderr.write(`conclave review: visual platform "${sk.id}" skipped — ${sk.reason}\n`);
        }
        if (platforms.length === 0) {
          process.stderr.write(
            "conclave review: visual enabled but no platforms available — skipping capture (DesignAgent will use text-UI mode)\n",
          );
        } else {
          // Scale the per-PR budget for multi-modal runs (vision ~4x text).
          const multiplier = visualCfg?.budgetMultiplier ?? 1.5;
          if (multiplier > 1) {
            budget.raiseCap(config.budget.perPrUsd * multiplier);
            infoOut(
              `conclave review: budget raised to $${(config.budget.perPrUsd * multiplier).toFixed(2)} for multi-modal run (${multiplier}x)\n`,
            );
          }
          const routes = args.visualRoutes ?? visualCfg?.routes ?? [];
          const viewports: ViewportSpec[] = buildViewports(visualCfg?.viewport);
          infoOut(
            `conclave review: visual capture starting (routes=${routes.length > 0 ? routes.join(",") : "auto-detect"}, viewports=[${viewports.map((v) => v.label).join(",")}])\n`,
          );
          // v0.11 — progress: visual capture phase starting. Routes
          // payload is the explicit list when configured, else empty
          // (renderer says "auto-detect routes").
          await emitProgress(notifiers, {
            episodicId,
            stage: "visual-capture-started",
            payload: {
              repo: loaded.repo,
              ...(loaded.pullNumber ? { pullNumber: loaded.pullNumber } : {}),
              ...(routes.length > 0 ? { routes } : {}),
            },
          });
          visualCaptureResult = await runVisualCapture({
            repo: loaded.repo,
            beforeSha: loaded.prevSha,
            afterSha: loaded.newSha,
            platforms,
            configDir,
            deployStatus,
            ...(routes.length > 0 ? { routes } : {}),
            viewports,
            maxRoutes: visualCfg?.maxRoutes ?? 8,
            waitSeconds: visualCfg?.waitSeconds ?? 60,
            skipDeployWait: args.skipDeployWait,
          });
          if (visualCaptureResult.artifacts.length > 0) {
            reviewCtx.visualArtifacts = visualCaptureResult.artifacts;
            infoOut(
              `conclave review: visual capture done — ${visualCaptureResult.artifacts.length} before/after pair(s), ${visualCaptureResult.totalMs}ms\n`,
            );
            // v0.13.22 — design system baseline comparison. Match captured
            // "after" screenshots against stored baselines to populate
            // ReviewContext.designBaselineDrift for DesignAgent Mode A.
            // Runs after artifact logging so the UI flow is:
            //   1. visual capture done (N pairs)
            //   2. baseline matched (M / N routes)
            //   3. council deliberates with both PR diff + baseline drift
            try {
              const baselineMatches = await matchBaselinesToArtifacts(
                configDir,
                visualCaptureResult.artifacts,
              );
              if (baselineMatches.length > 0) {
                // Pre-compute pixel diff ratios for each baseline→after pair
                // so DesignAgent sees a quantitative drift signal alongside
                // the image. Failures per-route are non-fatal.
                const visualMod = await import("@conclave-ai/visual-review");
                const { PixelmatchDiff } = visualMod;
                const diffEngine = new PixelmatchDiff();
                const driftPairs: NonNullable<typeof reviewCtx.designBaselineDrift> = [];
                for (const m of baselineMatches) {
                  let diffRatio: number | undefined;
                  try {
                    const baselineU8 = new Uint8Array(m.baseline);
                    const afterU8 = new Uint8Array(m.after);
                    const dres = await diffEngine.diff(baselineU8, afterU8, {
                      threshold: config.visual?.diffThreshold ?? 0.1,
                    });
                    diffRatio = dres.diffRatio;
                  } catch {
                    // Non-fatal — still pass the pair without a ratio
                  }
                  driftPairs.push({
                    route: m.route,
                    baseline: m.baseline,
                    after: m.after,
                    ...(diffRatio !== undefined ? { diffRatio } : {}),
                  });
                }
                reviewCtx.designBaselineDrift = driftPairs;
                const driftSummary = driftPairs
                  .map((p) =>
                    p.diffRatio !== undefined
                      ? `${p.route} ${(p.diffRatio * 100).toFixed(1)}%`
                      : p.route,
                  )
                  .join(", ");
                infoOut(
                  `conclave review: baseline matched ${driftPairs.length}/${visualCaptureResult.artifacts.length} route(s) — ${driftSummary}\n`,
                );
              } else {
                infoOut(
                  `conclave review: no design baseline found — run with --capture-baseline to record a golden reference\n`,
                );
              }
              // v0.13.22 — save "after" captures as the new baseline when
              // --capture-baseline is set. Overwrites existing files.
              // Always runs after matching so the new baseline takes effect
              // for the NEXT review (not the current one's drift detection).
              if (args.captureBaseline) {
                const { saved } = await saveDesignBaseline(
                  configDir,
                  visualCaptureResult.artifacts,
                );
                infoOut(
                  `conclave review: baseline saved — ${saved.length} route(s) written to .conclave/design/baseline/\n`,
                );
              }
            } catch (err) {
              process.stderr.write(
                `conclave review: baseline check failed — ${(err as Error).message}\n`,
              );
            }
          } else {
            process.stderr.write(
              `conclave review: visual capture produced no artifacts — ${visualCaptureResult.reason}\n`,
            );
          }
          // v0.11 — progress: visual capture phase done. Always fired
          // (paired with started) so the timeline closes the phase
          // even when artifacts == 0 (renderer shows "0 pairs").
          await emitProgress(notifiers, {
            episodicId,
            stage: "visual-capture-done",
            payload: {
              repo: loaded.repo,
              ...(loaded.pullNumber ? { pullNumber: loaded.pullNumber } : {}),
              artifactCount: visualCaptureResult.artifacts.length,
              totalMs: visualCaptureResult.totalMs,
            },
          });
          for (const w of visualCaptureResult.warnings) {
            process.stderr.write(`conclave review: visual warning — ${w}\n`);
          }
          for (const sk of visualCaptureResult.skipped) {
            process.stderr.write(
              `conclave review: visual skipped ${sk.route}@${sk.viewport} — ${sk.reason}\n`,
            );
          }
        }
      } catch (err) {
        process.stderr.write(
          `conclave review: visual capture failed — ${(err as Error).message} (proceeding with text-UI mode)\n`,
        );
      }
    }
  }

  // H2 #9 — when the diff exceeds the splitter threshold, run council
  // chunk-by-chunk and integrate. Each chunk reuses the same retrieved
  // RAG context (answer-keys / failures are repo-level signals, not
  // chunk-level). Caches in the efficiency gate stay warm across chunks.
  const splitterEnabled = config.efficiency.diffSplitter !== false;
  const splitterMaxLines = config.efficiency.diffSplitterMaxLines ?? 500;
  const splitterMaxFiles = config.efficiency.diffSplitterMaxFilesPerChunk ?? 20;
  const totalChangedLines = countDiffChangedLines(loaded.diff);
  const useSplitter = splitterEnabled && totalChangedLines > splitterMaxLines;
  let rawOutcome: CouncilOutcome;
  if (useSplitter) {
    const chunks = splitDiff(loaded.diff, {
      maxLinesPerChunk: splitterMaxLines,
      maxChangedFilesPerChunk: splitterMaxFiles,
    });
    if (chunks.length <= 1) {
      // Diff has no per-file boundaries (or fits one chunk) — fall back to single pass.
      rawOutcome = await council.deliberate(reviewCtx);
    } else {
      infoOut(
        `conclave review: diff-splitter active — ${totalChangedLines} changed lines across ${chunks.length} chunks ` +
          `(max ${splitterMaxLines} lines/chunk, ${splitterMaxFiles} files/chunk)\n`,
      );
      const chunkOutcomes: CouncilOutcome[] = [];
      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i]!;
        infoOut(
          `conclave review: chunk ${i + 1}/${chunks.length} — ${chunk.changedLines} lines, ${chunk.files.length} file(s)\n`,
        );
        const chunkCtx: ReviewContext = { ...reviewCtx, diff: chunk.diff };
        chunkOutcomes.push(await council.deliberate(chunkCtx));
      }
      rawOutcome = integrateChunkOutcomes(chunkOutcomes);
    }
  } else {
    rawOutcome = await council.deliberate(reviewCtx);
  }

  // 5b. H2 #7 — active failure-catalog gating. Scan the diff against
  //     retrieved failure-catalog entries; inject sticky blockers for
  //     any known pattern the council didn't already flag. Deterministic
  //     and free (no LLM call). Off via `memory.activeFailureGate: false`.
  const gateEnabled = config.memory.activeFailureGate !== false;
  // H2 #8 — load per-repo calibration so the gate can demote / skip
  // stickies for categories the user has repeatedly overridden.
  const calibrationStore = new FileSystemCalibrationStore({ root: memoryRoot });
  const calibration = gateEnabled
    ? await calibrationStore.load(loaded.repo, "code").catch(() => new Map())
    : new Map();
  const failureGateOutput: FailureGateResult = gateEnabled
    ? applyFailureGate(rawOutcome, retrieval.failures, reviewCtx, {
        minTokenOverlap: config.memory.activeFailureGateMinOverlap ?? 2,
        calibration,
      })
    : { outcome: rawOutcome, stickyBlockers: [], matches: [], calibrationSkips: [] };
  const outcome = failureGateOutput.outcome;
  if (failureGateOutput.stickyBlockers.length > 0) {
    infoOut(
      `conclave review: failure-gate injected ${failureGateOutput.stickyBlockers.length} sticky blocker${
        failureGateOutput.stickyBlockers.length === 1 ? "" : "s"
      } (${failureGateOutput.matches.map((m) => m.failureId).join(", ")}); verdict → ${outcome.verdict}\n`,
    );
  }
  if (failureGateOutput.calibrationSkips.length > 0) {
    infoOut(
      `conclave review: failure-gate skipped ${failureGateOutput.calibrationSkips.length} sticky` +
        `${failureGateOutput.calibrationSkips.length === 1 ? "" : "s"} via calibration ` +
        `(${failureGateOutput.calibrationSkips
          .map((s) => `${s.category}@${s.overrideCount}x`)
          .join(", ")})\n`,
    );
  }

  // 6. Persist the episodic entry (outcome: "pending") so `conclave
  //    record-outcome` can classify it later into answer-keys / failures.
  // v0.11 — pre-generated episodicId is reused so the Telegram timeline
  //         message and the on-disk episodic entry share the same id.
  // H2 #6 — cycleNumber is 1-indexed; --rework-cycle 0 (default) is the
  //         first review of the PR, --rework-cycle N is the (N+1)-th.
  //         priorEpisodicId links to the previous cycle for the same PR
  //         so OutcomeWriter can recover removed-blockers on merge.
  const cycleNumber = (args.reworkCycle ?? 0) + 1;
  const priorEpisodicId =
    cycleNumber > 1 && loaded.pullNumber
      ? await findPriorEpisodicId(store, loaded.repo, loaded.pullNumber, cycleNumber)
      : undefined;
  const writer = new OutcomeWriter({ store });
  const episodic = await writer.writeReview({
    ctx: reviewCtx,
    reviews: outcome.results,
    councilVerdict: outcome.verdict,
    costUsd: gate.metrics.summary().totalCostUsd,
    episodicId,
    cycleNumber,
    ...(priorEpisodicId ? { priorEpisodicId } : {}),
  });

  // v0.12.x — anchor the episodic in central plane so the autonomy
  // loop's CI rework can fetch it when local-only invocation means
  // the .conclave/episodic/... file isn't on the CI runner. Best-
  // effort: a failure here NEVER kills the review — the verdict is
  // already valid, the autonomy loop just degrades to "rework workflow
  // logs episodic-not-found and exits 1" (the v0.11 behaviour).
  // Skip when CONCLAVE_TOKEN is absent (v0.3-compat direct path users
  // don't have a central plane to push to).
  if ((process.env["CONCLAVE_TOKEN"] ?? "").trim().length > 0) {
    const anchorResult = await pushEpisodicAnchor(episodic);
    if (anchorResult.ok) {
      infoOut(`conclave review: episodic anchored to central plane (${episodic.id})\n`);
    } else if (anchorResult.reason) {
      // Already-logged inside pushEpisodicAnchor on transport errors;
      // surface the reason here only for the silent skip cases.
      if (!anchorResult.reason.startsWith("HTTP ")) {
        process.stderr.write(`conclave review: episodic anchor skipped — ${anchorResult.reason}\n`);
      }
    }
  }

  // 7. Render + exit with a verdict-derived code
  const tieredOutcome =
    useTiered && "tier1Outcome" in outcome
      ? (outcome as TieredCouncilOutcome)
      : null;

  // v0.11 — progress: deliberation phase done. tier1 always emits;
  // tier-2 only emits when escalation actually ran (outcome.tier2Outcome
  // is populated). Blocker count is summed across results, capped at
  // major+blocker severity so nit/minor noise doesn't inflate the
  // headline number a user sees in the chat.
  if (tieredOutcome) {
    const tier1Blockers = tieredOutcome.tier1Outcome.results.reduce(
      (sum, r) => sum + r.blockers.filter((b) => b.severity === "blocker" || b.severity === "major").length,
      0,
    );
    await emitProgress(notifiers, {
      episodicId,
      stage: "tier1-done",
      payload: {
        repo: loaded.repo,
        ...(loaded.pullNumber ? { pullNumber: loaded.pullNumber } : {}),
        blockerCount: tier1Blockers,
        rounds: tieredOutcome.tier1Outcome.rounds,
      },
    });
    if (tieredOutcome.escalated && tieredOutcome.tier2Outcome) {
      await emitProgress(notifiers, {
        episodicId,
        stage: "escalating-to-tier2",
        payload: {
          repo: loaded.repo,
          ...(loaded.pullNumber ? { pullNumber: loaded.pullNumber } : {}),
          ...(tieredOutcome.escalationReason ? { reason: tieredOutcome.escalationReason } : {}),
        },
      });
      const tier2Blockers = tieredOutcome.tier2Outcome.results.reduce(
        (sum, r) => sum + r.blockers.filter((b) => b.severity === "blocker" || b.severity === "major").length,
        0,
      );
      await emitProgress(notifiers, {
        episodicId,
        stage: "tier2-done",
        payload: {
          repo: loaded.repo,
          ...(loaded.pullNumber ? { pullNumber: loaded.pullNumber } : {}),
          blockerCount: tier2Blockers,
          rounds: tieredOutcome.tier2Outcome.rounds,
        },
      });
    }
  } else {
    // Flat-Council path — emit a single tier1-done so the timeline still
    // closes. Reuses outcome.results since there's no tier split.
    const flatBlockers = outcome.results.reduce(
      (sum, r) => sum + r.blockers.filter((b) => b.severity === "blocker" || b.severity === "major").length,
      0,
    );
    await emitProgress(notifiers, {
      episodicId,
      stage: "tier1-done",
      payload: {
        repo: loaded.repo,
        ...(loaded.pullNumber ? { pullNumber: loaded.pullNumber } : {}),
        blockerCount: flatBlockers,
        rounds: outcome.rounds,
      },
    });
  }
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
  if (args.json) {
    // v0.7.1 — structured JSON path. Stdout carries exactly one JSON
    // object terminated by newline; all diagnostics went to stderr via
    // `infoOut`. Preserves exit code below.
    const tier1Ids = tier1IdsResolved;
    const tier2Ids = tier2IdsResolved;
    const jsonInput: Parameters<typeof buildReviewJson>[0] = {
      repo: loaded.repo,
      sha: loaded.newSha,
      councilVerdict: outcome.verdict,
      domain: resolvedDomain,
      results: outcome.results,
      metrics: gate.metrics.summary(),
      episodicId: episodic.id,
    };
    if (loaded.pullNumber) jsonInput.pullNumber = loaded.pullNumber;
    if (tieredOutcome) {
      const tierEntry: NonNullable<Parameters<typeof buildReviewJson>[0]["tier"]> = {
        escalated: tieredOutcome.escalated,
        reason: tieredOutcome.escalationReason,
        tier1Rounds: tieredOutcome.tier1Outcome.rounds,
        tier1Ids,
        tier2Ids,
        tier1Verdict: tieredOutcome.tier1Outcome.verdict,
      };
      if (tieredOutcome.tier2Outcome) {
        tierEntry.tier2Rounds = tieredOutcome.tier2Outcome.rounds;
        tierEntry.tier2Verdict = tieredOutcome.tier2Outcome.verdict;
      }
      jsonInput.tier = tierEntry;
    }
    if (plainSummary) jsonInput.plainSummary = plainSummary;
    const payload = buildReviewJson(jsonInput);
    process.stdout.write(serializeReviewJson(payload));
  } else {
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
  }

  // 8. Optional integrations — equal-weight per decision #24. Missing
  //    credentials skip with stderr warning; integration failures never
  //    kill the review exit code.
  // v0.11 — notifiers were already constructed earlier (right after
  // reviewCtx) so notifyProgress could fire during deliberation. Reuse
  // the same array here for the final notifyReview call.
  if (notifiers.length > 0) {
    // Only pass plainSummary to notifiers if the "telegram" delivery is
    // enabled for plain summary (Telegram is our primary non-dev surface).
    const telegramDelivery = plainEnabled && deliveries.includes("telegram") && plainSummary;
    // v0.8 — autonomy knobs. Cycle comes from --rework-cycle (defaults 0).
    // Max comes from --max-rework-cycles override or config.autonomy.
    // Blocker count is summed across agents for the Telegram prose.
    const autonomyCfg = config.autonomy;
    const effectiveMaxCycles =
      args.maxReworkCycles !== undefined
        ? args.maxReworkCycles
        : (autonomyCfg?.maxReworkCycles ?? 3);
    const blockerCount = outcome.results.reduce(
      (sum, r) => sum + r.blockers.filter((b) => b.severity === "blocker" || b.severity === "major").length,
      0,
    );
    const notifyInput = {
      outcome,
      ctx: reviewCtx,
      episodicId: episodic.id,
      totalCostUsd: gate.metrics.summary().totalCostUsd,
      ...(loaded.pullNumber && loaded.source === "gh-pr"
        ? { prUrl: `https://github.com/${loaded.repo}/pull/${loaded.pullNumber}` }
        : {}),
      ...(telegramDelivery ? { plainSummary } : {}),
      reworkCycle: args.reworkCycle ?? 0,
      maxReworkCycles: effectiveMaxCycles,
      ...(autonomyCfg?.allowUnsafeMerge !== undefined
        ? { allowUnsafeMerge: autonomyCfg.allowUnsafeMerge }
        : {}),
      blockerCount,
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

  // 9. Pixel-diff report (v0.9.0). When we captured artifacts earlier
  //    for DesignAgent Mode A (vision), compute a pixel-diff severity
  //    summary here so the reviewer sees "how much changed" alongside
  //    DesignAgent's "whether it's good". No extra Playwright run.
  if (visualCaptureResult && visualCaptureResult.artifacts.length > 0) {
    try {
      const visualMod = await import("@conclave-ai/visual-review");
      const { PixelmatchDiff, classifyDiffRatio } = visualMod;
      const diffEngine = new PixelmatchDiff();
      infoOut(`\n── visual pixel-diff ──\n`);
      if (visualCaptureResult.before) {
        infoOut(
          `  before url: ${visualCaptureResult.before.url} (${visualCaptureResult.before.provider})\n`,
        );
      }
      if (visualCaptureResult.after) {
        infoOut(
          `  after url:  ${visualCaptureResult.after.url} (${visualCaptureResult.after.provider})\n`,
        );
      }
      const outDir = path.join(configDir, ".conclave", "visual", loaded.newSha);
      const { promises: fsp } = await import("node:fs");
      await fsp.mkdir(outDir, { recursive: true });
      for (const art of visualCaptureResult.artifacts) {
        try {
          const beforeBuf = Buffer.isBuffer(art.before)
            ? new Uint8Array(art.before)
            : art.before;
          const afterBuf = Buffer.isBuffer(art.after)
            ? new Uint8Array(art.after)
            : art.after;
          const dres = await diffEngine.diff(
            beforeBuf as Uint8Array,
            afterBuf as Uint8Array,
            { threshold: config.visual?.diffThreshold ?? 0.1 },
          );
          const safe = art.route.replace(/[\/:@]/g, "_").replace(/^_/, "");
          const baseName = safe || "root";
          await fsp.writeFile(path.join(outDir, `${baseName}-before.png`), beforeBuf);
          await fsp.writeFile(path.join(outDir, `${baseName}-after.png`), afterBuf);
          await fsp.writeFile(path.join(outDir, `${baseName}-diff.png`), dres.diffPng);
          infoOut(
            `  ${art.route}: ${classifyDiffRatio(dres.diffRatio)} ` +
              `(${(dres.diffRatio * 100).toFixed(2)}% / ${dres.diffPixels.toLocaleString()} px)\n`,
          );
        } catch (err) {
          process.stderr.write(
            `conclave review: pixel-diff for ${art.route} failed — ${(err as Error).message}\n`,
          );
        }
      }
      infoOut(`  pngs saved: ${outDir}\n`);
    } catch (err) {
      process.stderr.write(
        `conclave review: pixel-diff report failed — ${(err as Error).message}\n`,
      );
    }
  }

  if (langfuseSink) {
    await langfuseSink.shutdown();
  }

  process.exit(verdictToExitCode(outcome.verdict));
}

/**
 * v0.9.0 — map config.visual.viewport tuples into ViewportSpec[].
 * Desktop always comes first (it's the primary surface); mobile second
 * when present. An empty config falls back to a single desktop viewport.
 * Exported for unit testing without invoking the full review command.
 */
export function buildViewports(
  viewportCfg:
    | { desktop?: readonly [number, number]; mobile?: readonly [number, number] }
    | undefined,
): ViewportSpec[] {
  const out: ViewportSpec[] = [];
  if (viewportCfg?.desktop) {
    out.push({ label: "desktop", width: viewportCfg.desktop[0], height: viewportCfg.desktop[1] });
  } else {
    out.push({ label: "desktop", width: 1280, height: 800 });
  }
  if (viewportCfg?.mobile) {
    out.push({ label: "mobile", width: viewportCfg.mobile[0], height: viewportCfg.mobile[1] });
  }
  return out;
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

/**
 * H2 #9 — count total +/- content lines in a unified diff (excludes
 * `+++ b/<path>` / `--- a/<path>` headers). Used to decide whether the
 * diff-splitter should kick in.
 */
function countDiffChangedLines(diff: string): number {
  let n = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+") || line.startsWith("-")) n += 1;
  }
  return n;
}
