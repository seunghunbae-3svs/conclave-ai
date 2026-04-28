import { createHash, randomUUID } from "node:crypto";
import type { EpisodicEntry, AnswerKey, FailureEntry, SolutionPatch } from "./schema.js";
import type { Blocker } from "../agent.js";

export type OutcomeResult = "merged" | "rejected" | "reworked";

export interface ClassificationOutput {
  answerKeys: AnswerKey[];
  failures: FailureEntry[];
}

export interface Classifier {
  /**
   * `priors` carries earlier rework-cycle episodic entries for the same
   * PR (oldest → newest, excluding `episodic` itself). RuleBasedClassifier
   * uses them at merge time to compute "removed blockers" — categories
   * caught earlier but absent from the final review. Optional; legacy
   * callers pass nothing and get the original behavior.
   */
  classify(
    episodic: EpisodicEntry,
    outcome: OutcomeResult,
    priors?: readonly EpisodicEntry[],
  ): ClassificationOutput;
}

/**
 * RuleBasedClassifier — deterministic extraction of answer-keys + failures
 * from an EpisodicEntry without an LLM call.
 *
 * Rules:
 *   - merged + all agents approved → one `AnswerKey` from the consensus
 *     summary. Pattern = `by-repo/<repo>`; tags derived from blocker
 *     categories that appeared but were fixed (across this cycle + any
 *     prior cycles passed in `priors`).
 *   - rejected / reworked → one `FailureEntry` per unique (category, severity)
 *     blocker seen across all agent reviews. Title from blocker.message
 *     (first sentence), body combines message + file:line context.
 *
 * Haiku-backed classifier lands later as a drop-in replacement; interface
 * is stable.
 */
export class RuleBasedClassifier implements Classifier {
  classify(
    episodic: EpisodicEntry,
    outcome: OutcomeResult,
    priors: readonly EpisodicEntry[] = [],
  ): ClassificationOutput {
    if (outcome === "merged") {
      const aggregate = this.extractAnswerKey(episodic, priors);
      // H3 #11 — for each removed blocker that has a matching
      // solutionPatch in any prior cycle's solutionPatches array, emit
      // an additional answer-key carrying the (blocker, patch) pair.
      // Worker retrieves these as "here's what I did last time".
      const solutionKeys = this.extractSolutionAnswerKeys(episodic, priors, aggregate.removedBlockers);
      return { answerKeys: [aggregate, ...solutionKeys], failures: [] };
    }
    return { answerKeys: [], failures: this.extractFailures(episodic) };
  }

  private extractAnswerKey(
    episodic: EpisodicEntry,
    priors: readonly EpisodicEntry[],
  ): AnswerKey {
    const summaries = episodic.reviews
      .map((r) => r.summary)
      .filter((s) => s && s.trim().length > 0)
      .slice(0, 3)
      .join(" | ");
    const removedBlockers = this.extractRemovedBlockers(episodic, priors);
    const lessonBase =
      summaries || `Merged without blockers — ${episodic.repo} #${episodic.pullNumber}`;
    const lesson = removedBlockers.length > 0
      ? `${lessonBase} | Resolved before merge: ${removedBlockers
          .slice(0, 4)
          .map((b) => `${b.category} (${b.severity})`)
          .join("; ")}`
      : lessonBase;
    const tags = this.deriveTags(episodic, removedBlockers);
    const key: AnswerKey = {
      id: `ak-${shortHash(episodic.id + ":" + episodic.sha)}`,
      createdAt: episodic.createdAt,
      domain: "code",
      pattern: `by-repo/${episodic.repo}`,
      lesson,
      tags,
      repo: episodic.repo,
      episodicId: episodic.id,
      removedBlockers,
    };
    return key;
  }

  /**
   * Removed-blocker = present in ANY prior cycle's reviews, absent from
   * the final episodic's reviews. Dedup key is
   * `category|severity|truncate(message,60)` so the same console.log
   * blocker reported by two agents collapses to one entry.
   *
   * Skips nits (those aren't worth polluting future RAG). Final-cycle
   * presence is decided by the same dedup key.
   */
  private extractRemovedBlockers(
    episodic: EpisodicEntry,
    priors: readonly EpisodicEntry[],
  ): AnswerKey["removedBlockers"] {
    if (priors.length === 0) return [];
    const finalKeys = new Set<string>();
    for (const review of episodic.reviews) {
      for (const b of review.blockers) {
        finalKeys.add(blockerKey(b));
      }
    }
    const collected = new Map<string, AnswerKey["removedBlockers"][number]>();
    for (const prior of priors) {
      for (const review of prior.reviews) {
        for (const b of review.blockers) {
          if (b.severity === "nit") continue;
          const k = blockerKey(b);
          if (finalKeys.has(k)) continue;
          if (collected.has(k)) continue;
          collected.set(k, {
            category: b.category,
            severity: b.severity,
            message: truncate(b.message, 200),
          });
        }
      }
    }
    return [...collected.values()];
  }

  private extractFailures(episodic: EpisodicEntry): FailureEntry[] {
    const seen = new Map<string, FailureEntry>();
    for (const review of episodic.reviews) {
      for (const blocker of review.blockers) {
        if (blocker.severity === "nit") continue;
        const key = `${blocker.category}|${blocker.severity}|${truncate(blocker.message, 80)}`;
        if (seen.has(key)) continue;
        seen.set(key, toFailureEntry(blocker, episodic));
      }
    }
    return [...seen.values()];
  }

  /**
   * H3 #11 — match removed-blockers (from H2 #6) against solutionPatches
   * recorded on prior cycles. Each match becomes its own AnswerKey with
   * pattern `autofix-solution/<category>` and the patch hunk attached.
   *
   * Match rule: same blocker.category AND (same blocker.message[:60]
   * substring OR same file). Conservative — false positive is "we
   * recommend a stale patch"; false negative is "worker re-derives a
   * patch from scratch". The patch is informative either way; the
   * solutionPatch's `agent` field plus `solutionPatch.blockerMessage`
   * carry full context so the worker can decide for itself whether
   * the past solution applies.
   */
  private extractSolutionAnswerKeys(
    episodic: EpisodicEntry,
    priors: readonly EpisodicEntry[],
    removedBlockers: AnswerKey["removedBlockers"],
  ): AnswerKey[] {
    if (removedBlockers.length === 0) return [];
    // Collect from episodic itself AND every prior. The patch applied
    // between cycle N and cycle N+1 is recorded on cycle N+1's
    // EpisodicEntry (since that's the cycle that ran review AFTER the
    // worker pushed). On a 3-cycle PR (rework→rework→merge), cycle 3 is
    // `episodic` (its solutionPatches cover the c2→c3 hop) and cycles
    // 1+2 are in `priors` (prior c2's patches cover c1→c2).
    const allPatches: SolutionPatch[] = [...(episodic.solutionPatches ?? [])];
    for (const prior of priors) {
      for (const patch of prior.solutionPatches ?? []) {
        allPatches.push(patch);
      }
    }
    if (allPatches.length === 0) return [];

    const out: AnswerKey[] = [];
    const seenKeys = new Set<string>();
    for (const removed of removedBlockers) {
      for (const patch of allPatches) {
        if (!matchPatchToRemoved(removed, patch)) continue;
        const dedupKey = `${patch.blockerCategory}|${truncate(patch.blockerMessage, 60)}|${patch.blockerFile ?? ""}`;
        if (seenKeys.has(dedupKey)) continue;
        seenKeys.add(dedupKey);
        out.push({
          id: `ak-soln-${shortHash(episodic.id + ":" + dedupKey)}`,
          createdAt: episodic.createdAt,
          domain: "code",
          pattern: `autofix-solution/${patch.blockerCategory}`,
          lesson:
            `Worker (${patch.agent}) resolved a ${patch.blockerCategory} blocker` +
            (patch.blockerFile ? ` in ${patch.blockerFile}` : "") +
            ` — applied patch is attached as solutionPatch (use as RAG for similar future blockers).`,
          tags: [patch.blockerCategory, "autofix-solution"],
          repo: episodic.repo,
          episodicId: episodic.id,
          removedBlockers: [removed],
          solutionPatch: patch,
        });
      }
    }
    return out;
  }

  private deriveTags(
    episodic: EpisodicEntry,
    removedBlockers: AnswerKey["removedBlockers"],
  ): string[] {
    const tags = new Set<string>();
    for (const review of episodic.reviews) {
      for (const b of review.blockers) tags.add(b.category);
    }
    for (const b of removedBlockers) tags.add(b.category);
    return [...tags];
  }
}

function blockerKey(b: { category: string; severity: string; message: string }): string {
  return `${b.category}|${b.severity}|${truncate(b.message, 60)}`;
}

/**
 * H3 #11 — heuristic match between a "removed blocker" record (which
 * carries category + severity + message) and a SolutionPatch (which
 * carries category + message + optional file). True when category
 * matches AND (file matches OR message[:60] overlaps significantly).
 */
function matchPatchToRemoved(
  removed: AnswerKey["removedBlockers"][number],
  patch: SolutionPatch,
): boolean {
  if (removed.category !== patch.blockerCategory) return false;
  // If the patch carries a file and the removed-blocker text mentions
  // the same path (rare — message may not — so this is best-effort), accept.
  if (patch.blockerFile && removed.message.includes(patch.blockerFile)) return true;
  // Message-substring overlap: the removed-blocker's message[:60] vs
  // patch.blockerMessage[:60]. Either side as substring of the other
  // counts — agents tend to phrase the same blocker similarly across
  // cycles, but exact equality is too strict.
  const a = truncate(removed.message, 60).toLowerCase();
  const b = truncate(patch.blockerMessage, 60).toLowerCase();
  return a.includes(b) || b.includes(a);
}

function toFailureEntry(blocker: Blocker, episodic: EpisodicEntry): FailureEntry {
  const category = mapCategory(blocker.category);
  const severity: FailureEntry["severity"] =
    blocker.severity === "blocker" ? "blocker" : blocker.severity === "major" ? "major" : "minor";
  const file = blocker.file ? `${blocker.file}${blocker.line ? `:${blocker.line}` : ""}` : undefined;
  const entry: FailureEntry = {
    id: `fc-${shortHash(episodic.id + ":" + blocker.category + ":" + blocker.message)}`,
    createdAt: episodic.createdAt,
    domain: "code",
    category,
    severity,
    title: titleFrom(blocker.message),
    body: [blocker.message, file ? `at ${file}` : null].filter(Boolean).join(" "),
    tags: [blocker.category],
    seedBlocker: blocker,
    episodicId: episodic.id,
  };
  return entry;
}

const ALLOWED_CATEGORIES: FailureEntry["category"][] = [
  "type-error",
  "missing-test",
  "regression",
  "security",
  "accessibility",
  "contrast",
  "performance",
  "dead-code",
  "api-misuse",
  "schema-drift",
  "other",
];

export function mapCategory(raw: string): FailureEntry["category"] {
  const normalized = raw.toLowerCase().replace(/\s+/g, "-");
  for (const c of ALLOWED_CATEGORIES) {
    if (c === normalized) return c;
  }
  if (normalized.includes("test")) return "missing-test";
  if (normalized.includes("type")) return "type-error";
  if (normalized.includes("security") || normalized.includes("secret")) return "security";
  if (normalized.includes("a11y") || normalized.includes("accessibility")) return "accessibility";
  if (normalized.includes("perf")) return "performance";
  if (normalized.includes("dead") || normalized.includes("unused")) return "dead-code";
  if (normalized.includes("regress")) return "regression";
  if (normalized.includes("contrast")) return "contrast";
  if (normalized.includes("schema") || normalized.includes("migration")) return "schema-drift";
  if (normalized.includes("api")) return "api-misuse";
  return "other";
}

function titleFrom(message: string): string {
  const firstSentence = message.split(/[.!?]\s/)[0] ?? message;
  return truncate(firstSentence.trim(), 120);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}

/** Factory helper for a new EpisodicEntry id (used by CLI / outcome-writer). */
export function newEpisodicId(): string {
  return `ep-${randomUUID()}`;
}
