/**
 * PIA-6 — classify Anthropic API errors into actionable categories.
 *
 * Pre-PIA-6 the autofix worker-error path returned raw `err.message`
 * blobs verbatim ("400 invalid_request_error: credit balance is too
 * low"), which:
 *   1. left the user guessing whether to retry, top up, fix their
 *      key, or file a bug,
 *   2. printed identical-looking messages to PR comments + Telegram
 *      across totally different operational issues,
 *   3. burned credit when transient overloads (529) were treated the
 *      same as terminal config errors (401 bad key).
 *
 * This module turns the raw error into a tagged classification with
 * a one-line *what to do* message. Pure — no I/O. Pattern-matches on
 * the SDK error message text since the Anthropic SDK's typed error
 * subclasses (BadRequestError, AuthenticationError, …) aren't
 * importable here without dragging the runtime dep into the CLI lib.
 */

export type AnthropicErrorKind =
  /** 401 — API key missing/invalid/expired. User must update ANTHROPIC_API_KEY. */
  | "auth"
  /** 403 — key valid but lacks permission for the model/feature. */
  | "permission"
  /** 400 with "credit balance" / "billing" — user must top up. */
  | "credit"
  /** 400 generic — malformed request (likely a bug in our prompt). */
  | "invalid-request"
  /** 404 — model not found (likely a stale model id). */
  | "not-found"
  /** 429 — rate limit hit. Transient. */
  | "rate-limit"
  /** 529 — service overloaded. Transient. */
  | "overloaded"
  /** 500-503 — server-side error. Transient. */
  | "server"
  /** Network / DNS / timeout — never reached the API. */
  | "transport"
  /** Unmatched. */
  | "unknown";

export interface AnthropicErrorClassification {
  kind: AnthropicErrorKind;
  /**
   * True when the error is likely to resolve on retry without user
   * intervention. Used by autofix to decide whether to retry the
   * same blocker or surface a terminal error.
   */
  retryable: boolean;
  /**
   * One-line user-facing message. Starts with the action the user
   * (or the autonomy loop) must take. No trailing period — appended
   * by the caller if needed.
   */
  userMessage: string;
  /** Original error text, truncated to 300 chars. */
  rawSnippet: string;
}

const SNIPPET_MAX = 300;

function snippet(err: unknown): string {
  const text =
    err instanceof Error
      ? err.message
      : typeof err === "string"
      ? err
      : (() => {
          try {
            return JSON.stringify(err);
          } catch {
            return String(err);
          }
        })();
  return text.length > SNIPPET_MAX ? text.slice(0, SNIPPET_MAX) + "…" : text;
}

function statusOf(err: unknown): number | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as { status?: unknown; statusCode?: unknown };
  if (typeof e.status === "number") return e.status;
  if (typeof e.statusCode === "number") return e.statusCode;
  return null;
}

export function classifyAnthropicError(err: unknown): AnthropicErrorClassification {
  const raw = snippet(err);
  const lower = raw.toLowerCase();
  const status = statusOf(err);

  // Network / transport — never made it to the API. Retryable.
  // Match on common Node error codes BEFORE status-based matching
  // because some transports stuff a numeric `code` that confuses
  // status detection (e.g. errno).
  if (
    /econnrefused|econnreset|etimedout|enotfound|eai_again|fetch failed|network error|getaddrinfo/i.test(
      raw,
    )
  ) {
    return {
      kind: "transport",
      retryable: true,
      userMessage:
        "Network error reaching Anthropic — retry in a moment. If it persists, check connectivity / DNS",
      rawSnippet: raw,
    };
  }

  // Status-based classification.
  if (status === 401 || /401|authentication_error|invalid.+(api.?key|x-api-key)/i.test(raw)) {
    return {
      kind: "auth",
      retryable: false,
      userMessage:
        "Anthropic API key is invalid or expired — update ANTHROPIC_API_KEY in repo / org secrets",
      rawSnippet: raw,
    };
  }
  if (status === 403 || /403|permission_denied|permission_error/i.test(raw)) {
    return {
      kind: "permission",
      retryable: false,
      userMessage:
        "API key lacks permission for this model — verify your Anthropic plan / model allowlist",
      rawSnippet: raw,
    };
  }
  // Credit balance / billing errors arrive as 400 invalid_request_error
  // with a message containing "credit balance" or "billing".
  if (
    /credit balance|insufficient.+credit|insufficient.+balance|billing|payment.+required/i.test(
      lower,
    )
  ) {
    return {
      kind: "credit",
      retryable: false,
      userMessage:
        "Anthropic credit balance too low — top up at console.anthropic.com/settings/billing",
      rawSnippet: raw,
    };
  }
  if (status === 400 || /400|invalid_request_error/i.test(raw)) {
    return {
      kind: "invalid-request",
      retryable: false,
      userMessage:
        "Anthropic rejected the request as malformed — likely a bug in conclave's prompt construction; file an issue with the snippet",
      rawSnippet: raw,
    };
  }
  if (status === 404 || /404|not_found_error|model.+not.+found/i.test(raw)) {
    return {
      kind: "not-found",
      retryable: false,
      userMessage:
        "Anthropic model not found — likely a stale model id; update your CLI to the latest version",
      rawSnippet: raw,
    };
  }
  if (status === 429 || /429|rate_limit_error|rate limit/i.test(raw)) {
    return {
      kind: "rate-limit",
      retryable: true,
      userMessage:
        "Anthropic rate limit hit — autofix will retry with backoff; consider upgrading your tier if frequent",
      rawSnippet: raw,
    };
  }
  if (status === 529 || /529|overloaded_error|overloaded/i.test(raw)) {
    return {
      kind: "overloaded",
      retryable: true,
      userMessage:
        "Anthropic is overloaded (529) — autofix will retry; if it persists, retry the rework dispatch later",
      rawSnippet: raw,
    };
  }
  if (
    (status !== null && status >= 500 && status < 600) ||
    /\b5\d\d\b|api_error|internal_server_error|service_unavailable|bad_gateway|gateway_timeout/i.test(
      raw,
    )
  ) {
    return {
      kind: "server",
      retryable: true,
      userMessage:
        "Anthropic server error — transient; autofix will retry, then defer to the next review.yml run",
      rawSnippet: raw,
    };
  }

  return {
    kind: "unknown",
    retryable: false,
    userMessage:
      "Worker call failed with an unrecognised error — see raw snippet; if it recurs, file an issue",
    rawSnippet: raw,
  };
}

/**
 * Build a one-line reason string that bundles the kind tag + actionable
 * message + raw snippet. Use this when populating BlockerFix.reason so
 * the PR comment renderer can show "[anthropic:credit] top up at …
 * (raw: 400 invalid_request_error credit balance is too low)".
 */
export function formatClassifiedReason(c: AnthropicErrorClassification): string {
  return `[anthropic:${c.kind}${c.retryable ? ":retryable" : ""}] ${c.userMessage} (raw: ${c.rawSnippet})`;
}
