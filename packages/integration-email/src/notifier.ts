import type { Notifier, NotifyReviewInput } from "@ai-conclave/core";
import { renderEmail } from "./format.js";
import { ResendTransport, type EmailTransport, type HttpFetch } from "./transport.js";

export interface EmailNotifierOptions {
  /** From address (or set via CONCLAVE_EMAIL_FROM). */
  from?: string;
  /** Recipient(s). Comma-split CONCLAVE_EMAIL_TO env when omitted. */
  to?: string | readonly string[];
  /** Override subject template. Default: "[conclave] VERDICT — repo #N". */
  subjectOverride?: string;
  /** Injected transport. Default: ResendTransport. */
  transport?: EmailTransport;
  /** Fetch injection for the default transport. */
  fetch?: HttpFetch;
  /** Only used when constructing default Resend transport. */
  resendApiKey?: string;
}

/**
 * EmailNotifier — implements `Notifier` using a pluggable transport.
 *
 * Decision #24: equal-weight integration. Email rounds out the
 * write-only notification family alongside Telegram / Discord / Slack.
 *
 * Transport defaults to `ResendTransport` (minimal, no SDK dep). Swap
 * via `opts.transport` for SMTP / SES / Postmark / SendGrid / etc.
 */
export class EmailNotifier implements Notifier {
  readonly id = "email";
  readonly displayName = "Email";

  private readonly from: string;
  private readonly to: readonly string[];
  private readonly subjectOverride: string | undefined;
  private readonly transport: EmailTransport;

  constructor(opts: EmailNotifierOptions = {}) {
    const from = opts.from ?? process.env["CONCLAVE_EMAIL_FROM"] ?? "";
    const rawTo =
      opts.to !== undefined
        ? opts.to
        : (process.env["CONCLAVE_EMAIL_TO"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const to = Array.isArray(rawTo) ? [...rawTo] : [rawTo as string];
    if (!from) throw new Error("EmailNotifier: from address not set (pass opts.from or CONCLAVE_EMAIL_FROM)");
    if (to.length === 0) throw new Error("EmailNotifier: to recipient(s) not set (pass opts.to or CONCLAVE_EMAIL_TO)");
    this.from = from;
    this.to = to;
    this.subjectOverride = opts.subjectOverride;
    if (opts.transport) {
      this.transport = opts.transport;
    } else {
      const transOpts: ConstructorParameters<typeof ResendTransport>[0] = {};
      if (opts.resendApiKey) transOpts.apiKey = opts.resendApiKey;
      if (opts.fetch) transOpts.fetch = opts.fetch;
      this.transport = new ResendTransport(transOpts);
    }
  }

  async notifyReview(input: NotifyReviewInput): Promise<void> {
    const rendered = renderEmail(input);
    await this.transport.send({
      from: this.from,
      to: this.to,
      subject: this.subjectOverride ?? rendered.subject,
      text: rendered.text,
      html: rendered.html,
    });
  }
}
