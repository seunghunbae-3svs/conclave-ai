import type { Notifier, NotifyReviewInput } from "@conclave-ai/core";
import { formatReviewForSlack } from "./format.js";

export interface HttpFetch {
  (url: string, init: { method: string; headers: Record<string, string>; body: string }): Promise<{
    ok: boolean;
    status: number;
    text: () => Promise<string>;
  }>;
}

export interface SlackNotifierOptions {
  /** Incoming webhook URL (or set via SLACK_WEBHOOK_URL env). */
  webhookUrl?: string;
  /** Override display username. */
  username?: string;
  /** Override icon URL or emoji. At most one used; url wins if both set. */
  iconUrl?: string;
  iconEmoji?: string;
  /** Inject fetch for tests. */
  fetch?: HttpFetch;
}

const DEFAULT_USERNAME = "Conclave AI";

/**
 * SlackNotifier — posts review outcomes to a Slack channel via incoming
 * webhook. Same pattern as `@conclave-ai/integration-discord` — write-only,
 * no OAuth.
 */
export class SlackNotifier implements Notifier {
  readonly id = "slack";
  readonly displayName = "Slack";

  private readonly webhookUrl: string;
  private readonly username: string;
  private readonly iconUrl: string | undefined;
  private readonly iconEmoji: string | undefined;
  private readonly fetchFn: HttpFetch;

  constructor(opts: SlackNotifierOptions = {}) {
    const url = opts.webhookUrl ?? process.env["SLACK_WEBHOOK_URL"] ?? "";
    if (!url) {
      throw new Error("SlackNotifier: SLACK_WEBHOOK_URL not set (pass opts.webhookUrl or env)");
    }
    if (!/^https:\/\/hooks\.slack\.com\/services\//i.test(url)) {
      throw new Error("SlackNotifier: webhookUrl must be an https://hooks.slack.com/services/... URL");
    }
    this.webhookUrl = url;
    this.username = opts.username ?? DEFAULT_USERNAME;
    this.iconUrl = opts.iconUrl;
    this.iconEmoji = opts.iconEmoji;
    this.fetchFn =
      opts.fetch ?? ((...args) => fetch(...(args as Parameters<typeof fetch>)) as ReturnType<HttpFetch>);
  }

  async notifyReview(input: NotifyReviewInput): Promise<void> {
    const payload = formatReviewForSlack(input);
    payload.username = this.username;
    if (this.iconUrl) payload.icon_url = this.iconUrl;
    else if (this.iconEmoji) payload.icon_emoji = this.iconEmoji;

    const res = await this.fetchFn(this.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `SlackNotifier: webhook POST failed (status ${res.status}): ${text.slice(0, 200)}`,
      );
    }
  }
}
