import type { SecretRule } from "./types.js";

/**
 * Default rule set. Kept deliberately narrow: every rule is a pattern we
 * can explain in one line and where a match almost always means "this is
 * a real secret." Broader heuristic patterns (entropy checks, generic
 * base64 strings) go behind `confidence: "medium" | "low"` so the worker
 * never blocks a commit on a false positive.
 *
 * Rule authors: do NOT add /g, /y, or /m flags — the scanner drives the
 * iteration. Trailing word-boundary anchors are the recommended way to
 * end a fixed-width match.
 */
export const DEFAULT_RULES: readonly SecretRule[] = [
  {
    id: "aws-access-key",
    name: "AWS Access Key ID",
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
    confidence: "high",
    description: "IAM access key (format AKIA + 16 uppercase alnum)",
  },
  {
    id: "aws-secret-access-key-labeled",
    name: "AWS Secret Access Key (labeled)",
    // Only catch when the line clearly names it — the raw 40-char base64
    // pattern is too false-positive-heavy for a `high` rule.
    pattern: /aws_secret_access_key\s*[:=]\s*['"]?([A-Za-z0-9/+=]{40})['"]?/i,
    confidence: "high",
    description: "A line literally labelled aws_secret_access_key followed by a 40-char value",
  },
  {
    id: "openai-key",
    name: "OpenAI API Key",
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
    confidence: "high",
    description: "OpenAI API or project key (sk- / sk-proj- prefix)",
  },
  {
    id: "anthropic-key",
    name: "Anthropic API Key",
    pattern: /\bsk-ant-api03-[A-Za-z0-9_-]{50,}\b/,
    confidence: "high",
    description: "Anthropic Claude API key (sk-ant-api03- prefix)",
  },
  {
    id: "github-pat-classic",
    name: "GitHub Personal Access Token (classic)",
    pattern: /\bghp_[A-Za-z0-9]{36}\b/,
    confidence: "high",
    description: "GitHub PAT classic (ghp_ prefix, 36 alnum)",
  },
  {
    id: "github-pat-fine-grained",
    name: "GitHub Fine-Grained PAT",
    pattern: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/,
    confidence: "high",
    description: "GitHub fine-grained PAT (github_pat_ prefix)",
  },
  {
    id: "github-app-token",
    name: "GitHub App / OAuth Token",
    pattern: /\bgh[oasu]_[A-Za-z0-9]{36}\b/,
    confidence: "high",
    description: "GitHub OAuth/App/Server/User token (gho_/ghs_/ghu_/gha_ prefix)",
  },
  {
    id: "slack-webhook",
    name: "Slack Incoming Webhook URL",
    pattern: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/,
    confidence: "high",
    description: "Slack incoming webhook — full URL including signing segment",
  },
  {
    id: "discord-webhook",
    name: "Discord Webhook URL",
    pattern: /https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]{40,}/,
    confidence: "high",
    description: "Discord webhook URL",
  },
  {
    id: "telegram-bot-token",
    name: "Telegram Bot Token",
    pattern: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/,
    confidence: "high",
    description: "Telegram bot API token (bot id + 35-char signing segment)",
  },
  {
    id: "google-api-key",
    name: "Google API Key",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/,
    confidence: "high",
    description: "Google Cloud / Firebase / Maps API key (AIza prefix)",
  },
  {
    id: "npm-token",
    name: "npm Access Token",
    pattern: /\bnpm_[A-Za-z0-9]{36}\b/,
    confidence: "high",
    description: "npm automation / publish token (npm_ prefix)",
  },
  {
    id: "stripe-live-key",
    name: "Stripe Live Secret Key",
    pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{24,}\b/,
    confidence: "high",
    description: "Stripe live-mode secret or restricted key",
  },
  {
    id: "private-key-block",
    name: "PEM Private Key Block",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY-----/,
    confidence: "high",
    description: "Any PEM-encoded private key header",
  },
  {
    id: "jwt",
    name: "JSON Web Token",
    // JWTs are sometimes public (signed but not secret) — medium only.
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
    confidence: "medium",
    description: "JWT-shaped string (3 dot-delimited base64url segments)",
  },
  {
    id: "generic-password-assignment",
    name: "Generic password assignment",
    pattern: /\b(?:password|passwd|api[_-]?key|secret)\s*[:=]\s*['"][^'"\n]{8,}['"]/i,
    confidence: "low",
    description: "A variable named password/api_key/secret with a string literal value (high FP rate)",
  },
];
