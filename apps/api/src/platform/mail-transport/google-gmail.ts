import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type {
  GraphAttachmentMetadata,
  GraphMailMessage,
  GraphTokenBundle,
  PendingMailOAuth,
} from './microsoft-graph.js';

/**
 * Google Workspace Gmail REST v1 Delegated Mail Connector (`PRD §4.11, §8.2, §8.7, §15 Q2`).
 *
 * - Minimum delegated scopes:
 *   `openid email profile https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send`
 * - Uses OAuth2 Authorization Code + PKCE (`S256`) with `access_type=offline` & `prompt=consent`.
 * - Never fakes a connection when credentials are absent (`isConfigured() === false`).
 * - Supports 90-day initial sync (`users.messages.list`), incremental `historyId` delta sync
 *   (`users.history.list` with automatic `404` expired-cursor fallback), RFC 5322 MIME send &
 *   threaded reply (`threadId` + `In-Reply-To` + `References`), metadata-only attachment indexing,
 *   on-demand attachment byte streaming, Google Cloud Pub/Sub `users.watch`, and `429 Retry-After`.
 */

export const GMAIL_DELEGATED_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
].join(' ');

const PLACEHOLDER_CLIENT_ID = '000000000000-placeholder.apps.googleusercontent.com';

export interface GoogleGmailSettings {
  clientId: string;
  clientSecretFile: string;
  redirectUri: string;
  authUrl?: string;
  tokenUrl?: string;
  gmailBaseUrl?: string;
  pubsubTopic?: string;
  fetchImpl?: typeof fetch;
}

export interface GmailMailboxProfile {
  email: string;
  historyId: string | null;
}

export interface GmailSyncedMessage {
  direction: 'inbound' | 'outbound';
  message: GraphMailMessage;
  attachments: GraphAttachmentMetadata[];
}

export class GmailThrottleError extends Error {
  constructor(
    readonly retryAfterSeconds: number,
    message = `Google Gmail API throttled request; retry after ${retryAfterSeconds}s`,
  ) {
    super(message);
    this.name = 'GmailThrottleError';
  }
}

export class GmailAuthRevokedError extends Error {
  constructor(message = 'Google Workspace delegated token expired or was revoked.') {
    super(message);
    this.name = 'GmailAuthRevokedError';
  }
}

export class GmailApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GmailApiError';
  }
}

interface GmailMimePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name?: string; value?: string }>;
  body?: {
    attachmentId?: string;
    size?: number;
    data?: string;
  };
  parts?: GmailMimePart[];
}

interface GmailRawMessage {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string;
  payload?: GmailMimePart;
}

export function extractEmailAddressesFromHeader(raw: string | undefined): string[] {
  if (!raw) return [];
  const matches = raw.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
  return Array.from(new Set(matches.map((m) => m.trim().toLowerCase())));
}

export function decodeBase64UrlToBuffer(encoded: string): Buffer {
  const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4;
  const padded = pad === 0 ? normalized : normalized + '='.repeat(4 - pad);
  return Buffer.from(padded, 'base64');
}

export function encodeMimeSubjectHeader(subject: string): string {
  const clean = subject.replace(/[\r\n]+/g, ' ').trim();
  if (/^[\x20-\x7E]*$/.test(clean)) {
    return clean;
  }
  return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

export function buildRfc5322RawEmail(input: {
  fromEmail?: string;
  toEmails: string[];
  ccEmails?: string[];
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  messageId?: string;
  inReplyTo?: string | null;
  references?: string | null;
  extraHeaders?: Record<string, string>;
}): { rawBase64Url: string; internetMessageId: string } {
  const internetMessageId = input.messageId?.trim() || `<adas.${randomUUID()}@adasglobuspro.com>`;
  const lines: string[] = [];

  if (input.fromEmail) {
    lines.push(`From: ${input.fromEmail.replace(/[\r\n]/g, '')}`);
  }
  lines.push(`To: ${input.toEmails.map((e) => e.replace(/[\r\n]/g, '')).join(', ')}`);
  if (input.ccEmails && input.ccEmails.length > 0) {
    lines.push(`Cc: ${input.ccEmails.map((e) => e.replace(/[\r\n]/g, '')).join(', ')}`);
  }
  lines.push(`Subject: ${encodeMimeSubjectHeader(input.subject)}`);
  lines.push(`Message-ID: ${internetMessageId}`);
  lines.push(`Date: ${new Date().toUTCString()}`);
  lines.push('MIME-Version: 1.0');

  if (input.inReplyTo) {
    lines.push(`In-Reply-To: ${input.inReplyTo.replace(/[\r\n]/g, '')}`);
  }
  if (input.references) {
    lines.push(`References: ${input.references.replace(/[\r\n]/g, ' ')}`);
  }
  for (const [k, v] of Object.entries(input.extraHeaders ?? {})) {
    if (/^[A-Za-z0-9-]+$/.test(k) && v) {
      lines.push(`${k}: ${v.replace(/[\r\n]/g, '')}`);
    }
  }

  if (input.bodyHtml && input.bodyHtml.trim().length > 0) {
    const boundary = `adas_alt_${randomBytes(12).toString('hex')}`;
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    lines.push('');
    lines.push(`--${boundary}`);
    lines.push('Content-Type: text/plain; charset="UTF-8"');
    lines.push('Content-Transfer-Encoding: base64');
    lines.push('');
    lines.push(Buffer.from(input.bodyText, 'utf8').toString('base64'));
    lines.push(`--${boundary}`);
    lines.push('Content-Type: text/html; charset="UTF-8"');
    lines.push('Content-Transfer-Encoding: base64');
    lines.push('');
    lines.push(Buffer.from(input.bodyHtml, 'utf8').toString('base64'));
    lines.push(`--${boundary}--`);
  } else {
    lines.push('Content-Type: text/plain; charset="UTF-8"');
    lines.push('Content-Transfer-Encoding: base64');
    lines.push('');
    lines.push(Buffer.from(input.bodyText, 'utf8').toString('base64'));
  }

  const mimeString = `${lines.join('\r\n')}\r\n`;
  return {
    rawBase64Url: Buffer.from(mimeString, 'utf8').toString('base64url'),
    internetMessageId,
  };
}

export function parseGmailApiMessage(
  raw: GmailRawMessage,
  mailboxEmail: string,
): GmailSyncedMessage | null {
  if (!raw.id || !raw.payload) return null;

  const headers: Record<string, string> = {};
  for (const h of raw.payload.headers ?? []) {
    if (h.name && typeof h.value === 'string') {
      headers[h.name.toLowerCase()] = h.value.trim();
    }
  }

  let plainBody = '';
  let htmlBody = '';
  const attachments: GraphAttachmentMetadata[] = [];

  const visitPart = (part: GmailMimePart): void => {
    const mime = (part.mimeType ?? '').toLowerCase();
    const partHeaders: Record<string, string> = {};
    for (const ph of part.headers ?? []) {
      if (ph.name && typeof ph.value === 'string') {
        partHeaders[ph.name.toLowerCase()] = ph.value.trim();
      }
    }

    if (part.body?.attachmentId && part.filename) {
      const disposition = (partHeaders['content-disposition'] ?? '').toLowerCase();
      const hasContentId = Boolean(partHeaders['content-id']);
      attachments.push({
        providerAttachmentId: part.body.attachmentId,
        filename: part.filename,
        mimeType: part.mimeType ?? 'application/octet-stream',
        sizeBytes: Number(part.body.size ?? 0),
        isInline: disposition.startsWith('inline') || hasContentId,
      });
    } else if (part.body?.data) {
      const decoded = decodeBase64UrlToBuffer(part.body.data).toString('utf8');
      if (mime === 'text/html' && !htmlBody) {
        htmlBody = decoded;
      } else if (mime === 'text/plain' && !plainBody) {
        plainBody = decoded;
      } else if (mime.startsWith('message/delivery-status') || mime === 'text/rfc822-headers') {
        // Append DSN diagnostic part into plainBody so parseDsnHardBounce inspects 5.x.x codes!
        plainBody = plainBody ? `${plainBody}\n${decoded}` : decoded;
      }
    }

    for (const child of part.parts ?? []) {
      visitPart(child);
    }
  };

  visitPart(raw.payload);

  const fromAddresses = extractEmailAddressesFromHeader(headers['from']);
  const fromEmail = fromAddresses[0] ?? '';
  const toEmails = extractEmailAddressesFromHeader(headers['to']);
  const ccEmails = extractEmailAddressesFromHeader(headers['cc']);

  const labels = new Set((raw.labelIds ?? []).map((l) => l.toUpperCase()));
  if (labels.has('DRAFT') || labels.has('TRASH') || labels.has('SPAM')) {
    return null;
  }

  const normalizedMailbox = mailboxEmail.trim().toLowerCase();
  const isSent =
    labels.has('SENT') ||
    (Boolean(fromEmail) && fromEmail === normalizedMailbox && !labels.has('INBOX'));
  const direction: 'inbound' | 'outbound' = isSent ? 'outbound' : 'inbound';

  const internalMs = raw.internalDate ? Number.parseInt(raw.internalDate, 10) : NaN;
  const isoTimestamp = Number.isFinite(internalMs)
    ? new Date(internalMs).toISOString()
    : headers['date']
      ? new Date(headers['date']).toISOString()
      : new Date().toISOString();

  const useHtml = htmlBody.trim().length > 0;
  const snippet = (raw.snippet ?? plainBody).trim().slice(0, 240);

  return {
    direction,
    attachments,
    message: {
      id: raw.id,
      conversationId: raw.threadId ?? null,
      internetMessageId: headers['message-id'] ?? null,
      inReplyTo: headers['in-reply-to'] ?? null,
      referencesHeader: headers['references'] ?? null,
      headers,
      subject: headers['subject'] || '(No subject)',
      bodyPreview: snippet,
      bodyContentType: useHtml ? 'html' : 'text',
      bodyContent: useHtml ? htmlBody : plainBody || snippet,
      fromEmail,
      toEmails,
      ccEmails,
      hasAttachments: attachments.length > 0,
      sentAt: isoTimestamp,
      receivedAt: isoTimestamp,
    },
  };
}

export class GoogleGmailMailboxClient {
  private readonly fetchFn: typeof fetch;
  private readonly authUrl: string;
  private readonly tokenUrl: string;
  private readonly gmailBaseUrl: string;

  constructor(private readonly settings: GoogleGmailSettings) {
    this.fetchFn = settings.fetchImpl ?? fetch;
    this.authUrl = settings.authUrl ?? 'https://accounts.google.com/o/oauth2/v2/auth';
    this.tokenUrl = settings.tokenUrl ?? 'https://oauth2.googleapis.com/token';
    this.gmailBaseUrl = (settings.gmailBaseUrl ?? 'https://gmail.googleapis.com/gmail/v1').replace(
      /\/+$/,
      '',
    );
  }

  isConfigured(): boolean {
    const { clientId, clientSecretFile } = this.settings;
    return (
      Boolean(clientId) &&
      clientId !== PLACEHOLDER_CLIENT_ID &&
      existsSync(clientSecretFile) &&
      readFileSync(clientSecretFile, 'utf8').trim() !== ''
    );
  }

  private readClientSecret(): string {
    if (!existsSync(this.settings.clientSecretFile)) {
      throw new Error('Google OAuth client secret file not found.');
    }
    return readFileSync(this.settings.clientSecretFile, 'utf8').trim();
  }

  createAuthorizationRequest(input: { userId: string; loginHint?: string }): {
    url: string;
    pending: PendingMailOAuth & { provider: 'google_gmail' };
  } {
    const state = randomBytes(24).toString('base64url');
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

    const url = new URL(this.authUrl);
    url.searchParams.set('client_id', this.settings.clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', this.settings.redirectUri);
    url.searchParams.set('scope', GMAIL_DELEGATED_SCOPES);
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent select_account');
    url.searchParams.set('include_granted_scopes', 'true');
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    if (input.loginHint) {
      url.searchParams.set('login_hint', input.loginHint);
    }

    return {
      url: url.toString(),
      pending: {
        state,
        codeVerifier,
        userId: input.userId,
        provider: 'google_gmail',
      },
    };
  }

  async exchangeAuthorizationCode(input: {
    code: string;
    codeVerifier: string;
  }): Promise<GraphTokenBundle> {
    const body = new URLSearchParams({
      client_id: this.settings.clientId,
      client_secret: this.readClientSecret(),
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: this.settings.redirectUri,
      code_verifier: input.codeVerifier,
    });

    const res = await this.fetchFn(this.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    return this.parseTokenResponse(res);
  }

  async refreshAccessToken(refreshToken: string): Promise<GraphTokenBundle> {
    const body = new URLSearchParams({
      client_id: this.settings.clientId,
      client_secret: this.readClientSecret(),
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });

    const res = await this.fetchFn(this.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    return this.parseTokenResponse(res);
  }

  private async parseTokenResponse(res: Response): Promise<GraphTokenBundle> {
    this.checkThrottle(res);
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const errCode = String(json['error'] ?? 'oauth_error');
      if (res.status === 400 || res.status === 401) {
        if (errCode === 'invalid_grant' || errCode === 'unauthorized_client') {
          throw new GmailAuthRevokedError(`Google OAuth token rejected (${errCode}).`);
        }
      }
      throw new GmailApiError(
        res.status,
        errCode,
        `Google OAuth token exchange failed (${errCode}).`,
      );
    }
    const accessToken = String(json['access_token'] ?? '');
    if (!accessToken) {
      throw new GmailApiError(
        502,
        'missing_access_token',
        'Google did not return an access_token.',
      );
    }
    return {
      accessToken,
      refreshToken: typeof json['refresh_token'] === 'string' ? json['refresh_token'] : null,
      expiresInSeconds: Number(json['expires_in'] ?? 3599),
      scope: String(json['scope'] ?? GMAIL_DELEGATED_SCOPES),
    };
  }

  private checkThrottle(res: Response): void {
    if (res.status === 429 || res.status === 503) {
      const retryHeader = res.headers.get('retry-after');
      const parsed = retryHeader ? Number.parseInt(retryHeader, 10) : NaN;
      const seconds = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 3600) : 60;
      throw new GmailThrottleError(seconds);
    }
  }

  private async gmailGetJson<T>(accessToken: string, endpointPath: string): Promise<T> {
    const res = await this.fetchFn(`${this.gmailBaseUrl}${endpointPath}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    this.checkThrottle(res);
    if (res.status === 401) {
      throw new GmailAuthRevokedError();
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const errObj = (json['error'] as Record<string, unknown> | undefined) ?? {};
      throw new GmailApiError(
        res.status,
        String(errObj['status'] ?? res.status),
        String(errObj['message'] ?? `Gmail HTTP ${res.status}`),
      );
    }
    return json as T;
  }

  async getMailboxProfile(accessToken: string): Promise<GmailMailboxProfile> {
    const profile = await this.gmailGetJson<{ emailAddress?: string; historyId?: string }>(
      accessToken,
      '/users/me/profile',
    );
    const email = String(profile.emailAddress ?? '')
      .trim()
      .toLowerCase();
    if (!email) {
      throw new GmailApiError(502, 'missing_email', 'Gmail profile did not return emailAddress.');
    }
    return {
      email,
      historyId: profile.historyId ? String(profile.historyId) : null,
    };
  }

  /**
   * Fetches either incremental Gmail changes (`users/me/history?startHistoryId=...`) or an
   * initial 90-day window (`users/me/messages?q=newer_than:90d`), automatically falling back
   * to the 90-day scan if Google returns `404` on an expired `startHistoryId`.
   */
  async syncMessages(input: {
    accessToken: string;
    mailboxEmail: string;
    startHistoryId: string | null;
    maxMessages?: number;
  }): Promise<{
    items: GmailSyncedMessage[];
    nextHistoryId: string | null;
  }> {
    const cap = input.maxMessages ?? 150;
    const messageIds = new Set<string>();
    let latestHistoryId: string | null = input.startHistoryId;
    let needInitialScan = !input.startHistoryId;

    if (input.startHistoryId) {
      try {
        let pageToken: string | undefined;
        do {
          const qs = new URLSearchParams({
            startHistoryId: input.startHistoryId,
            historyTypes: 'messageAdded',
            maxResults: '100',
          });
          if (pageToken) qs.set('pageToken', pageToken);
          const page = await this.gmailGetJson<{
            history?: Array<{
              id?: string;
              messagesAdded?: Array<{ message?: { id?: string } }>;
            }>;
            historyId?: string;
            nextPageToken?: string;
          }>(input.accessToken, `/users/me/history?${qs.toString()}`);

          if (page.historyId) latestHistoryId = String(page.historyId);
          for (const h of page.history ?? []) {
            if (h.id) latestHistoryId = String(h.id);
            for (const added of h.messagesAdded ?? []) {
              if (added.message?.id && messageIds.size < cap) {
                messageIds.add(added.message.id);
              }
            }
          }
          pageToken = page.nextPageToken && messageIds.size < cap ? page.nextPageToken : undefined;
        } while (pageToken);
      } catch (err) {
        if (err instanceof GmailApiError && err.status === 404) {
          // Gmail expires historyId cursors after ~7+ days without sync; resync 90-day window cleanly
          needInitialScan = true;
        } else {
          throw err;
        }
      }
    }

    if (needInitialScan) {
      const profile = await this.getMailboxProfile(input.accessToken);
      if (profile.historyId) latestHistoryId = profile.historyId;

      let pageToken: string | undefined;
      do {
        const qs = new URLSearchParams({
          q: 'newer_than:90d (in:inbox OR in:sent)',
          maxResults: String(Math.min(100, cap - messageIds.size)),
        });
        if (pageToken) qs.set('pageToken', pageToken);
        const listRes = await this.gmailGetJson<{
          messages?: Array<{ id?: string }>;
          nextPageToken?: string;
        }>(input.accessToken, `/users/me/messages?${qs.toString()}`);

        for (const m of listRes.messages ?? []) {
          if (m.id && messageIds.size < cap) {
            messageIds.add(m.id);
          }
        }
        pageToken =
          listRes.nextPageToken && messageIds.size < cap ? listRes.nextPageToken : undefined;
      } while (pageToken);
    }

    const items: GmailSyncedMessage[] = [];
    for (const id of messageIds) {
      try {
        const full = await this.gmailGetJson<GmailRawMessage>(
          input.accessToken,
          `/users/me/messages/${encodeURIComponent(id)}?format=full`,
        );
        if (
          full.historyId &&
          (!latestHistoryId || BigInt(full.historyId) > BigInt(latestHistoryId))
        ) {
          latestHistoryId = String(full.historyId);
        }
        const parsed = parseGmailApiMessage(full, input.mailboxEmail);
        if (parsed) {
          items.push(parsed);
        }
      } catch (err) {
        if (err instanceof GmailApiError && err.status === 404) {
          // Message deleted between list and fetch; skip cleanly
          continue;
        }
        throw err;
      }
    }

    return {
      items,
      nextHistoryId: latestHistoryId,
    };
  }

  async fetchSingleMessage(
    accessToken: string,
    mailboxEmail: string,
    providerMessageId: string,
  ): Promise<GmailSyncedMessage> {
    const full = await this.gmailGetJson<GmailRawMessage>(
      accessToken,
      `/users/me/messages/${encodeURIComponent(providerMessageId)}?format=full`,
    );
    const parsed = parseGmailApiMessage(full, mailboxEmail);
    if (!parsed) {
      throw new GmailApiError(404, 'NOT_FOUND', 'Gmail message not found.');
    }
    return parsed;
  }

  async downloadAttachment(input: {
    accessToken: string;
    providerMessageId: string;
    providerAttachmentId: string;
    maxBytes?: number;
  }): Promise<{ buffer: Buffer; contentType: string }> {
    const res = await this.gmailGetJson<{ data?: string; size?: number }>(
      input.accessToken,
      `/users/me/messages/${encodeURIComponent(input.providerMessageId)}/attachments/${encodeURIComponent(input.providerAttachmentId)}`,
    );
    if (!res.data) {
      throw new GmailApiError(
        502,
        'empty_attachment',
        'Gmail attachment response contained no data.',
      );
    }
    const buffer = decodeBase64UrlToBuffer(res.data);
    if (input.maxBytes && buffer.byteLength > input.maxBytes) {
      throw new GmailApiError(
        413,
        'attachment_too_large',
        `Attachment exceeds maximum size of ${input.maxBytes} bytes.`,
      );
    }
    return { buffer, contentType: 'application/octet-stream' };
  }

  async sendMail(input: {
    accessToken: string;
    fromEmail?: string;
    toEmails: string[];
    ccEmails?: string[];
    subject: string;
    bodyText: string;
    bodyHtml?: string;
    threadId?: string | null;
    inReplyTo?: string | null;
    references?: string | null;
    extraHeaders?: Record<string, string>;
  }): Promise<{
    providerMessageId: string;
    threadId: string | null;
    internetMessageId: string;
  }> {
    const built = buildRfc5322RawEmail({
      fromEmail: input.fromEmail,
      toEmails: input.toEmails,
      ccEmails: input.ccEmails,
      subject: input.subject,
      bodyText: input.bodyText,
      bodyHtml: input.bodyHtml,
      inReplyTo: input.inReplyTo,
      references: input.references,
      extraHeaders: input.extraHeaders,
    });

    const payload: Record<string, unknown> = { raw: built.rawBase64Url };
    if (input.threadId) {
      payload['threadId'] = input.threadId;
    }

    const res = await this.fetchFn(`${this.gmailBaseUrl}/users/me/messages/send`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    this.checkThrottle(res);
    if (res.status === 401) {
      throw new GmailAuthRevokedError();
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const errObj = (json['error'] as Record<string, unknown> | undefined) ?? {};
      throw new GmailApiError(
        res.status,
        String(errObj['status'] ?? res.status),
        String(errObj['message'] ?? `Gmail send failed (${res.status})`),
      );
    }

    return {
      providerMessageId: String(json['id'] ?? `gmail_${randomUUID()}`),
      threadId: typeof json['threadId'] === 'string' ? json['threadId'] : (input.threadId ?? null),
      internetMessageId: built.internetMessageId,
    };
  }

  async watchMailbox(input: {
    accessToken: string;
    topicName?: string;
  }): Promise<{ historyId: string; expiresAt: string } | null> {
    const topic = (input.topicName ?? this.settings.pubsubTopic ?? '').trim();
    if (!topic) return null;

    const res = await this.fetchFn(`${this.gmailBaseUrl}/users/me/watch`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        topicName: topic,
        labelIds: ['INBOX', 'SENT'],
        labelFilterBehavior: 'INCLUDE',
      }),
    });
    this.checkThrottle(res);
    if (res.status === 401) throw new GmailAuthRevokedError();
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const errObj = (json['error'] as Record<string, unknown> | undefined) ?? {};
      throw new GmailApiError(
        res.status,
        String(errObj['status'] ?? res.status),
        String(errObj['message'] ?? `Gmail watch failed (${res.status})`),
      );
    }
    const expMs = Number(json['expiration'] ?? Date.now() + 6 * 86_400_000);
    return {
      historyId: String(json['historyId'] ?? ''),
      expiresAt: new Date(expMs).toISOString(),
    };
  }
}
