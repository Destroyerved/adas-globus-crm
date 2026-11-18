import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

/**
 * Microsoft Graph Delegated Mail Connector (PRD 4.11, 8.2, 8.7; AGENTS.md section 5).
 *
 * - Delegated permissions only:
 *   `openid profile email offline_access User.Read Mail.Read Mail.Send`
 * - Uses PKCE (`S256`) + client secret against Microsoft Entra v2.0 OAuth endpoints.
 * - Never fakes a connection when credentials are absent (`isConfigured() === false`).
 * - Honours `429` / `503` `Retry-After` headers via `GraphThrottleError` so callers back off per mailbox.
 * - Never fetches attachment file bytes during delta sync (`listMessageAttachments` fetches metadata
 *   only; `downloadAttachment` streams bytes on demand when opened by an authorised user).
 */

export const GRAPH_DELEGATED_SCOPES =
  'openid profile email offline_access User.Read Mail.Read Mail.Send';

const PLACEHOLDER_ID = '00000000-0000-0000-0000-000000000000';

export interface MicrosoftGraphSettings {
  tenantId: string;
  clientId: string;
  clientSecretFile: string;
  redirectUri: string;
  authorityBaseUrl?: string;
  graphBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface PendingMailOAuth {
  state: string;
  codeVerifier: string;
  userId: string;
}

export interface GraphTokenBundle {
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number;
  scope: string;
}

export interface GraphMailboxProfile {
  objectId: string;
  email: string;
  displayName: string;
}

export interface GraphMailMessage {
  id: string;
  conversationId: string | null;
  internetMessageId: string | null;
  inReplyTo: string | null;
  referencesHeader: string | null;
  headers: Record<string, string>;
  subject: string;
  bodyPreview: string;
  bodyContentType: 'text' | 'html';
  bodyContent: string;
  fromEmail: string;
  toEmails: string[];
  ccEmails: string[];
  hasAttachments: boolean;
  sentAt: string | null;
  receivedAt: string | null;
  removed?: boolean;
}

export interface GraphAttachmentMetadata {
  providerAttachmentId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  isInline: boolean;
}

export interface GraphSubscriptionResult {
  subscriptionId: string;
  expiresAt: string;
}

export class GraphThrottleError extends Error {
  constructor(
    readonly retryAfterSeconds: number,
    message = `Microsoft Graph throttled request; retry after ${retryAfterSeconds}s`,
  ) {
    super(message);
    this.name = 'GraphThrottleError';
  }
}

export class GraphAuthRevokedError extends Error {
  constructor(message = 'Microsoft 365 delegated token expired or was revoked.') {
    super(message);
    this.name = 'GraphAuthRevokedError';
  }
}

export class GraphApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GraphApiError';
  }
}

function parseRetryAfterSeconds(raw: string | null): number {
  if (!raw) return 60;
  const trimmed = raw.trim();
  const asInt = Number.parseInt(trimmed, 10);
  if (Number.isFinite(asInt) && asInt > 0) {
    return Math.min(Math.max(asInt, 1), 3600);
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    const deltaSeconds = Math.ceil((dateMs - Date.now()) / 1000);
    return Math.min(Math.max(deltaSeconds, 1), 3600);
  }
  return 60;
}

function stripHtmlTagsToText(html: string): string {
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export class MicrosoftGraphMailboxClient {
  private readonly authorityBase: string;
  private readonly graphBase: string;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly settings: MicrosoftGraphSettings) {
    this.authorityBase = (settings.authorityBaseUrl ?? 'https://login.microsoftonline.com').replace(
      /\/+$/,
      '',
    );
    this.graphBase = (settings.graphBaseUrl ?? 'https://graph.microsoft.com/v1.0').replace(
      /\/+$/,
      '',
    );
    this.fetchFn = settings.fetchImpl ?? globalThis.fetch;
  }

  isConfigured(): boolean {
    const { tenantId, clientId, clientSecretFile } = this.settings;
    return (
      Boolean(tenantId) &&
      tenantId !== PLACEHOLDER_ID &&
      Boolean(clientId) &&
      clientId !== PLACEHOLDER_ID &&
      existsSync(clientSecretFile) &&
      readFileSync(clientSecretFile, 'utf8').trim() !== ''
    );
  }

  private readClientSecret(): string {
    if (!existsSync(this.settings.clientSecretFile)) {
      throw new Error('Microsoft Entra client secret file is not configured.');
    }
    const secret = readFileSync(this.settings.clientSecretFile, 'utf8').trim();
    if (!secret) {
      throw new Error('Microsoft Entra client secret file is empty.');
    }
    return secret;
  }

  createAuthorizationRequest(input: { userId: string; loginHint?: string }): {
    url: string;
    pending: PendingMailOAuth;
  } {
    if (!this.isConfigured()) {
      throw new Error('Microsoft Entra delegated mail app registration is not configured.');
    }
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const state = randomBytes(24).toString('base64url');

    const authorizeUrl = new URL(
      `${this.authorityBase}/${encodeURIComponent(this.settings.tenantId)}/oauth2/v2.0/authorize`,
    );
    authorizeUrl.searchParams.set('client_id', this.settings.clientId);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('redirect_uri', this.settings.redirectUri);
    authorizeUrl.searchParams.set('response_mode', 'query');
    authorizeUrl.searchParams.set('scope', GRAPH_DELEGATED_SCOPES);
    authorizeUrl.searchParams.set('state', state);
    authorizeUrl.searchParams.set('code_challenge', codeChallenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl.searchParams.set('prompt', 'select_account');
    if (input.loginHint) {
      authorizeUrl.searchParams.set('login_hint', input.loginHint);
    }

    return {
      url: authorizeUrl.toString(),
      pending: {
        state,
        codeVerifier,
        userId: input.userId,
      },
    };
  }

  async exchangeCodeForTokens(input: {
    code: string;
    codeVerifier: string;
  }): Promise<{ tokens: GraphTokenBundle; profile: GraphMailboxProfile }> {
    const tokenUrl = `${this.authorityBase}/${encodeURIComponent(this.settings.tenantId)}/oauth2/v2.0/token`;
    const form = new URLSearchParams({
      client_id: this.settings.clientId,
      client_secret: this.readClientSecret(),
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: this.settings.redirectUri,
      code_verifier: input.codeVerifier,
      scope: GRAPH_DELEGATED_SCOPES,
    });

    const tokenRes = await this.fetchFn(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: form.toString(),
    });

    if (tokenRes.status === 429 || tokenRes.status === 503) {
      throw new GraphThrottleError(parseRetryAfterSeconds(tokenRes.headers.get('retry-after')));
    }
    const tokenBody = (await tokenRes.json().catch(() => ({}))) as Record<string, unknown>;
    if (!tokenRes.ok || typeof tokenBody['access_token'] !== 'string') {
      throw new GraphApiError(
        tokenRes.status,
        String(tokenBody['error'] ?? 'oauth_token_error'),
        'Microsoft OAuth code exchange failed.',
      );
    }

    const tokens: GraphTokenBundle = {
      accessToken: tokenBody['access_token'],
      refreshToken:
        typeof tokenBody['refresh_token'] === 'string' ? tokenBody['refresh_token'] : null,
      expiresInSeconds:
        typeof tokenBody['expires_in'] === 'number' ? tokenBody['expires_in'] : 3600,
      scope: typeof tokenBody['scope'] === 'string' ? tokenBody['scope'] : GRAPH_DELEGATED_SCOPES,
    };

    const me = await this.graphJson<Record<string, unknown>>(
      tokens.accessToken,
      '/me?$select=id,mail,userPrincipalName,displayName',
    );
    const email = String(me['mail'] ?? me['userPrincipalName'] ?? '')
      .trim()
      .toLowerCase();
    const objectId = String(me['id'] ?? '').trim();
    if (!email || !objectId) {
      throw new GraphApiError(
        502,
        'invalid_profile',
        'Microsoft Graph /me did not return mailbox address.',
      );
    }

    return {
      tokens,
      profile: {
        objectId,
        email,
        displayName: String(me['displayName'] ?? email),
      },
    };
  }

  async refreshAccessToken(refreshToken: string): Promise<GraphTokenBundle> {
    const tokenUrl = `${this.authorityBase}/${encodeURIComponent(this.settings.tenantId)}/oauth2/v2.0/token`;
    const form = new URLSearchParams({
      client_id: this.settings.clientId,
      client_secret: this.readClientSecret(),
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: GRAPH_DELEGATED_SCOPES,
    });

    const res = await this.fetchFn(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: form.toString(),
    });
    if (res.status === 429 || res.status === 503) {
      throw new GraphThrottleError(parseRetryAfterSeconds(res.headers.get('retry-after')));
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || typeof body['access_token'] !== 'string') {
      const errCode = String(body['error'] ?? '');
      if (
        res.status === 400 ||
        res.status === 401 ||
        errCode === 'invalid_grant' ||
        errCode === 'interaction_required'
      ) {
        throw new GraphAuthRevokedError();
      }
      throw new GraphApiError(res.status, errCode || 'refresh_failed', 'Token refresh failed.');
    }

    return {
      accessToken: body['access_token'],
      refreshToken: typeof body['refresh_token'] === 'string' ? body['refresh_token'] : null,
      expiresInSeconds: typeof body['expires_in'] === 'number' ? body['expires_in'] : 3600,
      scope: typeof body['scope'] === 'string' ? body['scope'] : GRAPH_DELEGATED_SCOPES,
    };
  }

  async fetchFolderDelta(input: {
    accessToken: string;
    folder: 'Inbox' | 'SentItems';
    deltaLink?: string | null;
    sinceIso: string;
    maxPages?: number;
  }): Promise<{ messages: GraphMailMessage[]; nextDeltaLink: string | null }> {
    const maxPages = input.maxPages ?? 10;
    const dateField = input.folder === 'SentItems' ? 'sentDateTime' : 'receivedDateTime';
    const select =
      'id,conversationId,internetMessageId,subject,bodyPreview,body,from,toRecipients,ccRecipients,hasAttachments,sentDateTime,receivedDateTime,internetMessageHeaders';

    let nextUrl: string | null =
      input.deltaLink ??
      `${this.graphBase}/me/mailFolders/${input.folder}/messages/delta?$select=${select}&$filter=${encodeURIComponent(`${dateField} ge ${input.sinceIso}`)}&$top=50`;

    const messages: GraphMailMessage[] = [];
    let nextDeltaLink: string | null = input.deltaLink ?? null;
    let page = 0;

    while (nextUrl && page < maxPages) {
      page += 1;
      const payload: Record<string, unknown> = await this.graphJson<Record<string, unknown>>(
        input.accessToken,
        nextUrl,
        {
          headers: { Prefer: 'odata.maxpagesize=50' },
        },
      );
      const rawItems = Array.isArray(payload['value'])
        ? (payload['value'] as Record<string, unknown>[])
        : [];

      for (const raw of rawItems) {
        messages.push(this.parseGraphMessage(raw));
      }

      if (typeof payload['@odata.deltaLink'] === 'string') {
        nextDeltaLink = payload['@odata.deltaLink'];
        nextUrl = null;
      } else if (typeof payload['@odata.nextLink'] === 'string') {
        nextUrl = payload['@odata.nextLink'];
      } else {
        nextUrl = null;
      }
    }

    return { messages, nextDeltaLink };
  }

  async fetchSingleMessage(
    accessToken: string,
    providerMessageId: string,
  ): Promise<GraphMailMessage> {
    const select =
      'id,conversationId,internetMessageId,subject,bodyPreview,body,from,toRecipients,ccRecipients,hasAttachments,sentDateTime,receivedDateTime,internetMessageHeaders';
    const raw = await this.graphJson<Record<string, unknown>>(
      accessToken,
      `/me/messages/${encodeURIComponent(providerMessageId)}?$select=${select}`,
    );
    return this.parseGraphMessage(raw);
  }

  async listMessageAttachments(
    accessToken: string,
    providerMessageId: string,
  ): Promise<GraphAttachmentMetadata[]> {
    const res = await this.graphJson<Record<string, unknown>>(
      accessToken,
      `/me/messages/${encodeURIComponent(providerMessageId)}/attachments?$select=id,name,contentType,size,isInline`,
    );
    const items = Array.isArray(res['value']) ? (res['value'] as Record<string, unknown>[]) : [];
    return items
      .filter((item) => typeof item['id'] === 'string')
      .map((item) => ({
        providerAttachmentId: String(item['id']),
        filename: String(item['name'] ?? 'attachment.bin'),
        mimeType: String(item['contentType'] ?? 'application/octet-stream'),
        sizeBytes: typeof item['size'] === 'number' ? Math.max(0, Math.trunc(item['size'])) : 0,
        isInline: Boolean(item['isInline']),
      }));
  }

  async downloadAttachment(input: {
    accessToken: string;
    providerMessageId: string;
    providerAttachmentId: string;
    maxBytes: number;
  }): Promise<{ buffer: Buffer; contentType: string }> {
    const url = `${this.graphBase}/me/messages/${encodeURIComponent(input.providerMessageId)}/attachments/${encodeURIComponent(input.providerAttachmentId)}/$value`;
    const res = await this.fetchFn(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${input.accessToken}` },
    });
    if (res.status === 429 || res.status === 503) {
      throw new GraphThrottleError(parseRetryAfterSeconds(res.headers.get('retry-after')));
    }
    if (res.status === 401) {
      throw new GraphAuthRevokedError();
    }
    if (!res.ok) {
      throw new GraphApiError(
        res.status,
        'attachment_download_failed',
        `Microsoft Graph returned ${res.status} downloading attachment.`,
      );
    }
    const contentLength = Number(res.headers.get('content-length') ?? '0');
    if (contentLength > input.maxBytes) {
      throw new GraphApiError(
        413,
        'attachment_too_large',
        'Attachment exceeds maximum allowed size.',
      );
    }
    const arrayBuffer = await res.arrayBuffer();
    if (arrayBuffer.byteLength > input.maxBytes) {
      throw new GraphApiError(
        413,
        'attachment_too_large',
        'Attachment exceeds maximum allowed size.',
      );
    }
    return {
      buffer: Buffer.from(arrayBuffer),
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
    };
  }

  async sendMail(input: {
    accessToken: string;
    toEmails: string[];
    ccEmails?: string[];
    subject: string;
    bodyText: string;
    bodyHtml?: string;
    internetMessageHeaders?: Record<string, string>;
  }): Promise<{ providerMessageId: string; sentAt: string }> {
    const headersList = Object.entries(input.internetMessageHeaders ?? {})
      .filter(
        ([name]) => name.toLowerCase().startsWith('x-') || name.toLowerCase().startsWith('list-'),
      )
      .slice(0, 5)
      .map(([name, value]) => ({ name, value }));

    const messagePayload: Record<string, unknown> = {
      subject: input.subject,
      body: {
        contentType: input.bodyHtml ? 'HTML' : 'Text',
        content: input.bodyHtml ?? input.bodyText,
      },
      toRecipients: input.toEmails.map((address) => ({ emailAddress: { address } })),
      ccRecipients: (input.ccEmails ?? []).map((address) => ({ emailAddress: { address } })),
    };
    if (headersList.length > 0) {
      messagePayload['internetMessageHeaders'] = headersList;
    }

    await this.graphRequest(input.accessToken, '/me/sendMail', {
      method: 'POST',
      body: JSON.stringify({
        message: messagePayload,
        saveToSentItems: true,
      }),
    });

    return {
      providerMessageId: `graph_sent_${randomBytes(12).toString('hex')}`,
      sentAt: new Date().toISOString(),
    };
  }

  async replyToMessage(input: {
    accessToken: string;
    replyToProviderMessageId: string;
    ccEmails?: string[];
    bodyText: string;
    bodyHtml?: string;
  }): Promise<{ providerMessageId: string; sentAt: string }> {
    const draft = await this.graphJson<Record<string, unknown>>(
      input.accessToken,
      `/me/messages/${encodeURIComponent(input.replyToProviderMessageId)}/createReply`,
      {
        method: 'POST',
        body: JSON.stringify({ comment: input.bodyText }),
      },
    );
    const draftId = String(draft['id'] ?? '').trim();
    if (!draftId) {
      throw new GraphApiError(
        502,
        'reply_draft_missing',
        'Microsoft Graph did not return a reply draft ID.',
      );
    }

    if ((input.ccEmails && input.ccEmails.length > 0) || input.bodyHtml) {
      const patchBody: Record<string, unknown> = {};
      if (input.ccEmails && input.ccEmails.length > 0) {
        patchBody['ccRecipients'] = input.ccEmails.map((address) => ({
          emailAddress: { address },
        }));
      }
      if (input.bodyHtml) {
        patchBody['body'] = { contentType: 'HTML', content: input.bodyHtml };
      }
      await this.graphRequest(input.accessToken, `/me/messages/${encodeURIComponent(draftId)}`, {
        method: 'PATCH',
        body: JSON.stringify(patchBody),
      });
    }

    await this.graphRequest(input.accessToken, `/me/messages/${encodeURIComponent(draftId)}/send`, {
      method: 'POST',
    });

    return {
      providerMessageId: draftId,
      sentAt: new Date().toISOString(),
    };
  }

  async createSubscription(input: {
    accessToken: string;
    folder: 'Inbox' | 'SentItems';
    notificationUrl: string;
    clientState: string;
    expirationDateTime: string;
  }): Promise<GraphSubscriptionResult> {
    const res = await this.graphJson<Record<string, unknown>>(input.accessToken, '/subscriptions', {
      method: 'POST',
      body: JSON.stringify({
        changeType: 'created',
        notificationUrl: input.notificationUrl,
        lifecycleNotificationUrl: input.notificationUrl,
        resource: `/me/mailFolders('${input.folder}')/messages`,
        expirationDateTime: input.expirationDateTime,
        clientState: input.clientState,
      }),
    });
    return {
      subscriptionId: String(res['id'] ?? ''),
      expiresAt: String(res['expirationDateTime'] ?? input.expirationDateTime),
    };
  }

  async renewSubscription(input: {
    accessToken: string;
    subscriptionId: string;
    expirationDateTime: string;
  }): Promise<GraphSubscriptionResult> {
    const res = await this.graphJson<Record<string, unknown>>(
      input.accessToken,
      `/subscriptions/${encodeURIComponent(input.subscriptionId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ expirationDateTime: input.expirationDateTime }),
      },
    );
    return {
      subscriptionId: String(res['id'] ?? input.subscriptionId),
      expiresAt: String(res['expirationDateTime'] ?? input.expirationDateTime),
    };
  }

  async deleteSubscription(accessToken: string, subscriptionId: string): Promise<void> {
    await this.graphRequest(accessToken, `/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      method: 'DELETE',
      allowNotFound: true,
    });
  }

  private parseGraphMessage(raw: Record<string, unknown>): GraphMailMessage {
    const id = String(raw['id'] ?? '');
    if (raw['@removed']) {
      return {
        id,
        conversationId: null,
        internetMessageId: null,
        inReplyTo: null,
        referencesHeader: null,
        headers: {},
        subject: '',
        bodyPreview: '',
        bodyContentType: 'text',
        bodyContent: '',
        fromEmail: '',
        toEmails: [],
        ccEmails: [],
        hasAttachments: false,
        sentAt: null,
        receivedAt: null,
        removed: true,
      };
    }

    const headers: Record<string, string> = {};
    if (Array.isArray(raw['internetMessageHeaders'])) {
      for (const h of raw['internetMessageHeaders'] as Record<string, unknown>[]) {
        const name = String(h['name'] ?? '')
          .trim()
          .toLowerCase();
        const val = String(h['value'] ?? '').trim();
        if (name && val) headers[name] = val;
      }
    }

    const extractAddress = (entry: unknown): string | null => {
      if (typeof entry !== 'object' || entry === null) return null;
      const emailObj = (entry as Record<string, unknown>)['emailAddress'];
      if (typeof emailObj !== 'object' || emailObj === null) return null;
      const addr = String((emailObj as Record<string, unknown>)['address'] ?? '')
        .trim()
        .toLowerCase();
      return addr || null;
    };

    const fromEmail = extractAddress(raw['from']) ?? '';
    const toEmails = Array.isArray(raw['toRecipients'])
      ? (raw['toRecipients'] as unknown[])
          .map(extractAddress)
          .filter((v): v is string => Boolean(v))
      : [];
    const ccEmails = Array.isArray(raw['ccRecipients'])
      ? (raw['ccRecipients'] as unknown[])
          .map(extractAddress)
          .filter((v): v is string => Boolean(v))
      : [];

    const bodyObj =
      typeof raw['body'] === 'object' && raw['body'] !== null
        ? (raw['body'] as Record<string, unknown>)
        : {};
    const contentTypeRaw = String(bodyObj['contentType'] ?? 'text').toLowerCase();
    const bodyContentType: 'text' | 'html' = contentTypeRaw === 'html' ? 'html' : 'text';
    const bodyContent = String(bodyObj['content'] ?? raw['bodyPreview'] ?? '');
    const bodyPreview = String(
      raw['bodyPreview'] ??
        (bodyContentType === 'html' ? stripHtmlTagsToText(bodyContent) : bodyContent),
    ).slice(0, 240);

    return {
      id,
      conversationId:
        typeof raw['conversationId'] === 'string' && raw['conversationId']
          ? raw['conversationId']
          : null,
      internetMessageId:
        typeof raw['internetMessageId'] === 'string' && raw['internetMessageId']
          ? raw['internetMessageId']
          : (headers['message-id'] ?? null),
      inReplyTo: headers['in-reply-to'] ?? null,
      referencesHeader: headers['references'] ?? null,
      headers,
      subject: String(raw['subject'] ?? '(No subject)'),
      bodyPreview,
      bodyContentType,
      bodyContent: bodyContentType === 'html' && !bodyContent.trim() ? bodyPreview : bodyContent,
      fromEmail,
      toEmails,
      ccEmails,
      hasAttachments: Boolean(raw['hasAttachments']),
      sentAt: typeof raw['sentDateTime'] === 'string' ? raw['sentDateTime'] : null,
      receivedAt: typeof raw['receivedDateTime'] === 'string' ? raw['receivedDateTime'] : null,
    };
  }

  private async graphRequest(
    accessToken: string,
    pathOrUrl: string,
    init: {
      method?: string;
      body?: string;
      headers?: Record<string, string>;
      allowNotFound?: boolean;
    } = {},
  ): Promise<Response> {
    const url = /^https?:\/\//i.test(pathOrUrl)
      ? pathOrUrl
      : `${this.graphBase}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      ...init.headers,
    };
    if (init.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await this.fetchFn(url, {
      method: init.method ?? 'GET',
      headers,
      body: init.body,
    });

    if (res.status === 429 || res.status === 503) {
      throw new GraphThrottleError(parseRetryAfterSeconds(res.headers.get('retry-after')));
    }
    if (res.status === 401) {
      throw new GraphAuthRevokedError();
    }
    if (init.allowNotFound && res.status === 404) {
      return res;
    }
    if (!res.ok) {
      const errJson = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const errObj =
        typeof errJson['error'] === 'object' && errJson['error'] !== null
          ? (errJson['error'] as Record<string, unknown>)
          : {};
      throw new GraphApiError(
        res.status,
        String(errObj['code'] ?? 'graph_error'),
        `Microsoft Graph returned HTTP ${res.status}.`,
      );
    }
    return res;
  }

  private async graphJson<T>(
    accessToken: string,
    pathOrUrl: string,
    init: { method?: string; body?: string; headers?: Record<string, string> } = {},
  ): Promise<T> {
    const res = await this.graphRequest(accessToken, pathOrUrl, init);
    return (await res.json()) as T;
  }
}

export { stripHtmlTagsToText };
