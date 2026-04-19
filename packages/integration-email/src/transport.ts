export interface EmailMessage {
  from: string;
  to: string | readonly string[];
  subject: string;
  text: string;
  html?: string;
}

/**
 * EmailTransport — send one email. Pluggable so callers can swap the
 * default `ResendTransport` (HTTP, no SDK dep) for SMTP, SES, Postmark,
 * or any other provider via a thin adapter.
 */
export interface EmailTransport {
  readonly id: string;
  send(msg: EmailMessage): Promise<void>;
}

export interface HttpFetch {
  (url: string, init: { method: string; headers: Record<string, string>; body: string }): Promise<{
    ok: boolean;
    status: number;
    text: () => Promise<string>;
  }>;
}

export interface ResendTransportOptions {
  apiKey?: string;
  /** Injectable fetch for tests. */
  fetch?: HttpFetch;
  /** Base URL override (tests). Defaults to Resend API. */
  baseUrl?: string;
}

/**
 * ResendTransport — default transport. Uses Resend's REST API
 * (https://resend.com/docs/api-reference/emails/send-email). Single
 * POST call; no SDK dependency. Bearer-token auth via `RESEND_API_KEY`
 * env.
 *
 * To use a different provider:
 *   - SMTP: implement `EmailTransport` with nodemailer
 *   - SES: implement with @aws-sdk/client-ses
 *   - Postmark / SendGrid / Mailgun: implement with native fetch
 *
 * Pass your transport to `EmailNotifier` via `opts.transport`.
 */
export class ResendTransport implements EmailTransport {
  readonly id = "resend";
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: HttpFetch;

  constructor(opts: ResendTransportOptions = {}) {
    const key = opts.apiKey ?? process.env["RESEND_API_KEY"] ?? "";
    if (!key) throw new Error("ResendTransport: RESEND_API_KEY not set");
    this.apiKey = key;
    this.baseUrl = opts.baseUrl ?? "https://api.resend.com";
    this.fetchFn = opts.fetch ?? ((...args) => fetch(...(args as Parameters<typeof fetch>)) as ReturnType<HttpFetch>);
  }

  async send(msg: EmailMessage): Promise<void> {
    const to = Array.isArray(msg.to) ? [...msg.to] : [msg.to];
    const body: Record<string, unknown> = {
      from: msg.from,
      to,
      subject: msg.subject,
      text: msg.text,
    };
    if (msg.html) body["html"] = msg.html;
    const res = await this.fetchFn(`${this.baseUrl}/emails`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `ResendTransport: send failed (status ${res.status}): ${text.slice(0, 200)}`,
      );
    }
  }
}
