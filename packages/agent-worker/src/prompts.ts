import type { Blocker } from "@conclave-ai/core";
import type { WorkerContext } from "./types.js";

export const WORKER_SYSTEM_PROMPT = `You are the Worker agent on Conclave AI. Your job is to turn council blockers into a concrete code patch.

Upstream context: a multi-agent review council flagged blockers on a pull request. The council's role is to spot problems. Your role is to fix them — produce a unified diff that, when applied with \`git apply\` on top of the PR head commit, resolves the blockers without regressing anything else.

Hard rules:
- You MUST respond by calling the submit_patch tool exactly once. Do not emit free-form text.
- The \`patch\` field MUST be a valid unified diff — with \`diff --git\` or \`---\`/\`+++\` headers and \`@@\` hunks — not prose, not a code snippet.
- Fix ONLY the blockers the council raised. Do not refactor unrelated code, rename things, reformat files, or add features. Scope creep is a worse failure than leaving a minor blocker untouched.
- Modify EXISTING files only. Do NOT create new files (including test files, documentation, scripts, or config files) unless a blocker explicitly names a missing file as the defect. Adding a test file "just to cover the fix" counts as scope creep and is forbidden — the human reviewer adds tests, not the worker.
- Preserve existing public APIs, exports, file paths, import styles, and indentation conventions (tabs vs spaces, quote style) exactly as the source uses them.
- If a blocker requires information you don't have (a file not included in the snapshots, or ambiguity about intent), skip it and note that in \`summary\`. Never invent file contents you haven't been shown.
- If NO blocker is fixable with the information given, return an empty \`patch\` string, an empty \`filesTouched\` array, and explain in \`summary\` what the caller should gather before retrying.
- \`commitMessage\` should be a single line (≤ 72 chars), conventional-commit style where it fits. No trailing period.
- \`filesTouched\` must list every repo-relative path the patch modifies, creates, or deletes — forward slashes, exactly as they appear in the patch headers.
- The caller applies your patch with \`git apply --recount\`, so the line counts in your \`@@ -A,B +C,D @@\` headers DO NOT need to be exact — they will be recomputed from the actual hunk content. Focus on correct \`-\`/\`+\`/context lines; don't agonise over the header numbers.`;

function renderBlockers(reviews: WorkerContext["reviews"]): string {
  const lines: string[] = [];
  for (const r of reviews) {
    if (r.verdict === "approve" || r.blockers.length === 0) continue;
    lines.push(`## ${r.agent} — verdict: ${r.verdict}`);
    if (r.summary) lines.push(r.summary);
    for (const b of r.blockers) {
      lines.push(`- ${formatBlocker(b)}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

function formatBlocker(b: Blocker): string {
  const loc = b.file ? ` (${b.file}${b.line ? ":" + b.line : ""})` : "";
  return `[${b.severity}/${b.category}] ${b.message}${loc}`;
}

export function buildWorkerPrompt(ctx: WorkerContext): string {
  const sections: string[] = [];
  sections.push(`# Rework target`);
  sections.push(`repo: ${ctx.repo}`);
  sections.push(`pull: #${ctx.pullNumber}`);
  sections.push(`head sha: ${ctx.newSha}`);
  sections.push("");

  const blockerSection = renderBlockers(ctx.reviews);
  if (blockerSection) {
    sections.push(`# Blockers to fix`);
    sections.push(blockerSection);
    sections.push("");
  } else {
    sections.push(`# Blockers to fix`);
    sections.push(
      `(None of the council verdicts carry blockers. Return an empty patch and note this in summary — the caller should not have invoked rework.)`,
    );
    sections.push("");
  }

  if (ctx.fileSnapshots.length > 0) {
    sections.push(`# Current file contents`);
    sections.push(
      `These are the files on the PR branch right now, at sha ${ctx.newSha}. Base your patch on these exact contents.`,
    );
    sections.push("");
    for (const snap of ctx.fileSnapshots) {
      sections.push(`## ${snap.path}`);
      sections.push("```");
      sections.push(snap.contents);
      sections.push("```");
      sections.push("");
    }
  } else {
    sections.push(
      `# Current file contents\n(no snapshots provided — return an empty patch and list the files you need in summary)`,
    );
    sections.push("");
  }

  if (ctx.diff) {
    sections.push(`# Diff that was reviewed`);
    sections.push(
      `This is the change that the council ran on. Useful when a blocker cites a line number relative to the diff rather than the current file.`,
    );
    sections.push("```diff");
    sections.push(ctx.diff);
    sections.push("```");
    sections.push("");
  }

  sections.push(
    `Call submit_patch exactly once with a unified diff, a commit message, the list of files touched, and a one-paragraph summary.`,
  );
  return sections.join("\n");
}

/**
 * Stable prefix suitable for Anthropic prompt caching. Mirrors the shape
 * used by agent-claude — system prompt plus any pinned RAG strings that
 * don't change per call.
 */
export function buildCacheablePrefix(ctx: WorkerContext): string {
  const parts: string[] = [WORKER_SYSTEM_PROMPT];
  if (ctx.answerKeys && ctx.answerKeys.length > 0) {
    parts.push("answer-keys:\n" + ctx.answerKeys.slice(0, 8).join("\n"));
  }
  if (ctx.failureCatalog && ctx.failureCatalog.length > 0) {
    parts.push("failure-catalog:\n" + ctx.failureCatalog.slice(0, 8).join("\n"));
  }
  return parts.join("\n---\n");
}
