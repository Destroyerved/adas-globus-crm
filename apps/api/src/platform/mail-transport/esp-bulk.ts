import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { extractDomainFromEmail, normalizeEmail } from '../normalize/index.js';
import type { BulkSender, OutboundEmailPayload, OutboundEmailReceipt } from './index.js';

export type EspProviderKind = 'postmark' | 'resend' | 'http_json';

export interface EspBulkSenderConfig {
  provider: EspProviderKind;
  apiBaseUrl: string;
  apiKeyFile: string;
  webhookSecretFile: string;
  sendingDomain: string;
  nodeEnv: 'development' | 'test' | 'production';
  mailLive: boolean;
  fetchImpl?: typeof fetch;
}

export class EspTransportError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | null;

  constructor(
    message: string,
    options: { status: number; retryable: boolean; retryAfterSeconds?: number | null },
  ) {
    super(message);
    this.name = 'EspTransportError';
    this.status = options.status;
    this.retryable = options.retryable;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

export interface NormalizedEspWebhookEvent {
  providerEventId: string;
  providerMessageId: string | null;
  recipientEmail: string | null;
  eventType:
    | 'delivered'
    | 'bounced_hard'
    | 'bounced_soft'
    | 'complained'
    | 'clicked'
    | 'opened'
    | 'unsubscribed';
  occurredAt: string;
  diagnostic: string | null;
  linkUrl: string | null;
}

function readSecretFromFile(filePath: string): string {
  const raw = readFileSync(filePath, 'utf8').trim();
  if (!raw) {
    throw new Error(`Secret file is empty: ${filePath}`);
  }
  return raw;
}

function constantTimeHexMatch(expectedHex: string, candidateHex: string): boolean {
  const cleanCandidate = candidateHex
    .trim()
    .toLowerCase()
    .replace(/^sha256=/, '');
  if (expectedHex.length !== cleanCandidate.length || !/^[0-9a-f]+$/.test(cleanCandidate)) {
    return false;
  }
  const a = Buffer.from(expectedHex, 'hex');
  const b = Buffer.from(cleanCandidate, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Verifies an ESP webhook HMAC-SHA256 signature with constant-time comparison and an optional
 * 5-minute replay-window timestamp check (PRD 8.4, 8.7, 9).
 */
export function verifyEspWebhookSignature(input: {
  rawBody: string;
  signatureHeader: string | undefined;
  timestampHeader?: string | undefined;
  secret: string;
  nowMs?: number;
  maxSkewSeconds?: number;
}): boolean {
  const { rawBody, signatureHeader, timestampHeader, secret } = input;
  if (!signatureHeader || !secret.trim()) {
    return false;
  }

  const nowMs = input.nowMs ?? Date.now();
  const maxSkewMs = (input.maxSkewSeconds ?? 300) * 1000;

  if (timestampHeader && timestampHeader.trim()) {
    const parsedTs = /^\d+$/.test(timestampHeader.trim())
      ? Number(timestampHeader.trim()) * (timestampHeader.trim().length <= 10 ? 1000 : 1)
      : Date.parse(timestampHeader.trim());
    if (!Number.isFinite(parsedTs) || Math.abs(nowMs - parsedTs) > maxSkewMs) {
      return false;
    }
    const signedWithTs = createHmac('sha256', secret)
      .update(`${timestampHeader.trim()}.${rawBody}`, 'utf8')
      .digest('hex');
    if (constantTimeHexMatch(signedWithTs, signatureHeader)) {
      return true;
    }
  }

  const directHex = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  if (constantTimeHexMatch(directHex, signatureHeader)) {
    return true;
  }

  const directBase64 = createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
  const cleanBase64 = signatureHeader.trim().replace(/^v1,/, '');
  const a = Buffer.from(directBase64, 'utf8');
  const b = Buffer.from(cleanBase64, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Parses Postmark, Resend, or canonical JSON ESP webhook payloads into normalised send events.
 */
export function parseEspWebhookPayload(payload: unknown): NormalizedEspWebhookEvent[] {
  const items: unknown[] = Array.isArray(payload)
    ? payload
    : payload &&
        typeof payload === 'object' &&
        Array.isArray((payload as Record<string, unknown>)['events'])
      ? ((payload as Record<string, unknown>)['events'] as unknown[])
      : [payload];

  const events: NormalizedEspWebhookEvent[] = [];

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;

    // 1. Postmark webhook format (`RecordType`, `MessageID`, `Recipient` / `Email`, `Type` = HardBounce)
    if (typeof obj['RecordType'] === 'string') {
      const recordType = obj['RecordType'];
      const msgId = typeof obj['MessageID'] === 'string' ? obj['MessageID'] : null;
      const recipientRaw =
        typeof obj['Recipient'] === 'string'
          ? obj['Recipient']
          : typeof obj['Email'] === 'string'
            ? obj['Email']
            : null;
      const recipientEmail = recipientRaw ? normalizeEmail(recipientRaw) : null;
      const occurredAt =
        typeof obj['DeliveredAt'] === 'string'
          ? obj['DeliveredAt']
          : typeof obj['BouncedAt'] === 'string'
            ? obj['BouncedAt']
            : typeof obj['ReceivedAt'] === 'string'
              ? obj['ReceivedAt']
              : new Date().toISOString();
      const rawId =
        obj['ID'] !== undefined
          ? String(obj['ID'])
          : `${recordType}:${msgId ?? 'unknown'}:${recipientEmail ?? 'unknown'}:${occurredAt}`;

      let eventType: NormalizedEspWebhookEvent['eventType'] | null = null;
      if (recordType === 'Delivery') eventType = 'delivered';
      else if (recordType === 'Bounce') {
        const bounceType = typeof obj['Type'] === 'string' ? obj['Type'] : 'HardBounce';
        eventType =
          bounceType === 'HardBounce' || bounceType === 'BadEmailAddress'
            ? 'bounced_hard'
            : 'bounced_soft';
      } else if (recordType === 'SpamComplaint') eventType = 'complained';
      else if (recordType === 'Click') eventType = 'clicked';
      else if (recordType === 'Open') eventType = 'opened';
      else if (recordType === 'SubscriptionChange' && obj['SuppressSending'] === true) {
        eventType = 'unsubscribed';
      }

      if (eventType) {
        events.push({
          providerEventId: `postmark_${rawId}`,
          providerMessageId: msgId,
          recipientEmail,
          eventType,
          occurredAt,
          diagnostic: typeof obj['Description'] === 'string' ? obj['Description'] : null,
          linkUrl: typeof obj['OriginalLink'] === 'string' ? obj['OriginalLink'] : null,
        });
      }
      continue;
    }

    // 2. Resend webhook format (`type: 'email.delivered' | 'email.bounced' | ...`, `data: { email_id, to }`)
    if (typeof obj['type'] === 'string' && obj['type'].startsWith('email.') && obj['data']) {
      const data = obj['data'] as Record<string, unknown>;
      const type = obj['type'];
      const msgId = typeof data['email_id'] === 'string' ? data['email_id'] : null;
      const toArr = Array.isArray(data['to']) ? data['to'] : [];
      const firstTo = typeof toArr[0] === 'string' ? toArr[0] : null;
      const recipientEmail = firstTo ? normalizeEmail(firstTo) : null;
      const occurredAt =
        typeof obj['created_at'] === 'string' ? obj['created_at'] : new Date().toISOString();

      let eventType: NormalizedEspWebhookEvent['eventType'] | null = null;
      if (type === 'email.delivered') eventType = 'delivered';
      else if (type === 'email.bounced') {
        const bounceObj =
          data['bounce'] && typeof data['bounce'] === 'object'
            ? (data['bounce'] as Record<string, unknown>)
            : null;
        eventType = bounceObj?.['type'] === 'Transient' ? 'bounced_soft' : 'bounced_hard';
      } else if (type === 'email.complained') eventType = 'complained';
      else if (type === 'email.clicked') eventType = 'clicked';
      else if (type === 'email.opened') eventType = 'opened';

      if (eventType) {
        const clickObj =
          data['click'] && typeof data['click'] === 'object'
            ? (data['click'] as Record<string, unknown>)
            : null;
        events.push({
          providerEventId:
            typeof obj['id'] === 'string'
              ? `resend_${obj['id']}`
              : `resend_${type}_${msgId ?? 'unknown'}_${occurredAt}`,
          providerMessageId: msgId,
          recipientEmail,
          eventType,
          occurredAt,
          diagnostic: null,
          linkUrl: typeof clickObj?.['link'] === 'string' ? (clickObj['link'] as string) : null,
        });
      }
      continue;
    }

    // 3. Canonical JSON webhook format (`eventId`, `providerMessageId`, `recipientEmail`, `eventType`)
    const rawType = typeof obj['eventType'] === 'string' ? obj['eventType'] : null;
    if (
      rawType === 'delivered' ||
      rawType === 'bounced_hard' ||
      rawType === 'bounced_soft' ||
      rawType === 'complained' ||
      rawType === 'clicked' ||
      rawType === 'opened' ||
      rawType === 'unsubscribed'
    ) {
      const providerEventId =
        typeof obj['eventId'] === 'string' && obj['eventId'].trim()
          ? obj['eventId'].trim()
          : typeof obj['providerEventId'] === 'string' && obj['providerEventId'].trim()
            ? obj['providerEventId'].trim()
            : '';
      if (!providerEventId) continue;
      const recipientRaw = typeof obj['recipientEmail'] === 'string' ? obj['recipientEmail'] : null;
      events.push({
        providerEventId,
        providerMessageId:
          typeof obj['providerMessageId'] === 'string' ? obj['providerMessageId'] : null,
        recipientEmail: recipientRaw ? normalizeEmail(recipientRaw) : null,
        eventType: rawType,
        occurredAt:
          typeof obj['occurredAt'] === 'string' ? obj['occurredAt'] : new Date().toISOString(),
        diagnostic: typeof obj['diagnostic'] === 'string' ? obj['diagnostic'] : null,
        linkUrl: typeof obj['linkUrl'] === 'string' ? obj['linkUrl'] : null,
      });
    }
  }

  return events;
}

/**
 * Real external Email Service Provider (ESP) HTTP adapter for marketing campaigns (PRD 4.13, 5.4, 8.4, 8.7).
 * Strictly gated behind `NODE_ENV === 'production' && MAIL_LIVE === true`.
 */
export class EspBulkSender implements BulkSender {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: EspBulkSenderConfig) {
    if (config.mailLive && config.nodeEnv !== 'production') {
      throw new Error('Safety guard: EspBulkSender cannot enable live sending outside production.');
    }
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  isConfiguredForLive(): boolean {
    return this.config.nodeEnv === 'production' && this.config.mailLive;
  }

  verifyWebhook(
    rawBody: string,
    signatureHeader: string | undefined,
    timestampHeader?: string | undefined,
    nowMs?: number,
  ): boolean {
    let secret: string;
    try {
      secret = readSecretFromFile(this.config.webhookSecretFile);
    } catch {
      return false;
    }
    return verifyEspWebhookSignature({
      rawBody,
      signatureHeader,
      timestampHeader,
      secret,
      nowMs,
    });
  }

  async sendCampaignMessage(payload: OutboundEmailPayload): Promise<OutboundEmailReceipt> {
    if (!this.isConfiguredForLive()) {
      throw new Error(
        'Safety guard: EspBulkSender refuses to send when NODE_ENV !== production or MAIL_LIVE !== true.',
      );
    }

    // PRD 5.4: Campaigns MUST send from the dedicated sending subdomain, never the root domain.
    const senderDomain = extractDomainFromEmail(payload.fromEmail);
    const expectedSubdomain = this.config.sendingDomain.trim().toLowerCase();
    if (
      !senderDomain ||
      (senderDomain !== expectedSubdomain && !senderDomain.endsWith(`.${expectedSubdomain}`))
    ) {
      throw new EspTransportError(
        `Campaign sender domain "${senderDomain ?? 'unknown'}" does not match dedicated sending subdomain "${expectedSubdomain}".`,
        { status: 422, retryable: false },
      );
    }

    const apiKey = readSecretFromFile(this.config.apiKeyFile);
    const baseUrl = this.config.apiBaseUrl.replace(/\/+$/, '');

    if (this.config.provider === 'postmark') {
      const headerEntries = Object.entries(payload.headers ?? {}).map(([Name, Value]) => ({
        Name,
        Value,
      }));
      headerEntries.push({ Name: 'X-Idempotency-Key', Value: payload.idempotencyKey });

      const response = await this.fetchImpl(`${baseUrl}/email`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Postmark-Server-Token': apiKey,
        },
        body: JSON.stringify({
          From: payload.fromEmail,
          To: payload.toEmail,
          Subject: payload.subject,
          TextBody: payload.bodyText,
          HtmlBody: payload.bodyHtml ?? undefined,
          MessageStream: 'broadcast',
          TrackOpens: false,
          TrackLinks: 'None',
          Headers: headerEntries,
        }),
      });

      const retryAfterRaw = response.headers.get('retry-after');
      const retryAfterSeconds =
        retryAfterRaw && /^\d+$/.test(retryAfterRaw) ? Number(retryAfterRaw) : null;

      if (!response.ok) {
        throw new EspTransportError(`Postmark send failed with HTTP ${response.status}`, {
          status: response.status,
          retryable: response.status === 429 || response.status >= 500,
          retryAfterSeconds,
        });
      }

      const data = (await response.json()) as Record<string, unknown>;
      const messageId =
        typeof data['MessageID'] === 'string' && data['MessageID'].trim()
          ? data['MessageID'].trim()
          : `postmark_${payload.idempotencyKey}`;

      return {
        provider: 'esp_bulk',
        providerMessageId: messageId,
        internetMessageId: `<${messageId}@${expectedSubdomain}>`,
        sentAt:
          typeof data['SubmittedAt'] === 'string' ? data['SubmittedAt'] : new Date().toISOString(),
      };
    }

    if (this.config.provider === 'resend') {
      const response = await this.fetchImpl(`${baseUrl}/emails`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': payload.idempotencyKey,
        },
        body: JSON.stringify({
          from: payload.fromEmail,
          to: [payload.toEmail],
          subject: payload.subject,
          text: payload.bodyText,
          html: payload.bodyHtml ?? undefined,
          headers: payload.headers ?? {},
        }),
      });

      const retryAfterRaw = response.headers.get('retry-after');
      const retryAfterSeconds =
        retryAfterRaw && /^\d+$/.test(retryAfterRaw) ? Number(retryAfterRaw) : null;

      if (!response.ok) {
        throw new EspTransportError(`Resend send failed with HTTP ${response.status}`, {
          status: response.status,
          retryable: response.status === 429 || response.status >= 500,
          retryAfterSeconds,
        });
      }

      const data = (await response.json()) as Record<string, unknown>;
      const messageId =
        typeof data['id'] === 'string' && data['id'].trim()
          ? data['id'].trim()
          : `resend_${payload.idempotencyKey}`;

      return {
        provider: 'esp_bulk',
        providerMessageId: messageId,
        internetMessageId: `<${messageId}@${expectedSubdomain}>`,
        sentAt: new Date().toISOString(),
      };
    }

    // Generic HTTP JSON ESP adapter
    const response = await this.fetchImpl(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': payload.idempotencyKey,
      },
      body: JSON.stringify({
        from: payload.fromEmail,
        to: payload.toEmail,
        subject: payload.subject,
        text: payload.bodyText,
        html: payload.bodyHtml ?? undefined,
        headers: payload.headers ?? {},
      }),
    });

    if (!response.ok) {
      throw new EspTransportError(`ESP send failed with HTTP ${response.status}`, {
        status: response.status,
        retryable: response.status === 429 || response.status >= 500,
      });
    }

    const data = (await response.json()) as Record<string, unknown>;
    const messageId =
      typeof data['messageId'] === 'string'
        ? data['messageId']
        : typeof data['id'] === 'string'
          ? data['id']
          : `esp_${payload.idempotencyKey}`;

    return {
      provider: 'esp_bulk',
      providerMessageId: messageId,
      internetMessageId: `<${messageId}@${expectedSubdomain}>`,
      sentAt: new Date().toISOString(),
    };
  }
}
