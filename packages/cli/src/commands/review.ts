import { Council } from "@ai-conclave/core";
import { ClaudeAgent } from "@ai-conclave/agent-claude";

/**
 * `conclave review` — skeleton command.
 *
 * Real implementation will:
 *   1. Discover the current PR (git + gh CLI)
 *   2. Load the diff + repo context
 *   3. Route through the efficiency gate (cache / triage / budget)
 *   4. Run the council deliberation across N agents
 *   5. Post consensus back to the PR (GitHub comment + optional Telegram)
 *   6. Write outcome to episodic memory (nightly classifies into
 *      answer-keys / failure-catalog)
 *
 * Current scaffold: spins up a single-Claude council with an empty diff so
 * we can validate the wiring end-to-end.
 */
export async function review(argv: string[]): Promise<void> {
  const prFlag = argv.findIndex((a) => a === "--pr");
  const prNumber = prFlag >= 0 && argv[prFlag + 1] ? Number.parseInt(argv[prFlag + 1]!, 10) : 0;

  if (!process.env["ANTHROPIC_API_KEY"]) {
    process.stderr.write(
      "conclave review: ANTHROPIC_API_KEY not set. Export the key and retry.\n",
    );
    process.exit(1);
    return;
  }

  const council = new Council({ agents: [new ClaudeAgent()] });

  process.stdout.write(
    `conclave review (skeleton):\n` +
      `  agents: ${council.agentCount}\n` +
      `  rounds: ${council.roundLimit}\n` +
      `  pr: ${prNumber || "(none — dry run)"}\n`,
  );

  const outcome = await council.deliberate({
    diff: "",
    repo: "local/dry-run",
    pullNumber: prNumber || 0,
    newSha: "HEAD",
  });

  process.stdout.write(
    `  verdict: ${outcome.verdict}\n` +
      `  consensus: ${outcome.consensusReached}\n` +
      `  results: ${outcome.results.length}\n`,
  );
}
