/**
 * UX-1 — render a unified terminal-cycle summary for autofix bail
 * statuses. Pre-UX-1, only `bailed-max-iterations` posted a PR
 * comment; bailed-build-failed / bailed-tests-failed / bailed-no-patches
 * (mid-iteration apply-conflict, no-applicable patches) all early-
 * returned without surfacing anything to the user. The PR sat with
 * a stale review comment and the user had to dig through Actions
 * logs to find out what happened.
 *
 * Bae's complaint that triggered this: "야 그러면 그렇다고 결과를
 * 알려줘야지" after PR #37 — autofix removed dead code → empty cycle 2
 * → review.yml skipped silently. PIA-4 closed the workflow side; UX-1
 * closes the autofix side: every terminal autofix status posts ONE
 * unified summary so the user always knows where the cycle ended.
 *
 * Pure renderer — no I/O. The caller wires the gh subprocess.
 */
import type { AutofixResultStatus, Blocker } from "@conclave-ai/core";

export interface BailSummaryContext {
  iterationsAttempted: number;
  totalCostUsd: number;
  remainingBlockers: Blocker[];
  /** Optional reason already in the result; used as the leading fact. */
  reason?: string;
}

const STATUS_HEADLINE: Record<string, string> = {
  "bailed-no-patches":
    "Autofix bailed — none of the council blockers produced an applicable patch this cycle",
  "bailed-build-failed":
    "Autofix bailed — patches applied but the build failed; reverted to keep the branch green",
  "bailed-tests-failed":
    "Autofix bailed — patches applied + built, but the test suite failed; reverted",
  "bailed-secret-guard":
    "Autofix bailed — secret-guard blocked a patch that contained credential-shaped strings",
  "bailed-max-iterations":
    "Autofix bailed — reached max iterations without a clean push; remaining blockers below",
  "bailed-budget":
    "Autofix bailed — per-PR budget exhausted before the loop could finish",
  "loop-guard-trip":
    "Autofix bailed — LoopGuard tripped (suspected runaway); loop terminated for safety",
  "deferred-to-next-review":
    "Autofix pushed this cycle's patches and reached the iteration cap — the next review.yml run is the authoritative verdict",
};

const STATUS_NEXT_STEPS: Record<string, string> = {
  "bailed-no-patches":
    "Likely causes: worker couldn't generate a clean diff (off-by-N hunks, hallucinated context), or the file is in the deny-list (secrets/keys/env). Re-run with `conclave autofix --pr <N>` after addressing the listed blockers manually.",
  "bailed-build-failed":
    "Inspect the build output in the Actions log. The autofix worker has been notified of the failure tail and will retry on the next push.",
  "bailed-tests-failed":
    "Inspect the test failure output. Either the patch broke a test (worker misjudgement) or the test was already broken — the autofix doesn't distinguish.",
  "bailed-secret-guard":
    "If the flagged string is genuinely safe (not a secret), re-run with `--allow-secret <rule-id>`. Otherwise, fix the worker prompt / model — patches should never contain real keys.",
  "bailed-max-iterations":
    "Cycle ceiling hit. Resolve the remaining blockers manually, or re-run the rework dispatch after rebasing. If this PR consistently hits the cap, the worker may need prompt tuning.",
  "bailed-budget":
    "Increase the per-PR budget in `.conclaverc.json` (`budget.perPrUsd`) or shrink the diff scope. Default is $3.",
  "loop-guard-trip":
    "Check Actions logs for the trip reason. Usually indicates the worker is stuck in a same-patch retry loop.",
  "deferred-to-next-review":
    "No action needed. The pushed commit triggers a fresh review.yml run; that run's verdict is the authority.",
};

/**
 * Whether this status should produce a user-facing summary comment.
 * Approve / awaiting-approval / dry-run / merged-already-noticed don't
 * need one — the existing flow already surfaces them.
 */
export function shouldPostSummary(status: AutofixResultStatus | string): boolean {
  return status.startsWith("bailed-") ||
    status === "loop-guard-trip" ||
    status === "deferred-to-next-review";
}

/**
 * Build the PR comment body. Markdown-safe — caller pipes it to
 * `gh pr comment --body-file`.
 *
 * Always includes:
 *   - one-line headline tied to the status
 *   - "What happened" recap with iteration count + cost
 *   - "What you can do" next-steps
 *   - up to 10 remaining blockers with severity + category + message
 */
export function renderBailSummary(
  status: AutofixResultStatus | string,
  ctx: BailSummaryContext,
): string {
  const headline = STATUS_HEADLINE[status] ?? `Autofix terminated (${status})`;
  const nextSteps = STATUS_NEXT_STEPS[status] ?? "See logs for details.";
  const cost = ctx.totalCostUsd > 0 ? `$${ctx.totalCostUsd.toFixed(4)}` : "$0";
  const blockers = ctx.remainingBlockers
    .slice(0, 10)
    .map((b) => `- \`[${b.severity}/${b.category ?? "uncategorized"}]\` ${b.message}${b.file ? ` _(${b.file})_` : ""}`)
    .join("\n");
  const more =
    ctx.remainingBlockers.length > 10
      ? `\n\n_…and ${ctx.remainingBlockers.length - 10} more blockers (full list in the next review's payload)._`
      : "";
  const reasonLine = ctx.reason ? `\n\n**Reason:** ${ctx.reason}` : "";

  const lines: string[] = [
    `## 🤖 Conclave AI — autofix cycle ended`,
    "",
    `**${headline}**`,
    `_status: \`${status}\`_${reasonLine}`,
    "",
    `**What happened:** ${ctx.iterationsAttempted} iteration(s) attempted, ${cost} spent.`,
    "",
    `**What you can do:** ${nextSteps}`,
  ];
  if (blockers.length > 0) {
    lines.push("", `**Remaining blockers:**`, blockers + more);
  }
  return lines.join("\n");
}
