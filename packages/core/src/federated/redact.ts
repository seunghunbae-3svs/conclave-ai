import { createHash } from "node:crypto";
import type { AnswerKey, FailureEntry } from "../memory/schema.js";
import type { FederatedBaseline, FederatedBaselineKind } from "./schema.js";

/**
 * normalizeTags — deterministic tag vocabulary.
 * Same tag set across users must produce the same output so downstream
 * `contentHash` is stable.
 */
export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const raw of tags) {
    const t = raw.trim().toLowerCase();
    if (t.length > 0) seen.add(t);
  }
  return Array.from(seen).sort();
}

function dayBucket(iso: string): string {
  return iso.slice(0, 10);
}

function baselineHash(
  kind: FederatedBaselineKind,
  domain: string,
  category: string | undefined,
  severity: string | undefined,
  normalizedTags: readonly string[],
): string {
  const tuple = JSON.stringify([kind, domain, category ?? "", severity ?? "", normalizedTags]);
  return createHash("sha256").update(tuple).digest("hex");
}

/**
 * Redact an AnswerKey into the minimal shape that may leave the
 * machine. `lesson`, `repo`, `user`, `pattern`, and `episodicId` are
 * dropped entirely.
 */
export function redactAnswerKey(key: AnswerKey): FederatedBaseline {
  const tags = normalizeTags(key.tags);
  return {
    version: 1,
    kind: "answer-key",
    contentHash: baselineHash("answer-key", key.domain, undefined, undefined, tags),
    domain: key.domain,
    tags,
    dayBucket: dayBucket(key.createdAt),
  };
}

/**
 * Redact a FailureEntry. `title`, `body`, `snippet`, `seedBlocker`, and
 * `episodicId` are dropped entirely — only category/severity/tags/hash
 * leave.
 */
export function redactFailure(entry: FailureEntry): FederatedBaseline {
  const tags = normalizeTags(entry.tags);
  return {
    version: 1,
    kind: "failure",
    contentHash: baselineHash("failure", entry.domain, entry.category, entry.severity, tags),
    domain: entry.domain,
    category: entry.category,
    severity: entry.severity,
    tags,
    dayBucket: dayBucket(entry.createdAt),
  };
}

/** Tiny batch helper — redacts a mixed list. */
export function redactAll(
  answerKeys: readonly AnswerKey[],
  failures: readonly FailureEntry[],
): FederatedBaseline[] {
  return [...answerKeys.map(redactAnswerKey), ...failures.map(redactFailure)];
}
