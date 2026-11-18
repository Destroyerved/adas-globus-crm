export * from './microsoft-graph.js';

export interface OutboundEmailPayload {
  idempotencyKey: string;
  fromEmail: string;
  toEmail: string;
  ccEmails?: string[];
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  headers?: Record<string, string>;
}

export interface OutboundEmailReceipt {
  provider: 'mailpit' | 'microsoft_graph' | 'esp_bulk';
  providerMessageId: string;
  internetMessageId?: string;
  sentAt: string;
}

export interface MailboxProvider {
  sendOneToOne(payload: OutboundEmailPayload): Promise<OutboundEmailReceipt>;
}

export interface BulkSender {
  sendCampaignMessage(payload: OutboundEmailPayload): Promise<OutboundEmailReceipt>;
}

/**
 * PRD §8.7 & AGENTS.md §5 / §10:
 * Non-production mail ALWAYS goes to Mailpit. Never send real email outside production.
 */
export class MailpitTransport implements MailboxProvider, BulkSender {
  private readonly sentMessages: Array<OutboundEmailPayload & OutboundEmailReceipt> = [];

  constructor(
    private readonly mailLive = false,
    private readonly nodeEnv = 'development',
    private readonly mailpitHttpUrl?: string,
  ) {
    if (this.mailLive && this.nodeEnv !== 'production') {
      throw new Error('Safety guard: MAIL_LIVE cannot be enabled outside production');
    }
  }

  async sendOneToOne(payload: OutboundEmailPayload): Promise<OutboundEmailReceipt> {
    const receipt: OutboundEmailReceipt = {
      provider: 'mailpit',
      providerMessageId: `mailpit_1to1_${payload.idempotencyKey}`,
      internetMessageId: `<${payload.idempotencyKey}@mailpit.adas-crm.local>`,
      sentAt: new Date().toISOString(),
    };
    await this.deliverToLocalMailpitIfRunning(payload);
    this.sentMessages.push({ ...payload, ...receipt });
    return receipt;
  }

  async sendCampaignMessage(payload: OutboundEmailPayload): Promise<OutboundEmailReceipt> {
    const receipt: OutboundEmailReceipt = {
      provider: 'mailpit',
      providerMessageId: `mailpit_bulk_${payload.idempotencyKey}`,
      internetMessageId: `<${payload.idempotencyKey}@mailpit.adas-crm.local>`,
      sentAt: new Date().toISOString(),
    };
    await this.deliverToLocalMailpitIfRunning(payload);
    this.sentMessages.push({ ...payload, ...receipt });
    return receipt;
  }

  getSentMessages(): ReadonlyArray<OutboundEmailPayload & OutboundEmailReceipt> {
    return this.sentMessages;
  }

  clearSentMessages(): void {
    this.sentMessages.length = 0;
  }

  private async deliverToLocalMailpitIfRunning(payload: OutboundEmailPayload): Promise<void> {
    if (!this.mailpitHttpUrl || this.nodeEnv === 'test') return;
    const url = `${this.mailpitHttpUrl.replace(/\/+$/, '')}/api/v1/send`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 750);
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          From: { Email: payload.fromEmail },
          To: [{ Email: payload.toEmail }],
          Cc: (payload.ccEmails ?? []).map((email) => ({ Email: email })),
          Subject: payload.subject,
          Text: payload.bodyText,
          HTML: payload.bodyHtml ?? '',
          Headers: payload.headers ?? {},
        }),
        signal: controller.signal,
      });
    } catch {
      // Mailpit container is optional on local machines without Docker; in-memory capture stays active.
    } finally {
      clearTimeout(timer);
    }
  }
}
