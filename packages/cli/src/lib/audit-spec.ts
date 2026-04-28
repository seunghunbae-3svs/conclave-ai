/**
 * Spec-vs-code gap analysis for `conclave audit --spec <path>`.
 *
 * H1.5 C of the dev-roadmap: a feature-gap auditor that reads a
 * markdown spec (bullet list of intended features) and classifies
 * each bullet as PRESENT / PARTIAL / MISSING against the codebase.
 *
 * Hermetic by design — the classifier is a pure function over an
 * in-memory file list, so unit tests run without filesystem or LLM
 * access. The audit-command wrapper handles I/O.
 */

export type SpecStatus = "PRESENT" | "PARTIAL" | "MISSING";

export interface SpecFeature {
  raw: string;
  title: string;
  keywords: string[];
}

export interface SpecClassification {
  feature: SpecFeature;
  status: SpecStatus;
  hits: number;
  matchedFiles: string[];
  notes: string;
}

export interface SpecReport {
  specPath: string;
  features: SpecClassification[];
  presentCount: number;
  partialCount: number;
  missingCount: number;
}

const STOP_WORDS: ReadonlySet<string> = new Set([
  "that",
  "this",
  "with",
  "from",
  "when",
  "will",
  "must",
  "should",
  "into",
  "your",
  "have",
  "support",
  "allow",
  "than",
  "they",
  "them",
  "their",
  "there",
  "then",
  "where",
  "what",
  "which",
  "while",
  "user",
  "users",
  "page",
  "pages",
  "system",
  "feature",
  "features",
  "able",
]);

/**
 * Parse markdown text into spec features. Recognises any list bullet
 * (`-`, `*`, `+`) at any indent depth. Headings, blank lines, and
 * non-bullet prose are skipped. A bullet's title is the bullet text
 * with leading inline-code/link clutter trimmed and capped at 80
 * chars; keywords are ≥4-char lowercase tokens minus stop-words.
 */
export function parseSpecMarkdown(md: string): SpecFeature[] {
  const features: SpecFeature[] = [];
  const lines = md.split(/\r?\n/);
  for (const raw of lines) {
    const m = raw.match(/^\s*[-*+]\s+(.+?)\s*$/);
    if (!m || !m[1]) continue;
    const text = m[1].replace(/^[*_`]+|[*_`]+$/g, "").trim();
    if (!text) continue;
    const title = text.length > 80 ? text.slice(0, 77) + "..." : text;
    const keywords = extractKeywords(text);
    features.push({ raw: raw.trim(), title, keywords });
  }
  return features;
}

function extractKeywords(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4 && !STOP_WORDS.has(t));
  return [...new Set(tokens)];
}

export interface ClassifyInputFile {
  path: string;
  content: string;
}

/**
 * Classify one feature against the in-memory file list. Pragmatic
 * deterministic heuristic — no LLM. Path matches weighted ×3 because
 * a filename like `auth-login.ts` is a stronger signal of presence
 * than a single token in a long body of unrelated code.
 *
 * Decision boundaries (tuned on hand-crafted examples):
 *   totalHits === 0                         → MISSING
 *   ≥2 distinct files & hits ≥ max(3, 2k)   → PRESENT     (k = keyword count)
 *   otherwise                                → PARTIAL
 *
 * `notes` summarises the evidence so a reader can spot false positives.
 */
export function classifySpecFeature(
  feature: SpecFeature,
  files: ClassifyInputFile[],
): SpecClassification {
  if (feature.keywords.length === 0) {
    return {
      feature,
      status: "MISSING",
      hits: 0,
      matchedFiles: [],
      notes: "no extractable keywords (bullet too short / all stop-words)",
    };
  }
  const perFile: Array<{ path: string; hits: number }> = [];
  for (const f of files) {
    let hits = 0;
    const pathLower = f.path.toLowerCase();
    const contentLower = f.content.toLowerCase();
    for (const kw of feature.keywords) {
      hits += countOccurrences(pathLower, kw) * 3;
      hits += countOccurrences(contentLower, kw);
    }
    if (hits > 0) perFile.push({ path: f.path, hits });
  }
  perFile.sort((a, b) => b.hits - a.hits);
  const totalHits = perFile.reduce((s, x) => s + x.hits, 0);
  const matchedFiles = perFile.slice(0, 5).map((x) => x.path);
  const distinctFiles = perFile.length;
  const k = feature.keywords.length;
  const presentThreshold = Math.max(3, 2 * k);

  let status: SpecStatus;
  if (totalHits === 0) status = "MISSING";
  else if (distinctFiles >= 2 && totalHits >= presentThreshold) status = "PRESENT";
  else status = "PARTIAL";

  const top = matchedFiles.slice(0, 3).join(", ");
  const notes =
    totalHits === 0
      ? `no matches for keywords [${feature.keywords.slice(0, 5).join(", ")}]`
      : `${totalHits} hit(s) across ${distinctFiles} file(s)${top ? `; top: ${top}` : ""}`;

  return { feature, status, hits: totalHits, matchedFiles, notes };
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count += 1;
    idx += needle.length;
  }
  return count;
}

export function buildSpecReport(
  specPath: string,
  classifications: SpecClassification[],
): SpecReport {
  let p = 0;
  let pa = 0;
  let m = 0;
  for (const c of classifications) {
    if (c.status === "PRESENT") p += 1;
    else if (c.status === "PARTIAL") pa += 1;
    else m += 1;
  }
  return {
    specPath,
    features: classifications,
    presentCount: p,
    partialCount: pa,
    missingCount: m,
  };
}

export function renderSpecStdout(r: SpecReport): string {
  const lines: string[] = [];
  lines.push(`Spec gap analysis — ${r.specPath}`);
  lines.push(
    `  ${r.features.length} features: ${r.presentCount} present / ${r.partialCount} partial / ${r.missingCount} missing`,
  );
  lines.push("");
  for (const c of r.features) {
    lines.push(`  [${c.status.padEnd(7)}] ${c.feature.title}`);
    lines.push(`             ${c.notes}`);
  }
  return lines.join("\n") + "\n";
}

export function renderSpecIssueBody(r: SpecReport): string {
  const lines: string[] = [];
  lines.push("## Spec vs Code Gap Analysis");
  lines.push("");
  lines.push(
    `**${r.features.length} features** — ${r.presentCount} present / ${r.partialCount} partial / ${r.missingCount} missing`,
  );
  lines.push("");
  lines.push(`Spec source: \`${r.specPath}\``);
  lines.push("");

  const sections: Array<[SpecStatus, string]> = [
    ["MISSING", "### Missing"],
    ["PARTIAL", "### Partial"],
    ["PRESENT", "### Present"],
  ];
  for (const [status, heading] of sections) {
    const items = r.features.filter((c) => c.status === status);
    if (items.length === 0) continue;
    lines.push(heading);
    for (const c of items) {
      const checkbox = status === "PRESENT" ? "[x]" : "[ ]";
      lines.push(`- ${checkbox} **${c.feature.title}** — ${c.notes}`);
    }
    lines.push("");
  }
  lines.push(
    "*Generated by `conclave audit --spec`. PARTIAL = some keyword overlap; review manually.*",
  );
  return lines.join("\n") + "\n";
}
