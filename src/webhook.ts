import { createHmac } from "node:crypto";

export type WebhookEventName = "bug.created" | "bug.changed" | "webhook.test";

export interface WebhookBug {
  id: number;
  summary: string;
  status: string;
  creation_time?: string;
  last_change_time?: string;
}

export interface WebhookPayload {
  event: WebhookEventName;
  instance: string;
  firedAt: string;
  bugs: WebhookBug[];
}

export interface WebhookDeliveryStatus {
  event: WebhookEventName;
  at: string;
  ok: boolean;
  httpStatus?: number;
  attempts: number;
  error?: string;
}

export interface WebhookConfig {
  url?: string;
  secret?: string;
  enabled: boolean;
}

export function signPayload(secret: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

const RETRY_DELAYS_MS = [1_000, 5_000, 25_000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class WebhookSender {
  private config: WebhookConfig;
  lastDelivery: WebhookDeliveryStatus | null = null;

  constructor(
    config: WebhookConfig,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly retryDelaysMs: number[] = RETRY_DELAYS_MS,
  ) {
    this.config = { ...config };
  }

  configure(patch: Partial<WebhookConfig>): void {
    this.config = { ...this.config, ...patch };
  }

  get enabled(): boolean {
    return this.config.enabled && !!this.config.url;
  }

  get url(): string | undefined {
    return this.config.url;
  }

  get secretSet(): boolean {
    return !!this.config.secret;
  }

  async send(
    event: WebhookEventName,
    instance: string,
    bugs: WebhookBug[],
  ): Promise<WebhookDeliveryStatus | null> {
    if (!this.enabled || !this.config.url) return null;
    const payload: WebhookPayload = {
      event,
      instance,
      firedAt: new Date().toISOString(),
      bugs,
    };
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.secret) {
      headers["X-Webhook-Signature"] = signPayload(this.config.secret, body);
    }
    const status: WebhookDeliveryStatus = {
      event,
      at: payload.firedAt,
      ok: false,
      attempts: 0,
    };
    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt++) {
      status.attempts = attempt + 1;
      try {
        const res = await this.fetchFn(this.config.url, {
          method: "POST",
          headers,
          body,
        });
        status.httpStatus = res.status;
        if (res.ok) {
          status.ok = true;
          delete status.error;
          break;
        }
        status.error = `HTTP ${res.status}`;
      } catch (err) {
        status.error = err instanceof Error ? err.message : String(err);
      }
      if (attempt < this.retryDelaysMs.length) {
        await sleep(this.retryDelaysMs[attempt]);
      }
    }
    this.lastDelivery = status;
    if (!status.ok) {
      console.error(`[webhook] ${event} delivery failed after ${status.attempts} attempt(s): ${status.error}`);
    } else {
      console.log(`[webhook] delivered ${event} (${bugs.length} bug(s))`);
    }
    return status;
  }
}
