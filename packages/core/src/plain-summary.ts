/**
 * Plain-language summary — v0.6.1.
 *
 * Routes every Conclave output (review verdict + audit report) through a
 * single cheap LLM call that rewrites the result in jargon-free prose a
 * non-developer (founder / PM / designer) can read on their phone.
 *
 * Why this exists:
 *   Bae's direct feedback: "PR에 달리는 Conclave의 audit 댓글이 비개발자
 *   언어로 요약해서 텔레그램으로 와야지. 뭘 바꿨는지도 나오고."
 *
 * Real users on the Telegram side aren't devs. Tier verdicts, severity
 * tags, categories like `workflow-security` are noise to them. This
 * module produces three short paragraphs:
 *   1. "What changed / what was audited"
 *   2. "Is there a problem or not"
 *   3. "What to do next"
 *
 * Not a council — one call, one model. claude-haiku-4-5 by default.
 * Estimated $0.001–0.005 per summary. Cached by hash(verdict + sha +
 * blocker fingerprints) so the same outcome never pays twice.
 */

export type PlainSummaryMode = "review" | "audit";

export type PlainSummaryVerdict = "approve" | "rework" | "reject";

export type PlainSummaryLocale = "en" | "ko";

export interface PlainSummarySubject {
  repo: string;
  prNumber?: number;
  issueNumber?: number;
  sha?: string;
  title?: string;
}

export interface PlainSummaryChanges {
  /** review mode — diff summary */
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  /** top 3-5 most-changed files (already pruned upstream) */
  topFiles: string[];
}

export interface PlainSummaryScope {
  /** audit mode — audit scope summary */
  filesAudited: number;
  filesInScope: number;
  categories: string[];
}

export interface PlainSummaryBlocker {
  severity: "major" | "minor";
  category: string;
  file?: string;
  oneLine: string;
}

export interface PlainSummaryInput {
  mode: PlainSummaryMode;
  verdict: PlainSummaryVerdict;
  subject: PlainSummarySubject;
  /** review mode — required when mode === "review" */
  changes?: PlainSummaryChanges;
  /** audit mode — required when mode === "audit" */
  scope?: PlainSummaryScope;
  blockers: PlainSummaryBlocker[];
  /** default "en" */
  locale?: PlainSummaryLocale;
}

export interface PlainSummary {
  /** 2-3 plain sentences */
  whatChanged: string;
  /** 1-2 plain sentences */
  verdictInPlain: string;
  /** 1-2 plain sentences */
  nextAction: string;
  /** full markdown-assembled text for direct posting */
  raw: string;
  /** locale the summary was produced in */
  locale: PlainSummaryLocale;
}

export interface PlainSummaryLlm {
  /**
   * Produce a single plain-text response for the given system + user
   * prompt. The caller manages model choice, temperature, token caps.
   */
  summarize(input: { system: string; user: string }): Promise<string>;
}

export interface PlainSummaryCache {
  get(key: string): PlainSummary | undefined;
  set(key: string, value: PlainSummary): void;
}

/**
 * Trivial in-memory LRU. Kept deliberately small (64 entries) — plain
 * summaries are tiny and one PR / audit rarely produces more than a few
 * distinct hashes in a single CLI lifetime.
 */
export class InMemoryPlainSummaryCache implements PlainSummaryCache {
  private readonly max: number;
  private readonly store = new Map<string, PlainSummary>();

  constructor(max = 64) {
    this.max = max;
  }

  get(key: string): PlainSummary | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    // LRU refresh — re-set so recent-use moves it to end of insertion order.
    this.store.delete(key);
    this.store.set(key, hit);
    return hit;
  }

  set(key: string, value: PlainSummary): void {
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, value);
    while (this.store.size > this.max) {
      const oldest = this.store.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }

  /** Test helper. */
  size(): number {
    return this.store.size;
  }
}

// ---- forbidden jargon (enforced post-generation) -------------------------

/**
 * Words that should not appear in a non-dev summary. The system prompt
 * tells the LLM to avoid them; as defence in depth we strip any that
 * slip through (match is case-insensitive, whole-word only).
 */
const FORBIDDEN_WORDS_EN: readonly string[] = [
  "tier",
  "blocker",
  "severity",
  "council",
  "verdict",
  "deliberation",
  "escalation",
  "rework",
];

const FORBIDDEN_WORDS_KO: readonly string[] = [
  // Korean equivalents rarely appear organically but we still strip.
  "블로커",
  "심각도",
  "티어",
  "평의회",
  "판결",
  "재작업",
];

// ---- hashing -------------------------------------------------------------

/**
 * Stable content-based cache key. Uses Web Crypto when available
 * (workerd / modern Node), falls back to node:crypto via dynamic import.
 * The key is the SHA-256 of a canonical JSON projection of the inputs
 * that meaningfully change the summary; changing an agent list or a
 * timestamp does NOT bust the cache (both irrelevant to the prose).
 */
export async function computePlainSummaryKey(input: PlainSummaryInput): Promise<string> {
  const canonical = canonicalizeForKey(input);
  return sha256Hex(canonical);
}

function canonicalizeForKey(input: PlainSummaryInput): string {
  // Blockers are sorted by severity then oneLine so reorder across runs
  // (council agents fire in parallel) doesn't bust the cache.
  const blockers = [...input.blockers]
    .sort((a, b) => {
      const sev = severityRank(a.severity) - severityRank(b.severity);
      if (sev !== 0) return sev;
      return a.oneLine.localeCompare(b.oneLine);
    })
    .map((b) => ({
      s: b.severity,
      c: b.category,
      f: b.file ?? "",
      l: b.oneLine,
    }));
  const payload = {
    m: input.mode,
    v: input.verdict,
    l: input.locale ?? "en",
    r: input.subject.repo,
    p: input.subject.prNumber ?? null,
    i: input.subject.issueNumber ?? null,
    sha: input.subject.sha ?? "",
    c: input.changes
      ? {
          f: input.changes.filesChanged,
          a: input.changes.linesAdded,
          d: input.changes.linesRemoved,
          t: [...input.changes.topFiles].sort(),
        }
      : null,
    sc: input.scope
      ? {
          a: input.scope.filesAudited,
          s: input.scope.filesInScope,
          cg: [...input.scope.categories].sort(),
        }
      : null,
    b: blockers,
  };
  return JSON.stringify(payload);
}

function severityRank(s: "major" | "minor"): number {
  return s === "major" ? 0 : 1;
}

interface SubtleLike {
  digest(alg: string, data: ArrayBuffer | Uint8Array): Promise<ArrayBuffer>;
}

async function sha256Hex(input: string): Promise<string> {
  // Prefer Web Crypto (works in Cloudflare Workers + Node 20+).
  const cryptoLike = (globalThis as { crypto?: { subtle?: SubtleLike } }).crypto;
  const maybeSubtle = cryptoLike?.subtle;
  if (maybeSubtle) {
    const bytes = new TextEncoder().encode(input);
    const digest = await maybeSubtle.digest("SHA-256", bytes);
    return bufferToHex(new Uint8Array(digest));
  }
  // Fallback for older Node — dynamic import so bundlers don't pull it in.
  const nodeCrypto = (await import("node:crypto")) as typeof import("node:crypto");
  return nodeCrypto.createHash("sha256").update(input).digest("hex");
}

function bufferToHex(buf: Uint8Array): string {
  let out = "";
  for (let i = 0; i < buf.length; i += 1) {
    out += (buf[i]! < 16 ? "0" : "") + buf[i]!.toString(16);
  }
  return out;
}

// ---- prompts -------------------------------------------------------------

function buildSystemPrompt(locale: PlainSummaryLocale): string {
  if (locale === "ko") {
    return [
      "너는 개발자가 아닌 사람(파운더, PM, 디자이너)에게 코드 리뷰 결과를 전달하는 요약 작성자다.",
      "반드시 지킬 규칙:",
      "- '티어', '블로커', '심각도', '평의회', '판결', '재작업' 같은 기술 용어 금지.",
      "- 대신 '변경', '문제', '고칠 것' 같은 일상 단어를 써라.",
      "- 이모지 금지. 마크다운 헤딩 금지. 불릿 리스트 금지.",
      "- 출력은 반드시 세 줄(세 문단)로 구성하고, 각 문단은 정확히 다음 접두어로 시작한다:",
      "  'WHAT: ' / 'VERDICT: ' / 'NEXT: '",
      "- 각 문단은 60단어를 넘지 않는다.",
      "- 존댓말이 아니라 '~한다/~했다' 식의 평어를 써라. 문체는 담백하고 단정적이다.",
    ].join("\n");
  }
  return [
    "You write short, jargon-free project updates for non-developers (founders, PMs, designers).",
    "Rules you MUST follow:",
    "- Never use: 'tier', 'blocker', 'severity', 'council', 'verdict', 'deliberation', 'escalation', 'rework'.",
    "- Use: 'change', 'issue', 'fix', 'ready', 'needs work'.",
    "- No emojis. No markdown headings. No bullet lists.",
    "- Output MUST be three short paragraphs, each starting with EXACTLY this prefix:",
    "  'WHAT: ' / 'VERDICT: ' / 'NEXT: '",
    "- Each paragraph stays under 60 words.",
    "- Plain conversational English. Direct, not salesy.",
  ].join("\n");
}

function buildUserPrompt(input: PlainSummaryInput): string {
  const lines: string[] = [];
  lines.push(`mode: ${input.mode}`);
  lines.push(`internal_verdict: ${input.verdict}`);
  lines.push(`repo: ${input.subject.repo}`);
  if (input.subject.prNumber !== undefined) lines.push(`pr_number: ${input.subject.prNumber}`);
  if (input.subject.issueNumber !== undefined)
    lines.push(`issue_number: ${input.subject.issueNumber}`);
  if (input.subject.sha) lines.push(`sha: ${input.subject.sha}`);
  if (input.subject.title) lines.push(`title: ${input.subject.title}`);

  if (input.mode === "review" && input.changes) {
    lines.push(
      `changes: ${input.changes.filesChanged} files, +${input.changes.linesAdded} / -${input.changes.linesRemoved} lines`,
    );
    if (input.changes.topFiles.length > 0) {
      lines.push(`top_changed_files: ${input.changes.topFiles.join(", ")}`);
    }
  } else if (input.mode === "audit" && input.scope) {
    lines.push(
      `audit_scope: ${input.scope.filesAudited} files audited of ${input.scope.filesInScope} in scope`,
    );
    if (input.scope.categories.length > 0) {
      lines.push(`categories: ${input.scope.categories.join(", ")}`);
    }
  }

  if (input.blockers.length === 0) {
    lines.push(`issues_found: none`);
  } else {
    lines.push(`issues_found: ${input.blockers.length}`);
    // Cap at 5 — LLM doesn't need the full list for a prose summary.
    const sample = input.blockers.slice(0, 5);
    sample.forEach((b, i) => {
      const loc = b.file ? ` [${b.file}]` : "";
      lines.push(`  ${i + 1}. ${b.category}${loc}: ${b.oneLine}`);
    });
    if (input.blockers.length > sample.length) {
      lines.push(`  … +${input.blockers.length - sample.length} more not shown`);
    }
  }

  lines.push("");
  lines.push(
    input.locale === "ko"
      ? "위 정보를 바탕으로 비개발자가 읽을 3문단 요약을 WHAT:/VERDICT:/NEXT: 접두어와 함께 작성하라."
      : "Using the data above, produce the three-paragraph plain summary with the WHAT:/VERDICT:/NEXT: prefixes.",
  );
  return lines.join("\n");
}

// ---- parsing + scrubbing -------------------------------------------------

/**
 * Extract the three sections from the LLM's raw text.
 * Tolerant of extra whitespace, markdown artifacts, different casing
 * ("what:" / "WHAT:" / "What —"), and missing sections (falls back to a
 * single paragraph split).
 */
export function parsePlainSummaryText(
  raw: string,
  locale: PlainSummaryLocale,
): { whatChanged: string; verdictInPlain: string; nextAction: string } {
  const cleaned = raw
    .replace(/^```[a-zA-Z]*\n/m, "")
    .replace(/\n```$/m, "")
    .trim();

  const whatMatch = pluckSection(cleaned, ["WHAT", "What", "what"]);
  const verdictMatch = pluckSection(cleaned, ["VERDICT", "Verdict", "verdict"]);
  const nextMatch = pluckSection(cleaned, ["NEXT", "Next", "next"]);

  if (whatMatch && verdictMatch && nextMatch) {
    return {
      whatChanged: scrubJargon(whatMatch, locale),
      verdictInPlain: scrubJargon(verdictMatch, locale),
      nextAction: scrubJargon(nextMatch, locale),
    };
  }
  // Fallback — split by blank lines, take first 3 paragraphs.
  const paragraphs = cleaned.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return {
    whatChanged: scrubJargon(paragraphs[0] ?? cleaned, locale),
    verdictInPlain: scrubJargon(paragraphs[1] ?? "", locale),
    nextAction: scrubJargon(paragraphs[2] ?? "", locale),
  };
}

function pluckSection(text: string, prefixes: readonly string[]): string | null {
  for (const p of prefixes) {
    // Matches "PREFIX:" or "PREFIX —" at the start of a line, captures until
    // next known prefix or end of string.
    const re = new RegExp(
      `(?:^|\\n)\\s*${p}\\s*[:\\-—]\\s*([\\s\\S]*?)(?=\\n\\s*(?:WHAT|VERDICT|NEXT|What|Verdict|Next|what|verdict|next)\\s*[:\\-—]|$)`,
    );
    const m = re.exec(text);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

function scrubJargon(text: string, locale: PlainSummaryLocale): string {
  if (!text) return text;
  let out = text;
  const list = locale === "ko" ? FORBIDDEN_WORDS_KO : FORBIDDEN_WORDS_EN;
  for (const w of list) {
    // whole-word replace, case-insensitive, only EN words need \b anchors.
    const isAscii = /^[a-zA-Z]+$/.test(w);
    const re = isAscii
      ? new RegExp(`\\b${escapeRegex(w)}\\b`, "gi")
      : new RegExp(escapeRegex(w), "g");
    out = out.replace(re, replacementFor(w, locale));
  }
  // Collapse any run of whitespace introduced by replacements.
  return out.replace(/[ \t]{2,}/g, " ").replace(/\s+([.,;:!?])/g, "$1").trim();
}

function replacementFor(word: string, locale: PlainSummaryLocale): string {
  // Keep the replacement sentence-safe. "rework" → "fix", "blocker" →
  // "issue", etc. Conservative — we would rather produce slightly awkward
  // prose than let jargon through.
  if (locale === "ko") {
    switch (word) {
      case "블로커":
        return "문제";
      case "심각도":
        return "중요도";
      case "티어":
        return "단계";
      case "평의회":
        return "리뷰";
      case "판결":
        return "결정";
      case "재작업":
        return "수정";
      default:
        return "";
    }
  }
  switch (word.toLowerCase()) {
    case "tier":
      return "step";
    case "blocker":
      return "issue";
    case "severity":
      return "importance";
    case "council":
      return "review";
    case "verdict":
      return "decision";
    case "deliberation":
      return "review";
    case "escalation":
      return "deeper review";
    case "rework":
      return "fix";
    default:
      return "";
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---- assembly ------------------------------------------------------------

function assembleRaw(
  sections: { whatChanged: string; verdictInPlain: string; nextAction: string },
  locale: PlainSummaryLocale,
  linkToFullReport?: string,
): string {
  const parts: string[] = [
    sections.whatChanged,
    sections.verdictInPlain,
    sections.nextAction,
  ].filter((s) => s && s.length > 0);
  let body = parts.join("\n\n");
  if (linkToFullReport) {
    body += locale === "ko"
      ? `\n\n전체 리포트: ${linkToFullReport}`
      : `\n\nFull report: ${linkToFullReport}`;
  }
  return body;
}

// ---- public entry --------------------------------------------------------

export interface GeneratePlainSummaryDeps {
  llm: PlainSummaryLlm;
  cache?: PlainSummaryCache;
  /**
   * Optional full-report link appended at the end of `raw` (e.g. GitHub
   * PR URL, issue URL). Not passed to the LLM — it's structural, not prose.
   */
  fullReportUrl?: string;
}

/**
 * Generate the plain-language summary for a Conclave output.
 *
 * Deterministic cache: same input → same output without re-invoking the
 * LLM. Forbidden-jargon scrubber is applied both pre-cache (stored
 * already-clean) and post-cache-miss (new generations).
 */
export async function generatePlainSummary(
  input: PlainSummaryInput,
  deps: GeneratePlainSummaryDeps,
): Promise<PlainSummary> {
  const locale: PlainSummaryLocale = input.locale ?? "en";
  const normalized: PlainSummaryInput = { ...input, locale };

  const key = await computePlainSummaryKey(normalized);
  const cached = deps.cache?.get(key);
  if (cached) {
    // Re-assemble raw in case the caller changed `fullReportUrl` between
    // calls with the same hash — the hash doesn't include it.
    return {
      ...cached,
      raw: assembleRaw(
        {
          whatChanged: cached.whatChanged,
          verdictInPlain: cached.verdictInPlain,
          nextAction: cached.nextAction,
        },
        locale,
        deps.fullReportUrl,
      ),
    };
  }

  const system = buildSystemPrompt(locale);
  const user = buildUserPrompt(normalized);
  const raw = await deps.llm.summarize({ system, user });

  const sections = parsePlainSummaryText(raw, locale);
  const result: PlainSummary = {
    whatChanged: sections.whatChanged,
    verdictInPlain: sections.verdictInPlain,
    nextAction: sections.nextAction,
    raw: assembleRaw(sections, locale, deps.fullReportUrl),
    locale,
  };

  deps.cache?.set(key, result);
  return result;
}
