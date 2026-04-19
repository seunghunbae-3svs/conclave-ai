import type { Notifier, NotifyReviewInput } from "@conclave-ai/core";
import { formatReviewForDiscord } from "./format.js";

export interface HttpFetch {
  (url: string, init: { method: string; headers: Record<string, string>; body: string }): Promise<{
    ok: boolean;
    status: number;
    text: () => Promise<string>;
  }>;
}

export interface DiscordNotifierOptions {
  /** Incoming webhook URL (or set via DISCORD_WEBHOOK_URL env). */
  webhookUrl?: string;
  /** Override display username on the message. */
  username?: string;
  /** Override avatar URL on the message. */
  avatarUrl?: string;
  /** Inject fetch for tests. */
  fetch?: HttpFetch;
}

const DEFAULT_USERNAME = "Conclave AI";

/**
 * DiscordNotifier — posts review outcomes to a Discord channel via
 * incoming webhook.
 *
 * Discord webhooks are much simpler than bot API (no token, no chat id,
 * just the webhook URL). We use a single-embed payload with color-coded
 * verdict. If inbound interactivity is later required (slash commands,
 * button clicks), a separate bot package can be added.
 */
export class DiscordNotifier implements Notifier {
  readonly id = "discord";
  readonly displayName = "Discord";

  private readonly webhookUrl: string;
  private readonly username: string;
  private readonly avatarUrl: string | undefined;
  private readonly fetchFn: HttpFetch;

  constructor(opts: DiscordNotifierOptions = {}) {
    const url = opts.webhookUrl ?? process.env["DISCORD_WEBHOOK_URL"] ?? "";
    if (!url) {
      throw new Error("DiscordNotifier: DISCORD_WEBHOOK_URL not set (pass opts.webhookUrl or env)");
    }
    if (!/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//i.test(url)) {
      throw new Error(
        "DiscordNotifier: webhookUrl must be an https://discord.com/api/webhooks/... URL",
      );
    }
    this.webhookUrl = url;
    this.username = opts.username ?? DEFAULT_USERNAME;
    this.avatarUrl = opts.avatarUrl;
    this.fetchFn =
      opts.fetch ?? ((...args) => fetch(...(args as Parameters<typeof fetch>)) as ReturnType<HttpFetch>);
  }

  async notifyReview(input: NotifyReviewInput): Promise<void> {
    const payload = formatReviewForDiscord(input);
    payload.username = this.username;
    if (this.avatarUrl) payload.avatar_url = this.avatarUrl;

    const res = await this.fetchFn(this.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `DiscordNotifier: webhook POST failed (status ${res.status}): ${text.slice(0, 200)}`,
      );
    }
  }
}
