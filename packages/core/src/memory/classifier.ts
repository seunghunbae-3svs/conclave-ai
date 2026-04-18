import { createHash, randomUUID } from "node:crypto";
import type { EpisodicEntry, AnswerKey, FailureEntry } from "./schema.js";
import type { Blocker } from "../agent.js";

export type OutcomeResult = "merged" | "rejected" | "reworked";

export interface ClassificationOutput {
  answerKeys: AnswerKey[];
  failures: FailureEntry[];
}

export interface Classifier {
  classify(episodic: EpisodicEntry, outcome: OutcomeResult): ClassificationOutput;
}

/**
 * RuleBasedClassifier — deterministic extraction of answer-keys + failures
 * from an EpisodicEntry without an LLM call.
 *
 * Rules:
 *   - merged + all agents approved → one `AnswerKey` from the consensus
 *     summary. Pattern = `by-repo/<repo>`; tags derived from diff file
 *     extensions + blocker categories that appeared but were fixed.
 *   - rejected / reworked → one `FailureEntry` per unique (category, severity)
 *     blocker seen across all agent reviews. Title from blocker.message
 *     (first sentence), body combines message + file:line context.
 *
 * Haiku-backed classifier lands later as a drop-in replacement; interface
 * is stable.
 */
export class RuleBasedClassifier implements Classifier {
  classify(episodic: EpisodicEntry, outcome: OutcomeResult): ClassificationOutput {
    if (outcome === "merged") {
      return { answerKeys: [this.extractAnswerKey(episodic)], failures: [] };
    }
    return { answerKeys: [], failures: this.extractFailures(episodic) };
  }

  private extractAnswerKey(episodic: EpisodicEntry): AnswerKey {
    const summaries = episodic.reviews
      .map((r) => r.summary)
      .filter((s) => s && s.trim().length > 0)
      .slice(0, 3)
      .join(" | ");
    const lesson = summaries || `Merged without blockers — ${episodic.repo} #${episodic.pullNumber}`;
    const tags = this.deriveTags(episodic);
    const key: AnswerKey = {
      id: `ak-${shortHash(episodic.id + ":" + episodic.sha)}`,
      createdAt: episodic.createdAt,
      domain: "code",
      pattern: `by-repo/${episodic.repo}`,
      lesson,
      tags,
      repo: episodic.repo,
      episodicId: episodic.id,
    };
    return key;
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

  private deriveTags(episodic: EpisodicEntry): string[] {
    const tags = new Set<string>();
    for (const review of episodic.reviews) {
      for (const b of review.blockers) tags.add(b.category);
    }
    return [...tags];
  }
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

function mapCategory(raw: string): FailureEntry["category"] {
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
