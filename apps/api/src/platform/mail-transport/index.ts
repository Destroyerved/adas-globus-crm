export interface OutboundEmailPayload {
  idempotencyKey: string;
  fromEmail: string;
  toEmail: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  headers?: Record<string, string>;
}

export interface OutboundEmailReceipt {
  provider: 'mailpit' | 'microsoft_graph' | 'esp_bulk';
  providerMessageId: string;
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
  ) {
    if (this.mailLive && this.nodeEnv !== 'production') {
      throw new Error('Safety guard: MAIL_LIVE cannot be enabled outside production');
    }
  }

  async sendOneToOne(payload: OutboundEmailPayload): Promise<OutboundEmailReceipt> {
    const receipt: OutboundEmailReceipt = {
      provider: 'mailpit',
      providerMessageId: `mailpit_1to1_${payload.idempotencyKey}`,
      sentAt: new Date().toISOString(),
    };
    this.sentMessages.push({ ...payload, ...receipt });
    return receipt;
  }

  async sendCampaignMessage(payload: OutboundEmailPayload): Promise<OutboundEmailReceipt> {
    const receipt: OutboundEmailReceipt = {
      provider: 'mailpit',
      providerMessageId: `mailpit_bulk_${payload.idempotencyKey}`,
      sentAt: new Date().toISOString(),
    };
    this.sentMessages.push({ ...payload, ...receipt });
    return receipt;
  }

  getSentMessages(): ReadonlyArray<OutboundEmailPayload & OutboundEmailReceipt> {
    return this.sentMessages;
  }

  clearSentMessages(): void {
    this.sentMessages.length = 0;
  }
}
