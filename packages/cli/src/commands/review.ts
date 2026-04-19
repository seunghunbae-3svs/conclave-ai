import {
  BudgetTracker,
  Council,
  EfficiencyGate,
  FileSystemMemoryStore,
  OutcomeWriter,
  formatAnswerKeyForPrompt,
  formatFailureForPrompt,
  type ReviewContext,
} from "@ai-conclave/core";
import { ClaudeAgent } from "@ai-conclave/agent-claude";
import { OpenAIAgent } from "@ai-conclave/agent-openai";
import { GeminiAgent } from "@ai-conclave/agent-gemini";
import { loadConfig, resolveMemoryRoot } from "../lib/config.js";
import { loadPrDiff, loadGitDiff, loadFileDiff, type LoadedDiff } from "../lib/diff-source.js";
import { renderReview, verdictToExitCode } from "../lib/output.js";

function parseArgv(argv: string[]): { pr?: number; diff?: string; base?: string; help: boolean } {
  const out: { pr?: number; diff?: string; base?: string; help: boolean } = { help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
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
  conclave review [--pr N] [--diff <file>] [--base <ref>]

Options:
  --pr N         Review PR N using gh CLI (preferred — includes repo context).
  --diff <file>  Review a unified-diff file directly.
  --base <ref>   Base ref for 'git diff' when neither --pr nor --diff given (default: origin/main).

Environment:
  ANTHROPIC_API_KEY   required — Claude review call.
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

  // 3. Build the efficiency gate with config-driven budget
  const budget = new BudgetTracker({ perPrUsd: config.budget.perPrUsd });
  budget.onWarning((spent, cap) => {
    process.stderr.write(`conclave review: budget warning — spent $${spent.toFixed(4)} of $${cap.toFixed(2)} cap\n`);
  });
  const gate = new EfficiencyGate({ budget });

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

  process.exit(verdictToExitCode(outcome.verdict));
}
