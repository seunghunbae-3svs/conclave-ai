export interface SecretRule {
  /**
   * Stable identifier — used for `--allow <ruleId>` and for suppression
   * comments. Don't rename after release; callers may pin to specific ids.
   */
  id: string;
  /** Human-friendly name shown in findings. */
  name: string;
  /**
   * Regex pattern. Authors must NOT set sticky/global flags here — the
   * scanner controls iteration itself. Case sensitivity is on by default
   * because most real secrets are case-specific (`AKIA` prefix, etc).
   */
  pattern: RegExp;
  /**
   * Confidence the match is a real secret. "high" patterns block by
   * default; "medium" are reported but don't block unless the caller
   * opts in; "low" are reported only on explicit request.
   */
  confidence: "high" | "medium" | "low";
  /** One-line description for CLI/UI rendering. */
  description: string;
}

export interface SecretFinding {
  ruleId: string;
  ruleName: string;
  confidence: "high" | "medium" | "low";
  /** 1-based line number within the scanned text. */
  line: number;
  /** 0-based column of the first character of the match. */
  column: number;
  /** Redacted preview — never the raw secret. */
  preview: string;
  /** Repo-relative file path, when the caller provided one. */
  file?: string;
}

export interface ScanOptions {
  /** Optional repo-relative path, threaded into the finding for UX. */
  file?: string;
  /** Rule ids to skip (allow-list). */
  allow?: readonly string[];
  /** Rule overrides — defaults to DEFAULT_RULES. */
  rules?: readonly SecretRule[];
  /**
   * When false (default), medium- and low-confidence rules are evaluated
   * but their findings are not returned. Set to true to surface them.
   */
  includeLowConfidence?: boolean;
}

export interface ScanResult {
  findings: SecretFinding[];
  /** True iff at least one high-confidence finding was returned. */
  blocked: boolean;
}
