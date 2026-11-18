import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  CreateEmailTemplateInputSchema,
  CreateTaskFromEmailInputSchema,
  InboxThreadQuerySchema,
  ManualLinkEmailInputSchema,
  ReplyInboxThreadInputSchema,
  SendInboxEmailInputSchema,
  UpdateInboxThreadInputSchema,
  parseDsnHardBounce,
  renderEmailTemplate,
  sanitizeEmailHtml,
  type AdminMailboxRow,
  type EmailAttachmentView,
  type EmailMessageView,
  type EmailTemplateView,
  type InboxThreadDetail,
  type InboxThreadSummary,
  type MailboxProviderType,
  type MailboxStatusView,
  type SessionUser,
} from '@adas/shared';
import { type SecretBox } from '../../platform/crypto/index.js';
import { sha256Hex, type DatabaseService, type DbTx } from '../../platform/db/index.js';
import {
  DomainError,
  ForbiddenScopeError,
  NotFoundDomainError,
  ValidationDomainError,
} from '../../platform/errors/index.js';

function conflictError(code: string, detail: string): DomainError {
  return new DomainError({
    status: 409,
    code,
    title: 'Action cannot be completed',
    detail,
  });
}
import {
  GmailApiError,
  GmailAuthRevokedError,
  GmailThrottleError,
  GraphApiError,
  GraphAuthRevokedError,
  GraphThrottleError,
  type GoogleGmailMailboxClient,
  type GraphAttachmentMetadata,
  type GraphMailMessage,
  type MailpitTransport,
  type MicrosoftGraphMailboxClient,
  type OutboundEmailPayload,
  type OutboundEmailReceipt,
  type PendingMailOAuth,
  stripHtmlTagsToText,
} from '../../platform/mail-transport/index.js';
import {
  extractDomainFromEmail,
  isFreeMailDomain,
  normalizeEmail,
} from '../../platform/normalize/index.js';
import { requireCapability, scopeWhere } from '../../platform/scope/index.js';
import { addNotification } from '../notifications/index.js';

export interface InboxServiceOptions {
  nodeEnv: 'development' | 'test' | 'production';
  mailLive: boolean;
  publicHost: string;
  maxAttachmentBytes: number;
  secretBox: SecretBox | null;
  gmail?: GoogleGmailMailboxClient | null;
  googleWebhookToken?: string | null;
}

interface MailboxRow {
  id: string;
  user_id: string;
  email: string;
  provider: string;
  status: string;
  scopes: string;
  encrypted_refresh_token: string | null;
  encrypted_access_token: string | null;
  access_token_expires_at: Date | string | null;
  token_key_version: number;
  inbox_delta_link: string | null;
  sent_delta_link: string | null;
  gmail_history_id: string | null;
  inbox_subscription_id: string | null;
  inbox_subscription_expires_at: Date | string | null;
  sent_subscription_id: string | null;
  sent_subscription_expires_at: Date | string | null;
  client_state_sha256: string | null;
  sync_pending: boolean;
  retry_after_at: Date | string | null;
  last_error: string | null;
  last_synced_at: Date | string | null;
  daily_send_cap: number;
  sent_today_count: number;
}

interface MatchedCrmTarget {
  contactId: string | null;
  contactName: string | null;
  contactEmail: string | null;
  companyId: string | null;
  companyName: string | null;
  leadId: string | null;
  dealId: string | null;
  ownerUserId: string;
  teamId: string | null;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function normalizeSubjectBase(subject: string): string {
  return subject.replace(/^(?:\s*(?:re|fw|fwd)\s*:\s*)+/i, '').trim() || '(No subject)';
}

function parseJsonStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v));
  }
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map((v) => String(v));
    } catch {
      return [];
    }
  }
  return [];
}

function accessTokenContext(userId: string): string {
  return `mailbox_connection:${userId}:access`;
}

function refreshTokenContext(userId: string): string {
  return `mailbox_connection:${userId}:refresh`;
}

export class InboxService {
  constructor(
    private readonly db: DatabaseService,
    private readonly graph: MicrosoftGraphMailboxClient,
    private readonly mailpit: MailpitTransport,
    private readonly options: InboxServiceOptions,
  ) {
    if (this.options.mailLive && this.options.nodeEnv !== 'production') {
      throw new Error('Safety guard: InboxService refuses MAIL_LIVE outside production.');
    }
  }

  private normalizeProvider(raw: string | null | undefined): MailboxProviderType {
    return raw === 'google_gmail' ? 'google_gmail' : 'microsoft_graph';
  }

  private providerLabel(provider: MailboxProviderType): string {
    return provider === 'google_gmail' ? 'Google Workspace' : 'Microsoft 365';
  }

  private requireGmail(): GoogleGmailMailboxClient {
    if (!this.options.gmail || !this.options.gmail.isConfigured()) {
      throw new DomainError({
        status: 503,
        code: 'GOOGLE_GMAIL_NOT_CONFIGURED',
        title: 'Google Workspace OAuth client not configured',
        detail:
          'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET_FILE before connecting a Google Workspace mailbox.',
      });
    }
    return this.options.gmail;
  }

  private requireSecretBox(): SecretBox {
    if (!this.options.secretBox) {
      throw new DomainError({
        status: 503,
        code: 'ENCRYPTION_KEY_MISSING',
        title: 'Token encryption key not configured',
        detail:
          'Configure TOKEN_ENCRYPTION_KEY_FILE with at least 32 characters before connecting a mailbox.',
      });
    }
    return this.options.secretBox;
  }

  // -------------------------------------------------------------------------
  // 1. Mailbox Connection Status, Delegated OAuth2 Connect & Disconnect (PRD 4.11, 8.2, 15 Q2)
  // -------------------------------------------------------------------------

  async getMailboxStatus(user: SessionUser): Promise<MailboxStatusView> {
    requireCapability(user, 'inbox.read');
    const res = await this.db.query<MailboxRow>(
      `SELECT * FROM mailbox_connections WHERE user_id = $1 LIMIT 1`,
      [user.id],
    );
    const row = res.rows[0];
    const googleConfigured = Boolean(this.options.gmail?.isConfigured());
    if (!row) {
      return {
        connected: false,
        status: 'not_connected',
        email: null,
        provider: null,
        entraConfigured: this.graph.isConfigured(),
        googleConfigured,
        mailLive: this.options.mailLive,
        dailySendCap: 50,
        sentTodayCount: 0,
        lastSyncedAt: null,
        inboxSubscriptionExpiresAt: null,
        sentSubscriptionExpiresAt: null,
        retryAfterAt: null,
        lastError: null,
      };
    }

    const statusNorm = (
      ['connected', 'Needs Reconnect', 'disconnected'].includes(row.status)
        ? row.status
        : 'disconnected'
    ) as MailboxStatusView['status'];

    return {
      connected: statusNorm === 'connected',
      status: statusNorm,
      email: row.email,
      provider: this.normalizeProvider(row.provider),
      entraConfigured: this.graph.isConfigured(),
      googleConfigured,
      mailLive: this.options.mailLive,
      dailySendCap: row.daily_send_cap,
      sentTodayCount: row.sent_today_count,
      lastSyncedAt: toIso(row.last_synced_at),
      inboxSubscriptionExpiresAt: toIso(row.inbox_subscription_expires_at),
      sentSubscriptionExpiresAt: toIso(row.sent_subscription_expires_at),
      retryAfterAt: toIso(row.retry_after_at),
      lastError: row.last_error,
    };
  }

  async listAdminMailboxes(user: SessionUser): Promise<{ items: AdminMailboxRow[] }> {
    requireCapability(user, 'settings.manage');
    const res = await this.db.query<MailboxRow & { user_name: string }>(
      `SELECT m.*, u.name AS user_name
       FROM mailbox_connections m
       JOIN users u ON u.id = m.user_id
       ORDER BY m.updated_at DESC`,
    );
    return {
      items: res.rows.map((r) => ({
        id: r.id,
        userId: r.user_id,
        userName: r.user_name,
        email: r.email,
        provider: this.normalizeProvider(r.provider),
        status: r.status,
        dailySendCap: r.daily_send_cap,
        sentTodayCount: r.sent_today_count,
        lastSyncedAt: toIso(r.last_synced_at),
        inboxSubscriptionExpiresAt: toIso(r.inbox_subscription_expires_at),
        retryAfterAt: toIso(r.retry_after_at),
        lastError: r.last_error,
      })),
    };
  }

  startOAuthConnect(
    user: SessionUser,
    provider: MailboxProviderType = 'microsoft_graph',
  ): { url: string; pending: PendingMailOAuth } {
    requireCapability(user, 'inbox.send');
    this.requireSecretBox();
    if (provider === 'google_gmail') {
      return this.requireGmail().createAuthorizationRequest({
        userId: user.id,
        loginHint: user.email,
      });
    }
    if (!this.graph.isConfigured()) {
      throw new DomainError({
        status: 503,
        code: 'MICROSOFT_GRAPH_NOT_CONFIGURED',
        title: 'Microsoft 365 app registration not configured',
        detail:
          'Set ENTRA_TENANT_ID, ENTRA_CLIENT_ID and ENTRA_CLIENT_SECRET_FILE before connecting an Outlook mailbox.',
      });
    }
    const req = this.graph.createAuthorizationRequest({
      userId: user.id,
      loginHint: user.email,
    });
    return { url: req.url, pending: { ...req.pending, provider: 'microsoft_graph' } };
  }

  async finishOAuthConnect(
    user: SessionUser,
    input: { code: string; state: string; pending: PendingMailOAuth; ipAddress?: string | null },
  ): Promise<MailboxStatusView> {
    requireCapability(user, 'inbox.send');
    const box = this.requireSecretBox();
    const provider: MailboxProviderType =
      input.pending.provider === 'google_gmail' ? 'google_gmail' : 'microsoft_graph';

    if (input.pending.userId !== user.id || input.pending.state !== input.state) {
      throw new DomainError({
        status: 400,
        code: 'INVALID_OAUTH_STATE',
        title: 'Mailbox connection state mismatch',
        detail: `The ${this.providerLabel(provider)} authorization session expired or did not match your account.`,
      });
    }

    if (provider === 'google_gmail') {
      const gmail = this.requireGmail();
      const tokens = await gmail.exchangeAuthorizationCode({
        code: input.code,
        codeVerifier: input.pending.codeVerifier,
      });
      const profile = await gmail.getMailboxProfile(tokens.accessToken);
      const sealedAccess = box.seal(tokens.accessToken, accessTokenContext(user.id));
      const sealedRefresh = tokens.refreshToken
        ? box.seal(tokens.refreshToken, refreshTokenContext(user.id))
        : null;
      const accessExpiresAt = new Date(Date.now() + tokens.expiresInSeconds * 1000).toISOString();

      let watchSubId: string | null = null;
      let watchExp: string | null = null;
      try {
        const watched = await gmail.watchMailbox({ accessToken: tokens.accessToken });
        if (watched) {
          watchSubId = 'gmail_watch';
          watchExp = watched.expiresAt;
        }
      } catch {
        // 5-min history polling fallback remains active if Pub/Sub push is not configured.
      }

      const mailboxId = await this.db.transaction(async (tx) => {
        const existing = await tx.query<{ id: string; provider: string }>(
          `SELECT id, provider FROM mailbox_connections WHERE user_id = $1 LIMIT 1`,
          [user.id],
        );
        const id = existing.rows[0]?.id ?? `mbx_${randomUUID()}`;
        const preserveHistory = existing.rows[0]?.provider === 'google_gmail';

        await tx.query(
          `INSERT INTO mailbox_connections (
             id, user_id, email, provider, status, scopes,
             encrypted_access_token, encrypted_refresh_token, access_token_expires_at, token_key_version,
             inbox_delta_link, sent_delta_link, gmail_history_id,
             inbox_subscription_id, inbox_subscription_expires_at,
             sent_subscription_id, sent_subscription_expires_at,
             client_state_sha256, sync_pending, retry_after_at, last_error, connected_at, updated_at
           ) VALUES (
             $1, $2, $3, 'google_gmail', 'connected', $4,
             $5, $6, $7::timestamptz, $8,
             NULL, NULL, NULL,
             $9, $10::timestamptz,
             NULL, NULL,
             NULL, TRUE, NULL, NULL, NOW(), NOW()
           )
           ON CONFLICT (user_id) DO UPDATE SET
             email = EXCLUDED.email,
             provider = 'google_gmail',
             status = 'connected',
             scopes = EXCLUDED.scopes,
             encrypted_access_token = EXCLUDED.encrypted_access_token,
             encrypted_refresh_token = COALESCE(EXCLUDED.encrypted_refresh_token, CASE WHEN mailbox_connections.provider = 'google_gmail' THEN mailbox_connections.encrypted_refresh_token ELSE NULL END),
             access_token_expires_at = EXCLUDED.access_token_expires_at,
             token_key_version = EXCLUDED.token_key_version,
             inbox_delta_link = NULL,
             sent_delta_link = NULL,
             gmail_history_id = CASE WHEN $11::boolean AND LOWER(mailbox_connections.email) = LOWER(EXCLUDED.email) THEN mailbox_connections.gmail_history_id ELSE NULL END,
             inbox_subscription_id = EXCLUDED.inbox_subscription_id,
             inbox_subscription_expires_at = EXCLUDED.inbox_subscription_expires_at,
             sent_subscription_id = NULL,
             sent_subscription_expires_at = NULL,
             client_state_sha256 = NULL,
             sync_pending = TRUE,
             retry_after_at = NULL,
             last_error = NULL,
             connected_at = NOW(),
             updated_at = NOW()`,
          [
            id,
            user.id,
            profile.email,
            tokens.scope,
            sealedAccess,
            sealedRefresh,
            accessExpiresAt,
            box.keyVersion,
            watchSubId,
            watchExp,
            preserveHistory,
          ],
        );

        await this.db.writeAuditLog(tx, {
          actorUserId: user.id,
          action: 'mailbox.connected',
          entityType: 'mailbox_connection',
          entityId: id,
          metadata: {
            provider: 'google_gmail',
            tokenKeyVersion: box.keyVersion,
            webhooksSubscribed: Boolean(watchSubId),
          },
          ipAddress: input.ipAddress ?? null,
        });

        return id;
      });

      // Run initial 90-day scan immediately on connection (PRD 8.2)
      await this.syncMailboxById(mailboxId).catch(() => undefined);
      return this.getMailboxStatus(user);
    }

    const { tokens, profile } = await this.graph.exchangeCodeForTokens({
      code: input.code,
      codeVerifier: input.pending.codeVerifier,
    });

    const sealedAccess = box.seal(tokens.accessToken, accessTokenContext(user.id));
    const sealedRefresh = tokens.refreshToken
      ? box.seal(tokens.refreshToken, refreshTokenContext(user.id))
      : null;
    const accessExpiresAt = new Date(Date.now() + tokens.expiresInSeconds * 1000).toISOString();

    const rawClientState = randomBytes(24).toString('base64url');
    const clientStateSha256 = sha256Hex(rawClientState);
    const notificationUrl = `https://${this.options.publicHost}/api/v1/webhooks/microsoft`;
    const subExpiresAt = new Date(Date.now() + 2.8 * 86_400_000).toISOString();

    let inboxSubId: string | null = null;
    let inboxSubExp: string | null = null;
    let sentSubId: string | null = null;
    let sentSubExp: string | null = null;

    try {
      const inboxSub = await this.graph.createSubscription({
        accessToken: tokens.accessToken,
        folder: 'Inbox',
        notificationUrl,
        clientState: rawClientState,
        expirationDateTime: subExpiresAt,
      });
      inboxSubId = inboxSub.subscriptionId;
      inboxSubExp = inboxSub.expiresAt;

      const sentSub = await this.graph.createSubscription({
        accessToken: tokens.accessToken,
        folder: 'SentItems',
        notificationUrl,
        clientState: rawClientState,
        expirationDateTime: subExpiresAt,
      });
      sentSubId = sentSub.subscriptionId;
      sentSubExp = sentSub.expiresAt;
    } catch {
      // If webhook registration fails in local dev (non-HTTPS callback), 5-min delta polling remains active (PRD 8.2).
    }

    const mailboxId = await this.db.transaction(async (tx) => {
      const existing = await tx.query<{ id: string }>(
        `SELECT id FROM mailbox_connections WHERE user_id = $1 LIMIT 1`,
        [user.id],
      );
      const id = existing.rows[0]?.id ?? `mbx_${randomUUID()}`;
      await tx.query(
        `INSERT INTO mailbox_connections (
           id, user_id, email, provider, status, scopes,
           encrypted_access_token, encrypted_refresh_token, access_token_expires_at, token_key_version,
           inbox_subscription_id, inbox_subscription_expires_at,
           sent_subscription_id, sent_subscription_expires_at,
           client_state_sha256, sync_pending, retry_after_at, last_error, connected_at, updated_at
         ) VALUES (
           $1, $2, $3, 'microsoft_graph', 'connected', $4,
           $5, $6, $7::timestamptz, $8,
           $9, $10::timestamptz,
           $11, $12::timestamptz,
           $13, TRUE, NULL, NULL, NOW(), NOW()
         )
         ON CONFLICT (user_id) DO UPDATE SET
           email = EXCLUDED.email,
           provider = 'microsoft_graph',
           status = 'connected',
           scopes = EXCLUDED.scopes,
           encrypted_access_token = EXCLUDED.encrypted_access_token,
           encrypted_refresh_token = COALESCE(EXCLUDED.encrypted_refresh_token, CASE WHEN mailbox_connections.provider = 'microsoft_graph' THEN mailbox_connections.encrypted_refresh_token ELSE NULL END),
           access_token_expires_at = EXCLUDED.access_token_expires_at,
           token_key_version = EXCLUDED.token_key_version,
           gmail_history_id = NULL,
           inbox_subscription_id = COALESCE(EXCLUDED.inbox_subscription_id, CASE WHEN mailbox_connections.provider = 'microsoft_graph' THEN mailbox_connections.inbox_subscription_id ELSE NULL END),
           inbox_subscription_expires_at = COALESCE(EXCLUDED.inbox_subscription_expires_at, CASE WHEN mailbox_connections.provider = 'microsoft_graph' THEN mailbox_connections.inbox_subscription_expires_at ELSE NULL END),
           sent_subscription_id = COALESCE(EXCLUDED.sent_subscription_id, CASE WHEN mailbox_connections.provider = 'microsoft_graph' THEN mailbox_connections.sent_subscription_id ELSE NULL END),
           sent_subscription_expires_at = COALESCE(EXCLUDED.sent_subscription_expires_at, CASE WHEN mailbox_connections.provider = 'microsoft_graph' THEN mailbox_connections.sent_subscription_expires_at ELSE NULL END),
           client_state_sha256 = EXCLUDED.client_state_sha256,
           sync_pending = TRUE,
           retry_after_at = NULL,
           last_error = NULL,
           connected_at = NOW(),
           updated_at = NOW()`,
        [
          id,
          user.id,
          profile.email,
          tokens.scope,
          sealedAccess,
          sealedRefresh,
          accessExpiresAt,
          box.keyVersion,
          inboxSubId,
          inboxSubExp,
          sentSubId,
          sentSubExp,
          clientStateSha256,
        ],
      );

      await this.db.writeAuditLog(tx, {
        actorUserId: user.id,
        action: 'mailbox.connected',
        entityType: 'mailbox_connection',
        entityId: id,
        metadata: {
          provider: 'microsoft_graph',
          tokenKeyVersion: box.keyVersion,
          webhooksSubscribed: Boolean(inboxSubId && sentSubId),
        },
        ipAddress: input.ipAddress ?? null,
      });

      return id;
    });

    // Run initial 90-day delta sync immediately on connection (PRD 8.2)
    await this.syncMailboxById(mailboxId).catch(() => undefined);

    return this.getMailboxStatus(user);
  }

  /**
   * PRD 4.12 & 8.2: Disconnecting a mailbox deletes remote subscriptions, clears encrypted tokens,
   * and pauses that user's active sequence enrollments.
   */
  async disconnectMailbox(
    user: SessionUser,
    ipAddress?: string | null,
  ): Promise<{ disconnected: boolean; pausedSequences: number }> {
    requireCapability(user, 'inbox.send');
    const res = await this.db.query<MailboxRow>(
      `SELECT * FROM mailbox_connections WHERE user_id = $1 LIMIT 1`,
      [user.id],
    );
    const row = res.rows[0];
    if (!row) {
      return { disconnected: false, pausedSequences: 0 };
    }

    const provider = this.normalizeProvider(row.provider);
    if (provider === 'microsoft_graph' && this.options.secretBox && row.encrypted_access_token) {
      try {
        const accessToken = this.options.secretBox.open(
          row.encrypted_access_token,
          accessTokenContext(user.id),
        );
        if (row.inbox_subscription_id) {
          await this.graph.deleteSubscription(accessToken, row.inbox_subscription_id);
        }
        if (row.sent_subscription_id) {
          await this.graph.deleteSubscription(accessToken, row.sent_subscription_id);
        }
      } catch {
        // Best-effort remote subscription cleanup; local revocation always proceeds.
      }
    }

    return this.db.transaction(async (tx) => {
      await tx.query(
        `UPDATE mailbox_connections
         SET status = 'disconnected',
             encrypted_access_token = NULL,
             encrypted_refresh_token = NULL,
             access_token_expires_at = NULL,
             inbox_subscription_id = NULL,
             inbox_subscription_expires_at = NULL,
             sent_subscription_id = NULL,
             sent_subscription_expires_at = NULL,
             client_state_sha256 = NULL,
             sync_pending = FALSE,
             updated_at = NOW()
         WHERE id = $1`,
        [row.id],
      );

      const paused = await tx.query(
        `UPDATE sequence_enrollments
         SET status = 'paused',
             stop_reason = 'Sender mailbox disconnected'
         WHERE sender_user_id = $1 AND status = 'active'`,
        [user.id],
      );

      await this.db.writeAuditLog(tx, {
        actorUserId: user.id,
        action: 'mailbox.disconnected',
        entityType: 'mailbox_connection',
        entityId: row.id,
        metadata: { provider, pausedSequenceEnrollments: paused.rowCount },
        ipAddress: ipAddress ?? null,
      });

      return { disconnected: true, pausedSequences: paused.rowCount };
    });
  }

  // -------------------------------------------------------------------------
  // 2. Token Refresh, Delta Sync, Subscriptions & Webhook Handling (PRD 8.2, 8.3)
  // -------------------------------------------------------------------------

  private async ensureAccessToken(row: MailboxRow): Promise<string> {
    const box = this.requireSecretBox();
    const provider = this.normalizeProvider(row.provider);
    const label = this.providerLabel(provider);
    const expiresMs = row.access_token_expires_at
      ? new Date(row.access_token_expires_at).getTime()
      : 0;

    if (row.encrypted_access_token && expiresMs > Date.now() + 90_000) {
      return box.open(row.encrypted_access_token, accessTokenContext(row.user_id));
    }

    if (!row.encrypted_refresh_token) {
      await this.markMailboxNeedsReconnect(row, 'Missing refresh token');
      throw conflictError(
        'MAILBOX_RECONNECT_REQUIRED',
        `Your ${label} mailbox needs to be reconnected before syncing or sending.`,
      );
    }

    const refreshPlain = box.open(row.encrypted_refresh_token, refreshTokenContext(row.user_id));
    try {
      const refreshed =
        provider === 'google_gmail'
          ? await this.requireGmail().refreshAccessToken(refreshPlain)
          : await this.graph.refreshAccessToken(refreshPlain);
      const sealedAccess = box.seal(refreshed.accessToken, accessTokenContext(row.user_id));
      const sealedRefresh = refreshed.refreshToken
        ? box.seal(refreshed.refreshToken, refreshTokenContext(row.user_id))
        : row.encrypted_refresh_token;
      const newExpiresAt = new Date(Date.now() + refreshed.expiresInSeconds * 1000).toISOString();

      await this.db.query(
        `UPDATE mailbox_connections
         SET encrypted_access_token = $2,
             encrypted_refresh_token = $3,
             access_token_expires_at = $4::timestamptz,
             token_key_version = $5,
             status = 'connected',
             last_error = NULL,
             updated_at = NOW()
         WHERE id = $1`,
        [row.id, sealedAccess, sealedRefresh, newExpiresAt, box.keyVersion],
      );
      return refreshed.accessToken;
    } catch (err) {
      if (err instanceof GraphAuthRevokedError || err instanceof GmailAuthRevokedError) {
        await this.markMailboxNeedsReconnect(row, `${label} authorization expired`);
        throw conflictError(
          'MAILBOX_RECONNECT_REQUIRED',
          `Your ${label} authorization expired. Reconnect your mailbox in Inbox.`,
        );
      }
      throw err;
    }
  }

  private async markMailboxNeedsReconnect(row: MailboxRow, reason: string): Promise<void> {
    const label = this.providerLabel(this.normalizeProvider(row.provider));
    await this.db.transaction(async (tx) => {
      await tx.query(
        `UPDATE mailbox_connections
         SET status = 'Needs Reconnect',
             encrypted_access_token = NULL,
             sync_pending = FALSE,
             last_error = $2,
             updated_at = NOW()
         WHERE id = $1`,
        [row.id, reason],
      );
      await tx.query(
        `UPDATE sequence_enrollments
         SET status = 'paused',
             stop_reason = 'Sender mailbox needs reconnect'
         WHERE sender_user_id = $1 AND status = 'active'`,
        [row.user_id],
      );
      await addNotification(tx, {
        userId: row.user_id,
        kind: 'general',
        title: `Reconnect your ${label} mailbox`,
        body: `Email sync and sequences are paused until you sign back into ${label}.`,
        entityType: 'mailbox_connection',
        entityId: row.id,
        dedupeKey: `mbx_reconnect:${row.id}:${new Date().toISOString().slice(0, 10)}`,
      });
    });
  }

  async syncUserMailboxNow(user: SessionUser): Promise<{
    syncedMessages: number;
    ignoredMessages: number;
    bouncesProcessed: number;
    throttledUntil: string | null;
  }> {
    requireCapability(user, 'inbox.read');
    const res = await this.db.query<MailboxRow>(
      `SELECT * FROM mailbox_connections WHERE user_id = $1 LIMIT 1`,
      [user.id],
    );
    const row = res.rows[0];
    if (!row || row.status !== 'connected') {
      throw conflictError(
        'MAILBOX_NOT_CONNECTED',
        'Connect your Microsoft 365 or Google Workspace mailbox first.',
      );
    }
    if (!row.encrypted_access_token && !row.encrypted_refresh_token) {
      // Seeded development mailbox without live provider tokens: report clean state without faking traffic.
      await this.db.query(
        `UPDATE mailbox_connections SET last_synced_at = NOW(), sync_pending = FALSE, updated_at = NOW() WHERE id = $1`,
        [row.id],
      );
      return { syncedMessages: 0, ignoredMessages: 0, bouncesProcessed: 0, throttledUntil: null };
    }
    return this.syncMailboxById(row.id);
  }

  async syncMailboxById(mailboxId: string): Promise<{
    syncedMessages: number;
    ignoredMessages: number;
    bouncesProcessed: number;
    throttledUntil: string | null;
  }> {
    const res = await this.db.query<MailboxRow>(
      `SELECT * FROM mailbox_connections WHERE id = $1 LIMIT 1`,
      [mailboxId],
    );
    const row = res.rows[0];
    if (!row || row.status !== 'connected') {
      return { syncedMessages: 0, ignoredMessages: 0, bouncesProcessed: 0, throttledUntil: null };
    }
    if (!row.encrypted_access_token && !row.encrypted_refresh_token) {
      return { syncedMessages: 0, ignoredMessages: 0, bouncesProcessed: 0, throttledUntil: null };
    }

    if (row.retry_after_at && new Date(row.retry_after_at).getTime() > Date.now()) {
      return {
        syncedMessages: 0,
        ignoredMessages: 0,
        bouncesProcessed: 0,
        throttledUntil: toIso(row.retry_after_at),
      };
    }

    const provider = this.normalizeProvider(row.provider);
    let syncedMessages = 0;
    let ignoredMessages = 0;
    let bouncesProcessed = 0;

    try {
      const accessToken = await this.ensureAccessToken(row);

      if (provider === 'google_gmail') {
        const gmail = this.requireGmail();
        const syncRes = await gmail.syncMessages({
          accessToken,
          mailboxEmail: row.email,
          startHistoryId: row.gmail_history_id,
        });

        for (const item of syncRes.items) {
          if (item.message.removed || !item.message.id) continue;
          const outcome = await this.ingestGraphMessage(
            row,
            item.direction,
            item.message,
            null,
            undefined,
            item.attachments,
          );
          if (outcome.bounced) bouncesProcessed += 1;
          else if (outcome.synced) syncedMessages += 1;
          else ignoredMessages += 1;
        }

        await this.db.query(
          `UPDATE mailbox_connections
           SET gmail_history_id = COALESCE($2, gmail_history_id),
               last_synced_at = NOW(),
               sync_pending = FALSE,
               retry_after_at = NULL,
               last_error = NULL,
               updated_at = NOW()
           WHERE id = $1`,
          [row.id, syncRes.nextHistoryId],
        );

        return { syncedMessages, ignoredMessages, bouncesProcessed, throttledUntil: null };
      }

      const sinceIso = new Date(Date.now() - 90 * 86_400_000).toISOString();

      const inboxDelta = await this.graph.fetchFolderDelta({
        accessToken,
        folder: 'Inbox',
        deltaLink: row.inbox_delta_link,
        sinceIso,
      });

      for (const msg of inboxDelta.messages) {
        if (msg.removed || !msg.id) continue;
        const outcome = await this.ingestGraphMessage(row, 'inbound', msg, accessToken);
        if (outcome.bounced) bouncesProcessed += 1;
        else if (outcome.synced) syncedMessages += 1;
        else ignoredMessages += 1;
      }

      const sentDelta = await this.graph.fetchFolderDelta({
        accessToken,
        folder: 'SentItems',
        deltaLink: row.sent_delta_link,
        sinceIso,
      });

      for (const msg of sentDelta.messages) {
        if (msg.removed || !msg.id) continue;
        const outcome = await this.ingestGraphMessage(row, 'outbound', msg, accessToken);
        if (outcome.synced) syncedMessages += 1;
        else ignoredMessages += 1;
      }

      await this.db.query(
        `UPDATE mailbox_connections
         SET inbox_delta_link = $2,
             sent_delta_link = $3,
             last_synced_at = NOW(),
             sync_pending = FALSE,
             retry_after_at = NULL,
             last_error = NULL,
             updated_at = NOW()
         WHERE id = $1`,
        [
          row.id,
          inboxDelta.nextDeltaLink ?? row.inbox_delta_link,
          sentDelta.nextDeltaLink ?? row.sent_delta_link,
        ],
      );

      return { syncedMessages, ignoredMessages, bouncesProcessed, throttledUntil: null };
    } catch (err) {
      if (err instanceof GraphThrottleError || err instanceof GmailThrottleError) {
        const retryAt = new Date(Date.now() + err.retryAfterSeconds * 1000).toISOString();
        const prefix = err instanceof GmailThrottleError ? 'Gmail' : 'Graph';
        await this.db.query(
          `UPDATE mailbox_connections
           SET retry_after_at = $2::timestamptz,
               last_error = $3,
               updated_at = NOW()
           WHERE id = $1`,
          [row.id, retryAt, `${prefix} throttled (429); backing off ${err.retryAfterSeconds}s`],
        );
        return { syncedMessages, ignoredMessages, bouncesProcessed, throttledUntil: retryAt };
      }
      if (err instanceof GraphAuthRevokedError || err instanceof GmailAuthRevokedError) {
        await this.markMailboxNeedsReconnect(
          row,
          `${this.providerLabel(provider)} authorization expired`,
        );
        return { syncedMessages, ignoredMessages, bouncesProcessed, throttledUntil: null };
      }
      const safeError =
        err instanceof GraphApiError
          ? `Graph HTTP ${err.status} (${err.code})`
          : err instanceof GmailApiError
            ? `Gmail HTTP ${err.status} (${err.code})`
            : 'Sync failed';
      await this.db.query(
        `UPDATE mailbox_connections SET last_error = $2, sync_pending = FALSE, updated_at = NOW() WHERE id = $1`,
        [row.id, safeError],
      );
      throw err;
    }
  }

  /**
   * Worker job `mail.sync`: syncs connected mailboxes queued by webhook notifications or due for
   * their 5-minute fallback delta poll (PRD 6.9, 8.2).
   */
  async syncDueMailboxes(
    limit = 15,
  ): Promise<{ mailboxesChecked: number; syncedMessages: number }> {
    const due = await this.db.query<{ id: string }>(
      `SELECT id
       FROM mailbox_connections
       WHERE status = 'connected'
         AND (encrypted_access_token IS NOT NULL OR encrypted_refresh_token IS NOT NULL)
         AND (retry_after_at IS NULL OR retry_after_at <= NOW())
         AND (
           sync_pending = TRUE
           OR last_synced_at IS NULL
           OR last_synced_at <= NOW() - INTERVAL '5 minutes'
         )
       ORDER BY sync_pending DESC, last_synced_at ASC NULLS FIRST
       LIMIT $1`,
      [limit],
    );

    let syncedMessages = 0;
    for (const row of due.rows) {
      try {
        const res = await this.syncMailboxById(row.id);
        syncedMessages += res.syncedMessages;
      } catch {
        // Individual mailbox failure is recorded on `last_error` without aborting other mailboxes.
      }
    }
    return { mailboxesChecked: due.rowCount, syncedMessages };
  }

  /**
   * Worker job `mail.subscriptions.renew`: renews Microsoft Graph subscriptions and Google Gmail
   * Pub/Sub `users.watch` leases well before expiry (within 24 hours, PRD 6.9, 8.2).
   */
  async renewExpiringSubscriptions(): Promise<{ renewed: number }> {
    const expiring = await this.db.query<MailboxRow>(
      `SELECT *
       FROM mailbox_connections
       WHERE status = 'connected'
         AND (encrypted_access_token IS NOT NULL OR encrypted_refresh_token IS NOT NULL)
         AND (
           (inbox_subscription_id IS NOT NULL AND inbox_subscription_expires_at <= NOW() + INTERVAL '24 hours')
           OR (sent_subscription_id IS NOT NULL AND sent_subscription_expires_at <= NOW() + INTERVAL '24 hours')
         )
       LIMIT 25`,
    );

    let renewed = 0;
    const newExpiry = new Date(Date.now() + 2.8 * 86_400_000).toISOString();

    for (const row of expiring.rows) {
      try {
        const accessToken = await this.ensureAccessToken(row);
        if (this.normalizeProvider(row.provider) === 'google_gmail') {
          if (this.options.gmail?.isConfigured()) {
            const watched = await this.options.gmail.watchMailbox({ accessToken });
            if (watched) {
              await this.db.query(
                `UPDATE mailbox_connections
                 SET inbox_subscription_id = 'gmail_watch',
                     inbox_subscription_expires_at = $2::timestamptz,
                     updated_at = NOW()
                 WHERE id = $1`,
                [row.id, watched.expiresAt],
              );
              renewed += 1;
            }
          }
          continue;
        }
        if (row.inbox_subscription_id) {
          const sub = await this.graph.renewSubscription({
            accessToken,
            subscriptionId: row.inbox_subscription_id,
            expirationDateTime: newExpiry,
          });
          await this.db.query(
            `UPDATE mailbox_connections
             SET inbox_subscription_expires_at = $2::timestamptz, updated_at = NOW()
             WHERE id = $1`,
            [row.id, sub.expiresAt],
          );
          renewed += 1;
        }
        if (row.sent_subscription_id) {
          const sub = await this.graph.renewSubscription({
            accessToken,
            subscriptionId: row.sent_subscription_id,
            expirationDateTime: newExpiry,
          });
          await this.db.query(
            `UPDATE mailbox_connections
             SET sent_subscription_expires_at = $2::timestamptz, updated_at = NOW()
             WHERE id = $1`,
            [row.id, sub.expiresAt],
          );
          renewed += 1;
        }
      } catch {
        // Logged on next sync / retry cycle.
      }
    }
    return { renewed };
  }

  /**
   * Public webhook `POST /api/v1/webhooks/microsoft` on `go.` (PRD 8.2, 9):
   * Verifies `clientState` hash in constant time, deduplicates via `inbound_events`, handles
   * lifecycle notifications, and marks matching mailboxes `sync_pending = TRUE`.
   */
  async handleMicrosoftWebhook(payload: Record<string, unknown>): Promise<{
    accepted: number;
    ignored: number;
  }> {
    const items = Array.isArray(payload['value'])
      ? (payload['value'] as Record<string, unknown>[])
      : [];

    let accepted = 0;
    let ignored = 0;

    for (const item of items) {
      const subscriptionId = String(item['subscriptionId'] ?? '').trim();
      const clientState = String(item['clientState'] ?? '').trim();
      if (!subscriptionId || !clientState) {
        ignored += 1;
        continue;
      }

      const mbxRes = await this.db.query<MailboxRow>(
        `SELECT * FROM mailbox_connections
         WHERE inbox_subscription_id = $1 OR sent_subscription_id = $1
         LIMIT 1`,
        [subscriptionId],
      );
      const mailbox = mbxRes.rows[0];
      if (!mailbox || !mailbox.client_state_sha256) {
        ignored += 1;
        continue;
      }

      const candidateHash = Buffer.from(sha256Hex(clientState), 'utf8');
      const storedHash = Buffer.from(mailbox.client_state_sha256, 'utf8');
      if (
        candidateHash.length !== storedHash.length ||
        !timingSafeEqual(candidateHash, storedHash)
      ) {
        ignored += 1;
        continue;
      }

      const resourceId = String(
        (item['resourceData'] as Record<string, unknown> | undefined)?.['id'] ??
          item['resource'] ??
          '',
      );
      const changeType = String(item['changeType'] ?? item['lifecycleEvent'] ?? 'updated');
      const eventKey = `${subscriptionId}:${changeType}:${resourceId}`;

      const inserted = await this.db.query(
        `INSERT INTO inbound_events (id, provider, provider_event_id, processed_at, status, metadata)
         VALUES ($1, 'microsoft_graph', $2, NOW(), 'processed', $3::jsonb)
         ON CONFLICT (provider, provider_event_id) DO NOTHING`,
        [`ine_${randomUUID()}`, eventKey, JSON.stringify({ mailboxId: mailbox.id, changeType })],
      );
      if (inserted.rowCount === 0) {
        ignored += 1;
        continue;
      }

      const lifecycle = String(item['lifecycleEvent'] ?? '');
      if (lifecycle === 'reauthorizationRequired') {
        await this.db.query(
          `UPDATE mailbox_connections
           SET inbox_subscription_expires_at = LEAST(COALESCE(inbox_subscription_expires_at, NOW()), NOW() + INTERVAL '1 hour'),
               sync_pending = TRUE,
               updated_at = NOW()
           WHERE id = $1`,
          [mailbox.id],
        );
      } else {
        await this.db.query(
          `UPDATE mailbox_connections SET sync_pending = TRUE, updated_at = NOW() WHERE id = $1`,
          [mailbox.id],
        );
      }
      accepted += 1;
    }

    return { accepted, ignored };
  }

  /**
   * Public Google Cloud Pub/Sub push webhook `POST /api/v1/webhooks/google` on `go.` (PRD 8.2, 9, 15 Q2):
   * Verifies the shared webhook secret in constant time, decodes the base64 Pub/Sub `message.data`
   * (`{ emailAddress, historyId }`), deduplicates via `inbound_events`, and flags `sync_pending = TRUE`.
   */
  async handleGoogleWebhook(
    payload: Record<string, unknown>,
    suppliedToken?: string | null,
  ): Promise<{ accepted: number; ignored: number }> {
    const expectedToken = (this.options.googleWebhookToken ?? '').trim();
    if (!expectedToken || !suppliedToken) {
      throw new DomainError({
        status: 401,
        code: 'WEBHOOK_UNAUTHORIZED',
        title: 'Invalid webhook credentials',
        detail: 'Missing or unconfigured Google webhook verification token.',
      });
    }

    const expectedDigest = createHash('sha256').update(expectedToken, 'utf8').digest();
    const suppliedDigest = createHash('sha256').update(suppliedToken.trim(), 'utf8').digest();
    if (!timingSafeEqual(expectedDigest, suppliedDigest)) {
      throw new DomainError({
        status: 401,
        code: 'WEBHOOK_UNAUTHORIZED',
        title: 'Invalid webhook credentials',
        detail: 'Google webhook verification token mismatch.',
      });
    }

    const msgObj =
      typeof payload['message'] === 'object' && payload['message'] !== null
        ? (payload['message'] as Record<string, unknown>)
        : null;
    if (!msgObj || typeof msgObj['data'] !== 'string') {
      return { accepted: 0, ignored: 1 };
    }

    let decodedJson: Record<string, unknown>;
    try {
      const decodedStr = Buffer.from(msgObj['data'], 'base64').toString('utf8');
      const parsed: unknown = JSON.parse(decodedStr);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { accepted: 0, ignored: 1 };
      }
      decodedJson = parsed as Record<string, unknown>;
    } catch {
      return { accepted: 0, ignored: 1 };
    }

    const emailAddress = normalizeEmail(String(decodedJson['emailAddress'] ?? ''));
    const historyId = String(decodedJson['historyId'] ?? '').trim();
    if (!emailAddress) {
      return { accepted: 0, ignored: 1 };
    }

    const mbxRes = await this.db.query<MailboxRow>(
      `SELECT * FROM mailbox_connections
       WHERE provider = 'google_gmail' AND LOWER(email) = $1 AND status = 'connected'
       LIMIT 1`,
      [emailAddress],
    );
    const mailbox = mbxRes.rows[0];
    if (!mailbox) {
      return { accepted: 0, ignored: 1 };
    }

    const pubsubMessageId = String(msgObj['messageId'] ?? msgObj['message_id'] ?? '').trim();
    const eventKey = pubsubMessageId || `${mailbox.id}:${historyId || 'notify'}`;

    const inserted = await this.db.query(
      `INSERT INTO inbound_events (id, provider, provider_event_id, processed_at, status, metadata)
       VALUES ($1, 'google_gmail', $2, NOW(), 'processed', $3::jsonb)
       ON CONFLICT (provider, provider_event_id) DO NOTHING`,
      [`ine_${randomUUID()}`, eventKey, JSON.stringify({ mailboxId: mailbox.id, historyId })],
    );
    if (inserted.rowCount === 0) {
      return { accepted: 0, ignored: 1 };
    }

    await this.db.query(
      `UPDATE mailbox_connections SET sync_pending = TRUE, updated_at = NOW() WHERE id = $1`,
      [mailbox.id],
    );

    return { accepted: 1, ignored: 0 };
  }

  // -------------------------------------------------------------------------
  // 3. Message Ingestion, Sync Rule, Reply Detection & DSN Hard Bounces (PRD 4.11, 8.3, A11)
  // -------------------------------------------------------------------------

  async ingestGraphMessage(
    mailbox: Pick<MailboxRow, 'id' | 'user_id' | 'email'> & { provider?: string },
    direction: 'inbound' | 'outbound',
    msg: GraphMailMessage,
    accessTokenForAttachments?: string | null,
    manualTarget?: { contactId?: string | null; companyId?: string | null; dealId?: string | null },
    preloadedAttachments?: GraphAttachmentMetadata[],
  ): Promise<{
    synced: boolean;
    bounced: boolean;
    reason?: string;
    threadId: string | null;
    messageId: string | null;
    stoppedSequenceEnrollments: number;
  }> {
    const plainBody =
      msg.bodyContentType === 'html'
        ? stripHtmlTagsToText(msg.bodyContent) || msg.bodyPreview
        : msg.bodyContent || msg.bodyPreview;

    // 1. Check DSN 5.x.x hard bounce on inbound messages (PRD 8.3)
    if (direction === 'inbound') {
      const bounce = parseDsnHardBounce({
        fromEmail: msg.fromEmail,
        subject: msg.subject,
        bodyText: plainBody,
        headers: msg.headers,
      });
      if (bounce.isHardBounce && bounce.bouncedAddress) {
        const cleanBounced = normalizeEmail(bounce.bouncedAddress);
        if (cleanBounced) {
          const bounceSource =
            mailbox.provider === 'google_gmail' ? 'google_gmail_ndr' : 'microsoft_graph_ndr';
          await this.recordHardBounce(cleanBounced, bounce.statusCode ?? '5.0.0', bounceSource);
          return {
            synced: false,
            bounced: true,
            reason: 'dsn_hard_bounce',
            threadId: null,
            messageId: null,
            stoppedSequenceEnrollments: 0,
          };
        }
      }
    }

    // 2. Deduplicate by `provider_message_id` before any further work
    const dupCheck = await this.db.query<{ id: string; thread_id: string }>(
      `SELECT id, thread_id FROM email_messages WHERE provider_message_id = $1 LIMIT 1`,
      [msg.id],
    );
    if (dupCheck.rows[0]) {
      return {
        synced: true,
        bounced: false,
        reason: 'already_synced',
        threadId: dupCheck.rows[0].thread_id,
        messageId: dupCheck.rows[0].id,
        stoppedSequenceEnrollments: 0,
      };
    }

    // 3. Resolve CRM participant / company domain / manual link (PRD 4.11 sync rule)
    const target = manualTarget
      ? await this.resolveManualTarget(mailbox.user_id, manualTarget)
      : await this.matchCrmTarget(mailbox, msg);

    if (!target) {
      return {
        synced: false,
        bounced: false,
        reason: 'unknown_participant_ignored',
        threadId: null,
        messageId: null,
        stoppedSequenceEnrollments: 0,
      };
    }

    // 4. Fetch attachment metadata only (never file bytes — PRD 4.11)
    const attachmentsMeta = preloadedAttachments
      ? preloadedAttachments
      : msg.hasAttachments && accessTokenForAttachments
        ? await this.graph.listMessageAttachments(accessTokenForAttachments, msg.id).catch(() => [])
        : [];

    const sanitized = msg.bodyContentType === 'html' ? sanitizeEmailHtml(msg.bodyContent) : null;
    const occurredAt =
      (direction === 'inbound' ? msg.receivedAt : msg.sentAt) ??
      msg.sentAt ??
      msg.receivedAt ??
      new Date().toISOString();

    return this.db.transaction(async (tx) => {
      const threadId = await this.findOrCreateThread(tx, {
        ownerUserId: mailbox.user_id,
        teamId: target.teamId,
        conversationId: msg.conversationId,
        subject: msg.subject,
        snippet: msg.bodyPreview || plainBody.slice(0, 160),
        direction,
        occurredAt,
        contactId: target.contactId,
        companyId: target.companyId,
        dealId: target.dealId,
        leadId: target.leadId,
      });

      const messageId = `msg_${randomUUID()}`;
      const inserted = await tx.query(
        `INSERT INTO email_messages (
           id, thread_id, mailbox_connection_id, provider_message_id,
           internet_message_id, in_reply_to, references_header,
           direction, from_email, to_emails, cc_emails,
           subject, body_preview, body_text, body_html_sanitized,
           outbound_status, has_attachments, linked_by, sent_at, received_at
         ) VALUES (
           $1, $2, $3, $4,
           $5, $6, $7,
           $8, $9, $10::jsonb, $11::jsonb,
           $12, $13, $14, $15,
           'sent', $16, $17, $18::timestamptz, $19::timestamptz
         )
         ON CONFLICT (provider_message_id) DO NOTHING`,
        [
          messageId,
          threadId,
          mailbox.id,
          msg.id,
          msg.internetMessageId,
          msg.inReplyTo,
          msg.referencesHeader,
          direction,
          normalizeEmail(msg.fromEmail) ?? msg.fromEmail,
          JSON.stringify(msg.toEmails),
          JSON.stringify(msg.ccEmails),
          msg.subject,
          (msg.bodyPreview || plainBody).slice(0, 200),
          plainBody,
          sanitized?.html ?? null,
          msg.hasAttachments || attachmentsMeta.length > 0,
          manualTarget ? 'user' : 'auto',
          occurredAt,
          direction === 'inbound' ? occurredAt : null,
        ],
      );

      if (inserted.rowCount === 0) {
        return {
          synced: true,
          bounced: false,
          reason: 'already_synced',
          threadId,
          messageId: null,
          stoppedSequenceEnrollments: 0,
        };
      }

      for (const att of attachmentsMeta) {
        await tx.query(
          `INSERT INTO email_attachments (
             id, message_id, mailbox_connection_id, provider_attachment_id,
             filename, mime_type, size_bytes, is_inline
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (message_id, provider_attachment_id) DO NOTHING`,
          [
            `att_${randomUUID()}`,
            messageId,
            mailbox.id,
            att.providerAttachmentId,
            att.filename,
            att.mimeType,
            att.sizeBytes,
            att.isInline,
          ],
        );
      }

      await this.recordEmailActivityAndTouchpoints(tx, {
        actorUserId: mailbox.user_id,
        direction,
        subject: msg.subject,
        snippet: (msg.bodyPreview || plainBody).slice(0, 200),
        occurredAt,
        threadId,
        messageId,
        target,
      });

      let stoppedSequenceEnrollments = 0;
      if (direction === 'inbound') {
        stoppedSequenceEnrollments = await this.handleInboundReplySideEffects(tx, {
          msg,
          target,
          threadId,
          messageId,
        });
      }

      await this.db.addOutboxEvent(tx, {
        eventType: direction === 'inbound' ? 'email.received' : 'email.sent',
        aggregateType: 'email_thread',
        aggregateId: threadId,
        payload: {
          threadId,
          messageId,
          contactId: target.contactId,
          companyId: target.companyId,
          dealId: target.dealId,
        },
      });

      return {
        synced: true,
        bounced: false,
        threadId,
        messageId,
        stoppedSequenceEnrollments,
      };
    });
  }

  private async matchCrmTarget(
    mailbox: Pick<MailboxRow, 'user_id' | 'email'>,
    msg: GraphMailMessage,
  ): Promise<MatchedCrmTarget | null> {
    const ownerMailboxEmail = normalizeEmail(mailbox.email) ?? '';
    const allAddresses = [msg.fromEmail, ...msg.toEmails, ...msg.ccEmails]
      .map((a) => normalizeEmail(a))
      .filter((a): a is string => Boolean(a) && a !== ownerMailboxEmail);

    if (allAddresses.length === 0) return null;

    // Exclude purely internal employee-to-employee mail unless an external participant is present
    const internalRes = await this.db.query<{ email: string }>(
      `SELECT LOWER(email) AS email FROM users WHERE LOWER(email) = ANY($1::text[])`,
      [allAddresses],
    );
    const internalSet = new Set(internalRes.rows.map((r) => r.email));
    const externalAddresses = allAddresses.filter((a) => !internalSet.has(a));
    if (externalAddresses.length === 0) return null;

    const ownerUserRes = await this.db.query<{ team_id: string | null }>(
      `SELECT team_id FROM users WHERE id = $1 LIMIT 1`,
      [mailbox.user_id],
    );
    const mailboxTeamId = ownerUserRes.rows[0]?.team_id ?? null;

    // 3a. Match by known `contact_emails` row (PRD 4.11)
    const contactRes = await this.db.query<{
      contact_id: string;
      contact_name: string;
      contact_email: string;
      company_id: string | null;
      company_name: string | null;
      team_id: string | null;
      lead_id: string | null;
      deal_id: string | null;
    }>(
      `SELECT ce.contact_id,
              c.full_name AS contact_name,
              c.primary_email AS contact_email,
              c.company_id,
              cmp.name AS company_name,
              c.team_id,
              (SELECT l.id FROM leads l
               WHERE l.contact_id = c.id AND l.deleted_at IS NULL AND l.status_category != 'closed'
               ORDER BY l.updated_at DESC LIMIT 1) AS lead_id,
              (SELECT d.id FROM deals d
               WHERE (d.primary_contact_id = c.id OR d.company_id = c.company_id)
                 AND d.deleted_at IS NULL AND d.stage_category = 'open'
               ORDER BY d.updated_at DESC LIMIT 1) AS deal_id
       FROM contact_emails ce
       JOIN contacts c ON c.id = ce.contact_id AND c.deleted_at IS NULL
       LEFT JOIN companies cmp ON cmp.id = c.company_id AND cmp.deleted_at IS NULL
       WHERE ce.email = ANY($1::text[])
       ORDER BY ce.is_primary DESC
       LIMIT 1`,
      [externalAddresses],
    );

    const matchedContact = contactRes.rows[0];
    if (matchedContact) {
      return {
        contactId: matchedContact.contact_id,
        contactName: matchedContact.contact_name,
        contactEmail: matchedContact.contact_email,
        companyId: matchedContact.company_id,
        companyName: matchedContact.company_name,
        leadId: matchedContact.lead_id,
        dealId: matchedContact.deal_id,
        ownerUserId: mailbox.user_id,
        teamId: mailboxTeamId ?? matchedContact.team_id,
      };
    }

    // 3b. Match by non-free-mail CRM `companies.domain` (PRD 4.11)
    const candidateDomains = Array.from(
      new Set(
        externalAddresses
          .map((addr) => extractDomainFromEmail(addr))
          .filter((d): d is string => typeof d === 'string' && !isFreeMailDomain(d)),
      ),
    );
    if (candidateDomains.length === 0) return null;

    const companyRes = await this.db.query<{
      company_id: string;
      company_name: string;
      team_id: string | null;
      deal_id: string | null;
    }>(
      `SELECT cmp.id AS company_id,
              cmp.name AS company_name,
              cmp.team_id,
              (SELECT d.id FROM deals d
               WHERE d.company_id = cmp.id AND d.deleted_at IS NULL AND d.stage_category = 'open'
               ORDER BY d.updated_at DESC LIMIT 1) AS deal_id
       FROM companies cmp
       WHERE cmp.deleted_at IS NULL AND cmp.domain = ANY($1::text[])
       ORDER BY cmp.updated_at DESC
       LIMIT 1`,
      [candidateDomains],
    );

    const matchedCompany = companyRes.rows[0];
    if (!matchedCompany) return null;

    return {
      contactId: null,
      contactName: null,
      contactEmail: externalAddresses[0] ?? null,
      companyId: matchedCompany.company_id,
      companyName: matchedCompany.company_name,
      leadId: null,
      dealId: matchedCompany.deal_id,
      ownerUserId: mailbox.user_id,
      teamId: mailboxTeamId ?? matchedCompany.team_id,
    };
  }

  private async resolveManualTarget(
    mailboxUserId: string,
    manual: { contactId?: string | null; companyId?: string | null; dealId?: string | null },
  ): Promise<MatchedCrmTarget | null> {
    const userRes = await this.db.query<{ team_id: string | null }>(
      `SELECT team_id FROM users WHERE id = $1 LIMIT 1`,
      [mailboxUserId],
    );
    const teamId = userRes.rows[0]?.team_id ?? null;

    if (manual.contactId) {
      const res = await this.db.query<{
        id: string;
        full_name: string;
        primary_email: string;
        company_id: string | null;
        company_name: string | null;
      }>(
        `SELECT c.id, c.full_name, c.primary_email, c.company_id, cmp.name AS company_name
         FROM contacts c
         LEFT JOIN companies cmp ON cmp.id = c.company_id
         WHERE c.id = $1 AND c.deleted_at IS NULL LIMIT 1`,
        [manual.contactId],
      );
      const row = res.rows[0];
      if (!row) return null;
      return {
        contactId: row.id,
        contactName: row.full_name,
        contactEmail: row.primary_email,
        companyId: manual.companyId ?? row.company_id,
        companyName: row.company_name,
        leadId: null,
        dealId: manual.dealId ?? null,
        ownerUserId: mailboxUserId,
        teamId,
      };
    }

    if (manual.companyId) {
      const res = await this.db.query<{ id: string; name: string }>(
        `SELECT id, name FROM companies WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
        [manual.companyId],
      );
      const row = res.rows[0];
      if (!row) return null;
      return {
        contactId: null,
        contactName: null,
        contactEmail: null,
        companyId: row.id,
        companyName: row.name,
        leadId: null,
        dealId: manual.dealId ?? null,
        ownerUserId: mailboxUserId,
        teamId,
      };
    }

    return null;
  }

  private async findOrCreateThread(
    tx: DbTx,
    input: {
      ownerUserId: string;
      teamId: string | null;
      conversationId: string | null;
      subject: string;
      snippet: string;
      direction: 'inbound' | 'outbound';
      occurredAt: string;
      contactId: string | null;
      companyId: string | null;
      dealId: string | null;
      leadId: string | null;
    },
  ): Promise<string> {
    let existingId: string | null = null;

    if (input.conversationId) {
      const byConv = await tx.query<{ id: string }>(
        `SELECT id FROM email_threads
         WHERE owner_user_id = $1 AND conversation_id = $2
         ORDER BY last_message_at DESC LIMIT 1`,
        [input.ownerUserId, input.conversationId],
      );
      existingId = byConv.rows[0]?.id ?? null;
    }

    const baseSubject = normalizeSubjectBase(input.subject);
    if (!existingId && input.contactId) {
      const byContact = await tx.query<{ id: string; subject: string }>(
        `SELECT id, subject FROM email_threads
         WHERE contact_id = $1 AND owner_user_id = $2
         ORDER BY last_message_at DESC LIMIT 5`,
        [input.contactId, input.ownerUserId],
      );
      existingId =
        byContact.rows.find(
          (r) => normalizeSubjectBase(r.subject).toLowerCase() === baseSubject.toLowerCase(),
        )?.id ?? null;
    }

    if (existingId) {
      await tx.query(
        `UPDATE email_threads
         SET last_message_at = GREATEST(last_message_at, $2::timestamptz),
             message_count = message_count + 1,
             unread_count = CASE WHEN $3 = 'inbound' THEN unread_count + 1 ELSE unread_count END,
             snippet = $4,
             status = CASE WHEN $3 = 'inbound' THEN 'replied' ELSE CASE WHEN status = 'archived' THEN 'open' ELSE status END END,
             contact_id = COALESCE(contact_id, $5),
             company_id = COALESCE(company_id, $6),
             deal_id = COALESCE(deal_id, $7),
             lead_id = COALESCE(lead_id, $8),
             conversation_id = COALESCE(conversation_id, $9),
             updated_at = NOW()
         WHERE id = $1`,
        [
          existingId,
          input.occurredAt,
          input.direction,
          input.snippet.slice(0, 200),
          input.contactId,
          input.companyId,
          input.dealId,
          input.leadId,
          input.conversationId,
        ],
      );
      return existingId;
    }

    const threadId = `thd_${randomUUID()}`;
    await tx.query(
      `INSERT INTO email_threads (
         id, subject, conversation_id, contact_id, company_id, deal_id, lead_id,
         owner_user_id, team_id, last_message_at, message_count, unread_count,
         snippet, status, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         $8, $9, $10::timestamptz, 1, $11,
         $12, $13, NOW(), NOW()
       )`,
      [
        threadId,
        baseSubject,
        input.conversationId,
        input.contactId,
        input.companyId,
        input.dealId,
        input.leadId,
        input.ownerUserId,
        input.teamId,
        input.occurredAt,
        input.direction === 'inbound' ? 1 : 0,
        input.snippet.slice(0, 200),
        input.direction === 'inbound' ? 'replied' : 'open',
      ],
    );
    return threadId;
  }

  private async recordEmailActivityAndTouchpoints(
    tx: DbTx,
    input: {
      actorUserId: string;
      direction: 'inbound' | 'outbound';
      subject: string;
      snippet: string;
      occurredAt: string;
      threadId: string;
      messageId: string;
      target: MatchedCrmTarget;
    },
  ): Promise<void> {
    const primaryEntityType = input.target.contactId
      ? 'contact'
      : input.target.companyId
        ? 'company'
        : input.target.dealId
          ? 'deal'
          : 'lead';
    const primaryEntityId =
      input.target.contactId ??
      input.target.companyId ??
      input.target.dealId ??
      input.target.leadId;

    if (primaryEntityId) {
      await tx.query(
        `INSERT INTO activities (
           id, entity_type, entity_id, activity_type, title, detail, actor_user_id,
           lead_id, contact_id, company_id, deal_id, metadata, occurred_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           $8, $9, $10, $11, $12::jsonb, $13::timestamptz
         )`,
        [
          `act_${randomUUID()}`,
          primaryEntityType,
          primaryEntityId,
          input.direction === 'inbound' ? 'email_received' : 'email_sent',
          input.direction === 'inbound'
            ? `Received email: ${input.subject}`
            : `Sent email: ${input.subject}`,
          input.snippet,
          input.actorUserId,
          input.target.leadId,
          input.target.contactId,
          input.target.companyId,
          input.target.dealId,
          JSON.stringify({ threadId: input.threadId, messageId: input.messageId }),
          input.occurredAt,
        ],
      );
    }

    if (input.target.contactId) {
      await tx.query(
        `UPDATE contacts
         SET last_contacted_at = GREATEST(COALESCE(last_contacted_at, $2::timestamptz), $2::timestamptz)
         WHERE id = $1`,
        [input.target.contactId, input.occurredAt],
      );
    }
    if (input.target.companyId) {
      await tx.query(
        `UPDATE companies
         SET last_contacted_at = GREATEST(COALESCE(last_contacted_at, $2::timestamptz), $2::timestamptz)
         WHERE id = $1`,
        [input.target.companyId, input.occurredAt],
      );
    }
    if (input.target.dealId) {
      await tx.query(`UPDATE deals SET last_activity_at = NOW() WHERE id = $1`, [
        input.target.dealId,
      ]);
    }

    if (input.direction === 'outbound') {
      if (input.target.leadId) {
        await tx.query(
          `UPDATE leads
           SET last_contacted_at = GREATEST(COALESCE(last_contacted_at, $2::timestamptz), $2::timestamptz)
           WHERE id = $1`,
          [input.target.leadId, input.occurredAt],
        );
        const leadRow = await tx.query<{ status: string }>(
          `SELECT status FROM leads WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
          [input.target.leadId],
        );
        const fromStatus = leadRow.rows[0]?.status;
        if (fromStatus === 'New' || fromStatus === 'Researching') {
          await tx.query(
            `UPDATE leads SET status = 'Contacted', status_category = 'open', version = version + 1, updated_at = NOW()
             WHERE id = $1`,
            [input.target.leadId],
          );
          await tx.query(
            `INSERT INTO lead_status_history (id, lead_id, from_status, to_status, changed_by_user_id, reason)
             VALUES ($1, $2, $3, 'Contacted', $4, 'Automatic: outbound email sent')`,
            [`lsh_${randomUUID()}`, input.target.leadId, fromStatus, input.actorUserId],
          );
        }
      }

      if (input.target.leadId || input.target.contactId) {
        await tx.query(
          `UPDATE tasks
           SET status = 'completed',
               completed_at = $3::timestamptz,
               completed_by_user_id = $4,
               outcome = COALESCE(outcome, 'First response sent via email'),
               sla_breached = sla_breached OR (sla_deadline_at IS NOT NULL AND $3::timestamptz > sla_deadline_at),
               version = version + 1,
               updated_at = NOW()
           WHERE task_type = 'sla_first_response'
             AND status = 'open'
             AND deleted_at IS NULL
             AND (lead_id = $1 OR contact_id = $2)`,
          [
            input.target.leadId ?? null,
            input.target.contactId ?? null,
            input.occurredAt,
            input.actorUserId,
          ],
        );
      }
    }
  }

  private async handleInboundReplySideEffects(
    tx: DbTx,
    input: {
      msg: GraphMailMessage;
      target: MatchedCrmTarget;
      threadId: string;
      messageId: string;
    },
  ): Promise<number> {
    const refIds = new Set<string>();
    if (input.msg.inReplyTo) refIds.add(input.msg.inReplyTo.trim());
    if (input.msg.referencesHeader) {
      for (const token of input.msg.referencesHeader.split(/\s+/)) {
        if (token.trim()) refIds.add(token.trim());
      }
    }

    // Match by `In-Reply-To`/`References` header against `message_sends.internet_message_id` OR
    // by contact / same company domain (PRD 4.12, 8.3).
    const headerIds = Array.from(refIds);
    const stoppedRes = await tx.query<{ id: string; sender_user_id: string; contact_id: string }>(
      `UPDATE sequence_enrollments se
       SET status = 'replied',
           stop_reason = 'Recipient replied to outreach',
           next_send_at = NULL,
           stopped_at = NOW()
       WHERE se.status IN ('active', 'paused')
         AND (
           ($1::text IS NOT NULL AND se.contact_id = $1)
           OR ($2::text IS NOT NULL AND se.contact_id IN (
             SELECT id FROM contacts WHERE company_id = $2 AND deleted_at IS NULL
           ))
           OR (cardinality($3::text[]) > 0 AND se.id IN (
             SELECT ms.sequence_enrollment_id
             FROM message_sends ms
             WHERE ms.internet_message_id = ANY($3::text[])
               AND ms.sequence_enrollment_id IS NOT NULL
           ))
         )
       RETURNING se.id, se.sender_user_id, se.contact_id`,
      [input.target.contactId, input.target.companyId, headerIds],
    );

    const stoppedCount = stoppedRes.rowCount;
    const notifyUserId = stoppedRes.rows[0]?.sender_user_id ?? input.target.ownerUserId;
    const senderLabel = input.target.contactName ?? input.target.companyName ?? input.msg.fromEmail;

    if (stoppedCount > 0) {
      const taskId = `tsk_reply_${randomUUID()}`;
      await tx.query(
        `INSERT INTO tasks (
           id, title, task_type, priority, status, due_at,
           assignee_user_id, team_id, company_id, contact_id, deal_id, lead_id
         ) VALUES (
           $1, $2, 'follow_up', 'high', 'open', NOW() + INTERVAL '2 hours',
           $3, $4, $5, $6, $7, $8
         )`,
        [
          taskId,
          `Reply received from ${senderLabel}: ${input.msg.subject}`.slice(0, 220),
          notifyUserId,
          input.target.teamId,
          input.target.companyId,
          input.target.contactId,
          input.target.dealId,
          input.target.leadId,
        ],
      );

      for (const row of stoppedRes.rows) {
        await this.db.addOutboxEvent(tx, {
          eventType: 'sequence.stopped',
          aggregateType: 'sequence_enrollment',
          aggregateId: row.id,
          payload: { reason: 'replied', threadId: input.threadId, messageId: input.messageId },
        });
      }
      await this.db.addOutboxEvent(tx, {
        eventType: 'email.replied',
        aggregateType: 'email_thread',
        aggregateId: input.threadId,
        payload: { threadId: input.threadId, messageId: input.messageId, stoppedCount },
      });
    }

    await addNotification(tx, {
      userId: notifyUserId,
      kind: 'general',
      title: `New email reply from ${senderLabel}`,
      body: input.msg.subject,
      entityType: input.target.contactId ? 'contact' : 'company',
      entityId: input.target.contactId ?? input.target.companyId,
      dedupeKey: `email_reply:${input.messageId}`,
    });

    return stoppedCount;
  }

  private async recordHardBounce(
    cleanEmail: string,
    dsnStatus: string,
    source: 'microsoft_graph_ndr' | 'google_gmail_ndr' = 'microsoft_graph_ndr',
  ): Promise<void> {
    const emailHash = sha256Hex(cleanEmail);
    await this.db.transaction(async (tx) => {
      const ceRes = await tx.query<{ contact_id: string }>(
        `UPDATE contact_emails
         SET verification_status = 'invalid'
         WHERE email = $1
         RETURNING contact_id`,
        [cleanEmail],
      );
      const contactId = ceRes.rows[0]?.contact_id ?? null;
      if (contactId) {
        await tx.query(
          `UPDATE contacts SET email_verification_status = 'invalid', updated_at = NOW()
           WHERE id = $1 AND primary_email = $2`,
          [contactId, cleanEmail],
        );
      }

      await tx.query(
        `INSERT INTO suppressions (id, email, email_sha256, reason, source, notes)
         VALUES ($1, $2, $3, 'hard_bounce', $4, $5)
         ON CONFLICT (email_sha256) DO UPDATE SET
           reason = 'hard_bounce',
           lifted_at = NULL,
           lifted_by = NULL,
           lifted_reason = NULL
         WHERE suppressions.reason <> 'privacy_erasure'`,
        [`sup_${randomUUID()}`, cleanEmail, emailHash, source, `NDR hard bounce (${dsnStatus})`],
      );

      if (contactId) {
        await tx.query(
          `UPDATE sequence_enrollments
           SET status = 'bounced',
               stop_reason = $2,
               next_send_at = NULL,
               stopped_at = NOW()
           WHERE contact_id = $1 AND status IN ('active', 'paused')`,
          [contactId, `Hard bounce (${dsnStatus})`],
        );
      }

      await this.db.addOutboxEvent(tx, {
        eventType: 'recipient.bounced',
        aggregateType: 'contact',
        aggregateId: contactId ?? emailHash,
        payload: { contactId, dsnStatus },
      });
    });
  }

  // -------------------------------------------------------------------------
  // 4. Thread List, Detail, Send, Reply, Deal Link, Task-from-Email & Attachments (PRD 4.11)
  // -------------------------------------------------------------------------

  async listThreads(
    user: SessionUser,
    rawQuery: Record<string, unknown>,
  ): Promise<{
    items: InboxThreadSummary[];
    nextCursor: string | null;
    counts: Record<string, number>;
  }> {
    const query = InboxThreadQuerySchema.parse(rawQuery);
    const scope = scopeWhere(user, 'inbox.read', { alias: 't', startParamIndex: 1 });
    const params: unknown[] = [...scope.params];
    const conds: string[] = [scope.sql];

    if (query.status !== 'all') {
      params.push(query.status);
      conds.push(`t.status = $${params.length}`);
    }
    if (query.contactId) {
      params.push(query.contactId);
      conds.push(`t.contact_id = $${params.length}`);
    }
    if (query.companyId) {
      params.push(query.companyId);
      conds.push(`t.company_id = $${params.length}`);
    }
    if (query.dealId) {
      params.push(query.dealId);
      conds.push(`t.deal_id = $${params.length}`);
    }
    if (query.leadId) {
      params.push(query.leadId);
      conds.push(
        `(t.lead_id = $${params.length} OR t.contact_id = (SELECT contact_id FROM leads WHERE id = $${params.length}))`,
      );
    }
    if (query.q) {
      params.push(`%${query.q}%`);
      const p = `$${params.length}`;
      conds.push(
        `(t.subject ILIKE ${p} OR t.snippet ILIKE ${p} OR c.full_name ILIKE ${p} OR cmp.name ILIKE ${p})`,
      );
    }
    if (query.cursor) {
      const [cursorAt, cursorId] = query.cursor.split('|');
      if (cursorAt && cursorId) {
        params.push(cursorAt, cursorId);
        conds.push(
          `(t.last_message_at, t.id) < ($${params.length - 1}::timestamptz, $${params.length}::text)`,
        );
      }
    }

    const [rowsRes, countsRes] = await Promise.all([
      this.db.query<Record<string, unknown> & { last_cursor: string }>(
        `SELECT t.*,
                t.last_message_at::text AS last_cursor,
                c.full_name AS contact_name,
                c.primary_email AS contact_email,
                cmp.name AS company_name,
                d.name AS deal_name,
                EXISTS (
                  SELECT 1 FROM email_messages m
                  WHERE m.thread_id = t.id AND m.outbound_status = 'failed'
                ) AS has_failed_outbound
         FROM email_threads t
         LEFT JOIN contacts c ON c.id = t.contact_id AND c.deleted_at IS NULL
         LEFT JOIN companies cmp ON cmp.id = t.company_id AND cmp.deleted_at IS NULL
         LEFT JOIN deals d ON d.id = t.deal_id AND d.deleted_at IS NULL
         WHERE ${conds.join(' AND ')}
         ORDER BY t.last_message_at DESC, t.id DESC
         LIMIT ${query.limit + 1}`,
        params,
      ),
      this.db.query<{ status: string; n: number }>(
        `SELECT t.status, COUNT(*)::int AS n
         FROM email_threads t
         WHERE ${scope.sql}
         GROUP BY t.status`,
        scope.params,
      ),
    ]);

    const hasMore = rowsRes.rows.length > query.limit;
    const slice = hasMore ? rowsRes.rows.slice(0, query.limit) : rowsRes.rows;
    const last = slice[slice.length - 1];

    const counts: Record<string, number> = { all: 0, open: 0, replied: 0, archived: 0 };
    for (const c of countsRes.rows) {
      counts[c.status] = c.n;
      counts['all'] = (counts['all'] ?? 0) + c.n;
    }

    return {
      items: slice.map((r) => this.mapThreadSummary(r)),
      nextCursor: hasMore && last ? `${String(last['last_cursor'])}|${String(last['id'])}` : null,
      counts,
    };
  }

  async getThreadDetail(user: SessionUser, threadId: string): Promise<InboxThreadDetail> {
    const scope = scopeWhere(user, 'inbox.read', { alias: 't', startParamIndex: 2 });
    const threadRes = await this.db.query<Record<string, unknown>>(
      `SELECT t.*,
              c.full_name AS contact_name,
              c.primary_email AS contact_email,
              cmp.name AS company_name,
              d.name AS deal_name,
              EXISTS (
                SELECT 1 FROM email_messages m
                WHERE m.thread_id = t.id AND m.outbound_status = 'failed'
              ) AS has_failed_outbound
       FROM email_threads t
       LEFT JOIN contacts c ON c.id = t.contact_id AND c.deleted_at IS NULL
       LEFT JOIN companies cmp ON cmp.id = t.company_id AND cmp.deleted_at IS NULL
       LEFT JOIN deals d ON d.id = t.deal_id AND d.deleted_at IS NULL
       WHERE t.id = $1 AND ${scope.sql}
       LIMIT 1`,
      [threadId, ...scope.params],
    );
    const threadRow = threadRes.rows[0];
    if (!threadRow) {
      throw new NotFoundDomainError('Email thread', threadId);
    }

    const msgRes = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM email_messages WHERE thread_id = $1 ORDER BY sent_at ASC, created_at ASC`,
      [threadId],
    );
    const msgIds = msgRes.rows.map((m) => String(m['id']));
    const attMap = new Map<string, EmailAttachmentView[]>();

    if (msgIds.length > 0) {
      const attRes = await this.db.query<Record<string, unknown>>(
        `SELECT * FROM email_attachments WHERE message_id = ANY($1::text[]) ORDER BY created_at ASC`,
        [msgIds],
      );
      for (const a of attRes.rows) {
        const mid = String(a['message_id']);
        const list = attMap.get(mid) ?? [];
        list.push({
          id: String(a['id']),
          messageId: mid,
          filename: String(a['filename']),
          mimeType: String(a['mime_type']),
          sizeBytes: Number(a['size_bytes'] ?? 0),
          isInline: Boolean(a['is_inline']),
        });
        attMap.set(mid, list);
      }
    }

    // Mark unread messages as read when the owner opens the thread
    if (Number(threadRow['unread_count'] ?? 0) > 0 && threadRow['owner_user_id'] === user.id) {
      await this.db.query(
        `UPDATE email_threads SET unread_count = 0, updated_at = NOW() WHERE id = $1`,
        [threadId],
      );
      threadRow['unread_count'] = 0;
    }

    const messages: EmailMessageView[] = msgRes.rows.map((m) => {
      const mid = String(m['id']);
      const htmlSanitized =
        typeof m['body_html_sanitized'] === 'string' && m['body_html_sanitized']
          ? m['body_html_sanitized']
          : null;
      return {
        id: mid,
        threadId: String(m['thread_id']),
        direction: m['direction'] === 'inbound' ? 'inbound' : 'outbound',
        fromEmail: String(m['from_email']),
        toEmails: parseJsonStringArray(m['to_emails']),
        ccEmails: parseJsonStringArray(m['cc_emails']),
        subject: String(m['subject']),
        bodyPreview: String(m['body_preview']),
        bodyText: String(m['body_text']),
        bodyHtmlSanitized: htmlSanitized,
        hasRemoteImages: htmlSanitized ? htmlSanitized.includes('data-remote-url=') : false,
        outboundStatus: (['queued', 'sent', 'failed'].includes(String(m['outbound_status']))
          ? String(m['outbound_status'])
          : 'sent') as EmailMessageView['outboundStatus'],
        errorDetail: typeof m['error_detail'] === 'string' ? m['error_detail'] : null,
        hasAttachments: Boolean(m['has_attachments']) || (attMap.get(mid)?.length ?? 0) > 0,
        attachments: attMap.get(mid) ?? [],
        linkedBy: m['linked_by'] === 'user' ? 'user' : 'auto',
        sentAt: toIso(m['sent_at'] as Date | string) ?? new Date().toISOString(),
      };
    });

    return {
      thread: this.mapThreadSummary(threadRow),
      messages,
    };
  }

  async sendEmail(
    user: SessionUser,
    rawInput: unknown,
    idempotencyKey?: string | null,
  ): Promise<InboxThreadDetail> {
    requireCapability(user, 'inbox.send');
    const input = SendInboxEmailInputSchema.parse(rawInput);
    const cleanTo = normalizeEmail(input.toEmail);
    if (!cleanTo) {
      throw new ValidationDomainError('Enter a valid recipient email address.', {
        toEmail: ['Invalid email syntax.'],
      });
    }
    const cleanCc = Array.from(
      new Set(
        input.ccEmails
          .map((e) => normalizeEmail(e))
          .filter((e): e is string => Boolean(e) && e !== cleanTo),
      ),
    );

    const idemKey = idempotencyKey?.trim() || `inbox_send_${randomUUID()}`;
    const replay = await this.findIdempotentMessageThread(idemKey);
    if (replay) {
      return this.getThreadDetail(user, replay);
    }

    await this.assertRecipientNotSuppressed(cleanTo, input.contactId ?? null);

    // Resolve Contact/Company context (verifying read scope if IDs were explicitly supplied)
    const target = await this.resolveSendTarget(user, {
      toEmail: cleanTo,
      contactId: input.contactId ?? null,
      companyId: input.companyId ?? null,
      dealId: input.dealId ?? null,
      leadId: input.leadId ?? null,
    });

    const renderedSubject = renderEmailTemplate(input.subject, {
      fullName: target.contactName,
      companyName: target.companyName,
      senderName: user.name,
      senderEmail: user.email,
    });
    const renderedBody = renderEmailTemplate(input.bodyText, {
      fullName: target.contactName,
      companyName: target.companyName,
      senderName: user.name,
      senderEmail: user.email,
    });

    const mbxRes = await this.db.query<MailboxRow>(
      `SELECT * FROM mailbox_connections WHERE user_id = $1 LIMIT 1`,
      [user.id],
    );
    const mailbox = mbxRes.rows[0] ?? null;
    if (mailbox && mailbox.sent_today_count >= mailbox.daily_send_cap) {
      throw conflictError(
        'MAILBOX_DAILY_CAP_REACHED',
        `Your mailbox has reached its daily limit of ${mailbox.daily_send_cap} outbound messages.`,
      );
    }

    const fromEmail = mailbox?.email ?? user.email;
    let providerMessageId = `idem:${idemKey}`;
    let internetMessageId = `<${idemKey}@adasglobuspro.com>`;
    let sentConversationId: string | null = null;
    let outboundStatus: 'sent' | 'failed' = 'sent';
    let errorDetail: string | null = null;

    if (this.options.nodeEnv === 'production' && this.options.mailLive) {
      if (!mailbox || mailbox.status !== 'connected') {
        throw conflictError(
          'MAILBOX_NOT_CONNECTED',
          'Connect your Microsoft 365 or Google Workspace mailbox in Inbox before sending live email.',
        );
      }
      const provider = this.normalizeProvider(mailbox.provider);
      const accessToken = await this.ensureAccessToken(mailbox);
      try {
        if (provider === 'google_gmail') {
          const sent = await this.requireGmail().sendMail({
            accessToken,
            fromEmail: mailbox.email,
            toEmails: [cleanTo],
            ccEmails: cleanCc,
            subject: renderedSubject,
            bodyText: renderedBody,
          });
          providerMessageId = `idem:${idemKey}:${sent.providerMessageId}`;
          internetMessageId = sent.internetMessageId;
          sentConversationId = sent.threadId;
        } else {
          const sent = await this.graph.sendMail({
            accessToken,
            toEmails: [cleanTo],
            ccEmails: cleanCc,
            subject: renderedSubject,
            bodyText: renderedBody,
          });
          providerMessageId = `idem:${idemKey}:${sent.providerMessageId}`;
        }
      } catch (err) {
        outboundStatus = 'failed';
        errorDetail =
          err instanceof GraphApiError
            ? `Microsoft Graph returned HTTP ${err.status} (${err.code}).`
            : err instanceof GmailApiError
              ? `Google Gmail API returned HTTP ${err.status} (${err.code}).`
              : `Delivery through ${this.providerLabel(provider)} failed.`;
      }
    } else {
      const receipt = await this.mailpit.sendOneToOne({
        idempotencyKey: idemKey,
        fromEmail,
        toEmail: cleanTo,
        ccEmails: cleanCc,
        subject: renderedSubject,
        bodyText: renderedBody,
      });
      providerMessageId = receipt.providerMessageId;
      internetMessageId = receipt.internetMessageId ?? internetMessageId;
    }

    const nowIso = new Date().toISOString();
    const threadId = await this.db.transaction(async (tx) => {
      const tid = await this.findOrCreateThread(tx, {
        ownerUserId: user.id,
        teamId: user.teamId,
        conversationId: sentConversationId,
        subject: renderedSubject,
        snippet: renderedBody.slice(0, 180),
        direction: 'outbound',
        occurredAt: nowIso,
        contactId: target.contactId,
        companyId: target.companyId,
        dealId: target.dealId,
        leadId: target.leadId,
      });

      const msgId = `msg_${randomUUID()}`;
      await tx.query(
        `INSERT INTO email_messages (
           id, thread_id, mailbox_connection_id, provider_message_id, internet_message_id,
           direction, from_email, to_emails, cc_emails,
           subject, body_preview, body_text, outbound_status, error_detail, sent_at
         ) VALUES (
           $1, $2, $3, $4, $5,
           'outbound', $6, $7::jsonb, $8::jsonb,
           $9, $10, $11, $12, $13, $14::timestamptz
         )`,
        [
          msgId,
          tid,
          mailbox?.id ?? null,
          providerMessageId,
          internetMessageId,
          fromEmail,
          JSON.stringify([cleanTo]),
          JSON.stringify(cleanCc),
          renderedSubject,
          renderedBody.slice(0, 180),
          renderedBody,
          outboundStatus,
          errorDetail,
          nowIso,
        ],
      );

      if (outboundStatus === 'sent') {
        if (mailbox) {
          await tx.query(
            `UPDATE mailbox_connections
             SET sent_today_count = sent_today_count + 1, updated_at = NOW()
             WHERE id = $1`,
            [mailbox.id],
          );
        }
        await this.recordEmailActivityAndTouchpoints(tx, {
          actorUserId: user.id,
          direction: 'outbound',
          subject: renderedSubject,
          snippet: renderedBody.slice(0, 180),
          occurredAt: nowIso,
          threadId: tid,
          messageId: msgId,
          target,
        });
        await this.db.addOutboxEvent(tx, {
          eventType: 'email.sent',
          aggregateType: 'email_thread',
          aggregateId: tid,
          payload: {
            threadId: tid,
            messageId: msgId,
            contactId: target.contactId,
            companyId: target.companyId,
            dealId: target.dealId,
          },
        });
      }

      return tid;
    });

    return this.getThreadDetail(user, threadId);
  }

  async replyToThread(
    user: SessionUser,
    threadId: string,
    rawInput: unknown,
    idempotencyKey?: string | null,
  ): Promise<InboxThreadDetail> {
    requireCapability(user, 'inbox.send');
    const input = ReplyInboxThreadInputSchema.parse(rawInput);

    const idemKey = idempotencyKey?.trim() || `inbox_reply_${randomUUID()}`;
    const replay = await this.findIdempotentMessageThread(idemKey);
    if (replay) {
      return this.getThreadDetail(user, replay);
    }

    const detail = await this.getThreadDetail(user, threadId);
    const lastInbound = [...detail.messages].reverse().find((m) => m.direction === 'inbound');
    const lastAny = detail.messages[detail.messages.length - 1];
    const toEmail = normalizeEmail(
      lastInbound?.fromEmail ?? detail.thread.contactEmail ?? lastAny?.toEmails[0] ?? '',
    );
    if (!toEmail) {
      throw new ValidationDomainError('Could not determine a recipient email for this thread.', {
        bodyText: ['No recipient email address is linked to this conversation.'],
      });
    }

    await this.assertRecipientNotSuppressed(toEmail, detail.thread.contactId);

    const cleanCc = Array.from(
      new Set(
        input.ccEmails
          .map((e) => normalizeEmail(e))
          .filter((e): e is string => Boolean(e) && e !== toEmail),
      ),
    );

    const replySubject = /^re\s*:/i.test(detail.thread.subject)
      ? detail.thread.subject
      : `Re: ${detail.thread.subject}`;
    const renderedBody = renderEmailTemplate(input.bodyText, {
      fullName: detail.thread.contactName,
      companyName: detail.thread.companyName,
      senderName: user.name,
      senderEmail: user.email,
    });

    const mbxRes = await this.db.query<MailboxRow>(
      `SELECT * FROM mailbox_connections WHERE user_id = $1 LIMIT 1`,
      [user.id],
    );
    const mailbox = mbxRes.rows[0] ?? null;
    if (mailbox && mailbox.sent_today_count >= mailbox.daily_send_cap) {
      throw conflictError(
        'MAILBOX_DAILY_CAP_REACHED',
        `Your mailbox has reached its daily limit of ${mailbox.daily_send_cap} outbound messages.`,
      );
    }

    const lastMsgMetaRes = await this.db.query<{
      provider_message_id: string | null;
      internet_message_id: string | null;
      references_header: string | null;
      conversation_id: string | null;
    }>(
      `SELECT m.provider_message_id, m.internet_message_id, m.references_header, t.conversation_id
       FROM email_messages m
       JOIN email_threads t ON t.id = m.thread_id
       WHERE m.thread_id = $1
       ORDER BY m.sent_at DESC LIMIT 1`,
      [threadId],
    );
    const lastProviderId = lastMsgMetaRes.rows[0]?.provider_message_id ?? null;
    const inReplyToHeader = lastMsgMetaRes.rows[0]?.internet_message_id ?? null;
    const prevReferences = lastMsgMetaRes.rows[0]?.references_header ?? null;
    const threadConversationId = lastMsgMetaRes.rows[0]?.conversation_id ?? null;

    const fromEmail = mailbox?.email ?? user.email;
    let providerMessageId = `idem:${idemKey}`;
    let internetMessageId = `<${idemKey}@adasglobuspro.com>`;
    let outboundStatus: 'sent' | 'failed' = 'sent';
    let errorDetail: string | null = null;

    if (this.options.nodeEnv === 'production' && this.options.mailLive) {
      if (!mailbox || mailbox.status !== 'connected') {
        throw conflictError(
          'MAILBOX_NOT_CONNECTED',
          'Connect your Microsoft 365 or Google Workspace mailbox in Inbox before replying.',
        );
      }
      const provider = this.normalizeProvider(mailbox.provider);
      const accessToken = await this.ensureAccessToken(mailbox);
      try {
        if (provider === 'google_gmail') {
          const refsChain = [prevReferences, inReplyToHeader].filter(Boolean).join(' ') || null;
          const sent = await this.requireGmail().sendMail({
            accessToken,
            fromEmail: mailbox.email,
            toEmails: [toEmail],
            ccEmails: cleanCc,
            subject: replySubject,
            bodyText: renderedBody,
            threadId: threadConversationId,
            inReplyTo: inReplyToHeader,
            references: refsChain,
          });
          providerMessageId = `idem:${idemKey}:${sent.providerMessageId}`;
          internetMessageId = sent.internetMessageId;
        } else if (
          lastProviderId &&
          !lastProviderId.startsWith('mailpit_') &&
          !lastProviderId.startsWith('idem:')
        ) {
          const sent = await this.graph.replyToMessage({
            accessToken,
            replyToProviderMessageId: lastProviderId,
            ccEmails: cleanCc,
            bodyText: renderedBody,
          });
          providerMessageId = `idem:${idemKey}:${sent.providerMessageId}`;
        } else {
          const sent = await this.graph.sendMail({
            accessToken,
            toEmails: [toEmail],
            ccEmails: cleanCc,
            subject: replySubject,
            bodyText: renderedBody,
          });
          providerMessageId = `idem:${idemKey}:${sent.providerMessageId}`;
        }
      } catch (err) {
        outboundStatus = 'failed';
        errorDetail =
          err instanceof GraphApiError
            ? `Microsoft Graph returned HTTP ${err.status} (${err.code}).`
            : err instanceof GmailApiError
              ? `Google Gmail API returned HTTP ${err.status} (${err.code}).`
              : `Reply delivery through ${this.providerLabel(provider)} failed.`;
      }
    } else {
      const receipt = await this.mailpit.sendOneToOne({
        idempotencyKey: idemKey,
        fromEmail,
        toEmail,
        ccEmails: cleanCc,
        subject: replySubject,
        bodyText: renderedBody,
      });
      providerMessageId = receipt.providerMessageId;
      internetMessageId = receipt.internetMessageId ?? internetMessageId;
    }

    const nowIso = new Date().toISOString();
    await this.db.transaction(async (tx) => {
      const msgId = `msg_${randomUUID()}`;
      await tx.query(
        `INSERT INTO email_messages (
           id, thread_id, mailbox_connection_id, provider_message_id,
           internet_message_id, in_reply_to, direction,
           from_email, to_emails, cc_emails, subject, body_preview, body_text,
           outbound_status, error_detail, sent_at
         ) VALUES (
           $1, $2, $3, $4,
           $5, $6, 'outbound',
           $7, $8::jsonb, $9::jsonb, $10, $11, $12,
           $13, $14, $15::timestamptz
         )`,
        [
          msgId,
          threadId,
          mailbox?.id ?? null,
          providerMessageId,
          internetMessageId,
          inReplyToHeader,
          fromEmail,
          JSON.stringify([toEmail]),
          JSON.stringify(cleanCc),
          replySubject,
          renderedBody.slice(0, 180),
          renderedBody,
          outboundStatus,
          errorDetail,
          nowIso,
        ],
      );

      await tx.query(
        `UPDATE email_threads
         SET last_message_at = $2::timestamptz,
             message_count = message_count + 1,
             unread_count = 0,
             snippet = $3,
             status = 'open',
             updated_at = NOW()
         WHERE id = $1`,
        [threadId, nowIso, renderedBody.slice(0, 180)],
      );

      if (outboundStatus === 'sent') {
        if (mailbox) {
          await tx.query(
            `UPDATE mailbox_connections
             SET sent_today_count = sent_today_count + 1, updated_at = NOW()
             WHERE id = $1`,
            [mailbox.id],
          );
        }
        await this.recordEmailActivityAndTouchpoints(tx, {
          actorUserId: user.id,
          direction: 'outbound',
          subject: replySubject,
          snippet: renderedBody.slice(0, 180),
          occurredAt: nowIso,
          threadId,
          messageId: msgId,
          target: {
            contactId: detail.thread.contactId,
            contactName: detail.thread.contactName,
            contactEmail: detail.thread.contactEmail,
            companyId: detail.thread.companyId,
            companyName: detail.thread.companyName,
            leadId: detail.thread.leadId,
            dealId: detail.thread.dealId,
            ownerUserId: detail.thread.ownerUserId,
            teamId: user.teamId,
          },
        });
        await this.db.addOutboxEvent(tx, {
          eventType: 'email.sent',
          aggregateType: 'email_thread',
          aggregateId: threadId,
          payload: { threadId, messageId: msgId },
        });
      }
    });

    return this.getThreadDetail(user, threadId);
  }

  async updateThread(
    user: SessionUser,
    threadId: string,
    rawInput: unknown,
  ): Promise<InboxThreadSummary> {
    const input = UpdateInboxThreadInputSchema.parse(rawInput);
    const scope = scopeWhere(user, 'inbox.read', { alias: 't', startParamIndex: 2 });
    const existing = await this.db.query<{ id: string }>(
      `SELECT t.id FROM email_threads t WHERE t.id = $1 AND ${scope.sql} LIMIT 1`,
      [threadId, ...scope.params],
    );
    if (!existing.rows[0]) {
      throw new NotFoundDomainError('Email thread', threadId);
    }

    if (input.dealId !== undefined && input.dealId !== null) {
      const dealScope = scopeWhere(user, 'deals.read', { alias: 'd', startParamIndex: 2 });
      const dealCheck = await this.db.query<{ id: string }>(
        `SELECT d.id FROM deals d WHERE d.id = $1 AND d.deleted_at IS NULL AND ${dealScope.sql} LIMIT 1`,
        [input.dealId, ...dealScope.params],
      );
      if (!dealCheck.rows[0]) {
        throw new NotFoundDomainError('Deal', input.dealId);
      }
    }

    const sets: string[] = ['updated_at = NOW()'];
    const params: unknown[] = [threadId];

    if (input.status !== undefined) {
      params.push(input.status);
      sets.push(`status = $${params.length}`);
    }
    if (input.markRead === true) {
      sets.push('unread_count = 0');
    }
    if (input.dealId !== undefined) {
      params.push(input.dealId);
      sets.push(`deal_id = $${params.length}`);
    }

    await this.db.query(`UPDATE email_threads SET ${sets.join(', ')} WHERE id = $1`, params);
    const updated = await this.getThreadDetail(user, threadId);
    return updated.thread;
  }

  async createTaskFromMessage(
    user: SessionUser,
    messageId: string,
    rawInput: unknown,
  ): Promise<Record<string, unknown>> {
    requireCapability(user, 'tasks.write');
    const input = CreateTaskFromEmailInputSchema.parse(rawInput);

    const scope = scopeWhere(user, 'inbox.read', { alias: 't', startParamIndex: 2 });
    const msgRes = await this.db.query<{
      id: string;
      subject: string;
      thread_id: string;
      contact_id: string | null;
      company_id: string | null;
      deal_id: string | null;
      lead_id: string | null;
      team_id: string | null;
    }>(
      `SELECT m.id, m.subject, m.thread_id,
              t.contact_id, t.company_id, t.deal_id, t.lead_id, t.team_id
       FROM email_messages m
       JOIN email_threads t ON t.id = m.thread_id
       WHERE m.id = $1 AND ${scope.sql}
       LIMIT 1`,
      [messageId, ...scope.params],
    );
    const msg = msgRes.rows[0];
    if (!msg) {
      throw new NotFoundDomainError('Email message', messageId);
    }

    const assigneeId = input.assigneeUserId ?? user.id;
    if (
      assigneeId !== user.id &&
      !user.teamMemberIds.includes(assigneeId) &&
      user.role !== 'Admin'
    ) {
      throw new ForbiddenScopeError('tasks.write');
    }

    const title = (input.title ?? `Follow up on email: ${msg.subject}`).slice(0, 240);
    const dueAt = input.dueAt ?? new Date(Date.now() + 86_400_000).toISOString();
    const taskId = `tsk_${randomUUID()}`;

    const created = await this.db.transaction(async (tx) => {
      const res = await tx.query(
        `INSERT INTO tasks (
           id, title, task_type, priority, status, due_at,
           assignee_user_id, team_id, contact_id, company_id, deal_id, lead_id, created_by_user_id
         ) VALUES (
           $1, $2, 'email', $3, 'open', $4::timestamptz,
           $5, $6, $7, $8, $9, $10, $11
         )
         RETURNING *`,
        [
          taskId,
          title,
          input.priority,
          dueAt,
          assigneeId,
          msg.team_id ?? user.teamId,
          msg.contact_id,
          msg.company_id,
          msg.deal_id,
          msg.lead_id,
          user.id,
        ],
      );
      await this.db.addOutboxEvent(tx, {
        eventType: 'task.created',
        aggregateType: 'task',
        aggregateId: taskId,
        payload: { taskId, sourceMessageId: messageId },
      });
      return res.rows[0] ?? {};
    });

    return created;
  }

  async manualLinkMessage(
    user: SessionUser,
    rawInput: unknown,
  ): Promise<{ synced: boolean; threadId: string | null }> {
    requireCapability(user, 'inbox.send');
    const input = ManualLinkEmailInputSchema.parse(rawInput);
    if (!input.contactId && !input.companyId) {
      throw new ValidationDomainError('Choose a contact or company to link the message to.', {
        contactId: ['Select a contact or company.'],
      });
    }

    const mbxRes = await this.db.query<MailboxRow>(
      `SELECT * FROM mailbox_connections WHERE user_id = $1 AND status = 'connected' LIMIT 1`,
      [user.id],
    );
    const mailbox = mbxRes.rows[0];
    if (!mailbox) {
      throw conflictError(
        'MAILBOX_NOT_CONNECTED',
        'Connect your Microsoft 365 or Google Workspace mailbox before linking messages.',
      );
    }

    const provider = this.normalizeProvider(mailbox.provider);
    const accessToken = await this.ensureAccessToken(mailbox);
    if (provider === 'google_gmail') {
      const synced = await this.requireGmail().fetchSingleMessage(
        accessToken,
        mailbox.email,
        input.providerMessageId,
      );
      const outcome = await this.ingestGraphMessage(
        mailbox,
        synced.direction,
        synced.message,
        null,
        {
          contactId: input.contactId ?? null,
          companyId: input.companyId ?? null,
          dealId: input.dealId ?? null,
        },
        synced.attachments,
      );
      return { synced: outcome.synced, threadId: outcome.threadId };
    }

    const graphMsg = await this.graph.fetchSingleMessage(accessToken, input.providerMessageId);
    const direction: 'inbound' | 'outbound' =
      normalizeEmail(graphMsg.fromEmail) === normalizeEmail(mailbox.email) ? 'outbound' : 'inbound';

    const outcome = await this.ingestGraphMessage(mailbox, direction, graphMsg, accessToken, {
      contactId: input.contactId ?? null,
      companyId: input.companyId ?? null,
      dealId: input.dealId ?? null,
    });
    return { synced: outcome.synced, threadId: outcome.threadId };
  }

  async downloadAttachmentOnDemand(
    user: SessionUser,
    messageId: string,
    attachmentId: string,
  ): Promise<{ buffer: Buffer; filename: string; mimeType: string }> {
    const scope = scopeWhere(user, 'inbox.read', { alias: 't', startParamIndex: 3 });
    const res = await this.db.query<{
      id: string;
      filename: string;
      mime_type: string;
      provider_attachment_id: string;
      provider_message_id: string | null;
      mailbox_connection_id: string | null;
      owner_user_id: string;
    }>(
      `SELECT a.id, a.filename, a.mime_type, a.provider_attachment_id,
              m.provider_message_id,
              COALESCE(a.mailbox_connection_id, m.mailbox_connection_id) AS mailbox_connection_id,
              t.owner_user_id
       FROM email_attachments a
       JOIN email_messages m ON m.id = a.message_id
       JOIN email_threads t ON t.id = m.thread_id
       WHERE a.id = $1 AND m.id = $2 AND ${scope.sql}
       LIMIT 1`,
      [attachmentId, messageId, ...scope.params],
    );
    const att = res.rows[0];
    if (!att || !att.provider_message_id) {
      throw new NotFoundDomainError('Email attachment', attachmentId);
    }
    const providerMessageId = att.provider_message_id;

    const mbxRes = att.mailbox_connection_id
      ? await this.db.query<MailboxRow>(`SELECT * FROM mailbox_connections WHERE id = $1 LIMIT 1`, [
          att.mailbox_connection_id,
        ])
      : await this.db.query<MailboxRow>(
          `SELECT * FROM mailbox_connections WHERE user_id = $1 LIMIT 1`,
          [att.owner_user_id],
        );
    const mailbox = mbxRes.rows[0];
    if (!mailbox || mailbox.status !== 'connected') {
      throw conflictError(
        'MAILBOX_NOT_CONNECTED',
        'The mailbox that owns this attachment is disconnected.',
      );
    }

    const provider = this.normalizeProvider(mailbox.provider);
    const accessToken = await this.ensureAccessToken(mailbox);
    const downloaded =
      provider === 'google_gmail'
        ? await this.requireGmail().downloadAttachment({
            accessToken,
            providerMessageId,
            providerAttachmentId: att.provider_attachment_id,
            maxBytes: this.options.maxAttachmentBytes,
          })
        : await this.graph.downloadAttachment({
            accessToken,
            providerMessageId,
            providerAttachmentId: att.provider_attachment_id,
            maxBytes: this.options.maxAttachmentBytes,
          });

    return {
      buffer: downloaded.buffer,
      filename: att.filename.replace(/[\r\n"]/g, '_'),
      mimeType: att.mime_type || downloaded.contentType,
    };
  }

  /**
   * Dispatches a live automated sequence email through the enrolled sender's connected
   * Microsoft 365 Outlook or Google Workspace Gmail mailbox (`PRD §4.12, §8.7, §15 Q2`).
   * Strictly delegates to Mailpit whenever `NODE_ENV !== 'production'` or `!mailLive`.
   */
  async sendSequenceMessageViaUserMailbox(
    senderUserId: string,
    payload: OutboundEmailPayload,
  ): Promise<OutboundEmailReceipt> {
    if (!(this.options.nodeEnv === 'production' && this.options.mailLive)) {
      return this.mailpit.sendOneToOne(payload);
    }

    const mbxRes = await this.db.query<MailboxRow>(
      `SELECT * FROM mailbox_connections WHERE user_id = $1 LIMIT 1`,
      [senderUserId],
    );
    const mailbox = mbxRes.rows[0];
    if (!mailbox || mailbox.status !== 'connected') {
      throw conflictError(
        'MAILBOX_NOT_CONNECTED',
        'Sender mailbox is not connected to Microsoft 365 or Google Workspace.',
      );
    }

    const provider = this.normalizeProvider(mailbox.provider);
    const accessToken = await this.ensureAccessToken(mailbox);

    if (provider === 'google_gmail') {
      const sent = await this.requireGmail().sendMail({
        accessToken,
        fromEmail: mailbox.email,
        toEmails: [payload.toEmail],
        ccEmails: payload.ccEmails,
        subject: payload.subject,
        bodyText: payload.bodyText,
        bodyHtml: payload.bodyHtml,
        extraHeaders: payload.headers,
      });
      await this.db.query(
        `UPDATE mailbox_connections SET sent_today_count = sent_today_count + 1, updated_at = NOW() WHERE id = $1`,
        [mailbox.id],
      );
      return {
        provider: 'google_gmail',
        providerMessageId: sent.providerMessageId,
        internetMessageId: sent.internetMessageId,
        sentAt: new Date().toISOString(),
      };
    }

    const sent = await this.graph.sendMail({
      accessToken,
      toEmails: [payload.toEmail],
      ccEmails: payload.ccEmails,
      subject: payload.subject,
      bodyText: payload.bodyText,
      bodyHtml: payload.bodyHtml,
      internetMessageHeaders: payload.headers,
    });
    await this.db.query(
      `UPDATE mailbox_connections SET sent_today_count = sent_today_count + 1, updated_at = NOW() WHERE id = $1`,
      [mailbox.id],
    );
    return {
      provider: 'microsoft_graph',
      providerMessageId: sent.providerMessageId,
      internetMessageId: `<${payload.idempotencyKey}@adasglobuspro.com>`,
      sentAt: sent.sentAt,
    };
  }

  // -------------------------------------------------------------------------
  // 5. Email Templates (PRD 4.11, 4.12)
  // -------------------------------------------------------------------------

  async listTemplates(user: SessionUser): Promise<{ items: EmailTemplateView[] }> {
    requireCapability(user, 'inbox.read');
    const res = await this.db.query<Record<string, unknown>>(
      `SELECT *
       FROM templates
       WHERE shared = TRUE OR owner_user_id = $1
       ORDER BY updated_at DESC, name ASC`,
      [user.id],
    );
    return {
      items: res.rows.map((r) => ({
        id: String(r['id']),
        name: String(r['name']),
        category: String(r['category']),
        market: (['US', 'CA', 'OTHER'].includes(String(r['market']))
          ? String(r['market'])
          : 'US') as EmailTemplateView['market'],
        subject: String(r['subject']),
        bodyText: String(r['body_text']),
        shared: Boolean(r['shared']),
        ownerUserId: String(r['owner_user_id']),
        updatedAt: toIso(r['updated_at'] as Date | string) ?? new Date().toISOString(),
      })),
    };
  }

  async createTemplate(user: SessionUser, rawInput: unknown): Promise<EmailTemplateView> {
    requireCapability(user, 'inbox.send');
    const input = CreateEmailTemplateInputSchema.parse(rawInput);
    const id = `tpl_${randomUUID()}`;
    const vars = Array.from(
      new Set(
        [...`${input.subject}\n${input.bodyText}`.matchAll(/\{\{\s*([a-zA-Z0-9_.]+)/g)].map(
          (m) => m[1] ?? '',
        ),
      ),
    ).filter(Boolean);

    const res = await this.db.query<Record<string, unknown>>(
      `INSERT INTO templates (id, name, category, market, subject, body_text, variables, shared, owner_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
       RETURNING *`,
      [
        id,
        input.name,
        input.category,
        input.market,
        input.subject,
        input.bodyText,
        JSON.stringify(vars),
        input.shared,
        user.id,
      ],
    );
    const row = res.rows[0] ?? {};
    return {
      id: String(row['id'] ?? id),
      name: input.name,
      category: input.category,
      market: input.market,
      subject: input.subject,
      bodyText: input.bodyText,
      shared: input.shared,
      ownerUserId: user.id,
      updatedAt: toIso(row['updated_at'] as Date | string) ?? new Date().toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async findIdempotentMessageThread(idemKey: string): Promise<string | null> {
    const res = await this.db.query<{ thread_id: string }>(
      `SELECT thread_id FROM email_messages
       WHERE provider_message_id = $1
          OR provider_message_id = $2
          OR provider_message_id LIKE $3
       LIMIT 1`,
      [`mailpit_1to1_${idemKey}`, `idem:${idemKey}`, `idem:${idemKey}:%`],
    );
    return res.rows[0]?.thread_id ?? null;
  }

  private async assertRecipientNotSuppressed(
    cleanEmail: string,
    contactId: string | null,
  ): Promise<void> {
    const emailHash = sha256Hex(cleanEmail);
    const domain = extractDomainFromEmail(cleanEmail);

    const supRes = await this.db.query<{ reason: string }>(
      `SELECT reason FROM suppressions WHERE email_sha256 = $1 AND lifted_at IS NULL LIMIT 1`,
      [emailHash],
    );
    if (supRes.rows[0]) {
      throw conflictError(
        'RECIPIENT_SUPPRESSED',
        `This email address is on the suppression list (${supRes.rows[0].reason}) and cannot be emailed.`,
      );
    }

    if (domain) {
      const domRes = await this.db.query<{ domain: string }>(
        `SELECT domain FROM suppressed_domains WHERE domain = $1 LIMIT 1`,
        [domain],
      );
      if (domRes.rows[0]) {
        throw conflictError(
          'DOMAIN_SUPPRESSED',
          `The domain ${domain} is blocked on the suppression list.`,
        );
      }
    }

    if (contactId) {
      const dncRes = await this.db.query<{ do_not_contact: boolean }>(
        `SELECT do_not_contact FROM contacts WHERE id = $1 LIMIT 1`,
        [contactId],
      );
      if (dncRes.rows[0]?.do_not_contact) {
        throw conflictError('CONTACT_DO_NOT_CONTACT', 'This contact is marked Do not contact.');
      }
    }
  }

  private async resolveSendTarget(
    user: SessionUser,
    input: {
      toEmail: string;
      contactId: string | null;
      companyId: string | null;
      dealId: string | null;
      leadId: string | null;
    },
  ): Promise<MatchedCrmTarget> {
    let contactId = input.contactId;
    let contactName: string | null = null;
    let companyId = input.companyId;
    let companyName: string | null = null;
    let dealId = input.dealId;
    let leadId = input.leadId;

    if (contactId) {
      const cScope = scopeWhere(user, 'contacts.read', { alias: 'c', startParamIndex: 2 });
      const res = await this.db.query<{
        id: string;
        full_name: string;
        company_id: string | null;
        company_name: string | null;
      }>(
        `SELECT c.id, c.full_name, c.company_id, cmp.name AS company_name
         FROM contacts c
         LEFT JOIN companies cmp ON cmp.id = c.company_id
         WHERE c.id = $1 AND c.deleted_at IS NULL AND ${cScope.sql} LIMIT 1`,
        [contactId, ...cScope.params],
      );
      const row = res.rows[0];
      if (!row) throw new NotFoundDomainError('Contact', contactId);
      contactName = row.full_name;
      companyId = companyId ?? row.company_id;
      companyName = row.company_name;
    } else {
      const byEmail = await this.db.query<{
        contact_id: string;
        full_name: string;
        company_id: string | null;
        company_name: string | null;
      }>(
        `SELECT ce.contact_id, c.full_name, c.company_id, cmp.name AS company_name
         FROM contact_emails ce
         JOIN contacts c ON c.id = ce.contact_id AND c.deleted_at IS NULL
         LEFT JOIN companies cmp ON cmp.id = c.company_id
         WHERE ce.email = $1
         LIMIT 1`,
        [input.toEmail],
      );
      if (byEmail.rows[0]) {
        contactId = byEmail.rows[0].contact_id;
        contactName = byEmail.rows[0].full_name;
        companyId = companyId ?? byEmail.rows[0].company_id;
        companyName = byEmail.rows[0].company_name;
      }
    }

    if (!companyId) {
      const domain = extractDomainFromEmail(input.toEmail);
      if (domain && !isFreeMailDomain(domain)) {
        const cmpRes = await this.db.query<{ id: string; name: string }>(
          `SELECT id, name FROM companies WHERE domain = $1 AND deleted_at IS NULL LIMIT 1`,
          [domain],
        );
        if (cmpRes.rows[0]) {
          companyId = cmpRes.rows[0].id;
          companyName = cmpRes.rows[0].name;
        }
      }
    } else if (!companyName) {
      const cmpRes = await this.db.query<{ name: string }>(
        `SELECT name FROM companies WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
        [companyId],
      );
      companyName = cmpRes.rows[0]?.name ?? null;
    }

    if (!leadId && contactId) {
      const lRes = await this.db.query<{ id: string }>(
        `SELECT id FROM leads
         WHERE contact_id = $1 AND deleted_at IS NULL AND status_category != 'closed'
         ORDER BY updated_at DESC LIMIT 1`,
        [contactId],
      );
      leadId = lRes.rows[0]?.id ?? null;
    }

    if (!dealId && (contactId || companyId)) {
      const dRes = await this.db.query<{ id: string }>(
        `SELECT id FROM deals
         WHERE deleted_at IS NULL AND stage_category = 'open'
           AND (($1::text IS NOT NULL AND primary_contact_id = $1) OR ($2::text IS NOT NULL AND company_id = $2))
         ORDER BY updated_at DESC LIMIT 1`,
        [contactId, companyId],
      );
      dealId = dRes.rows[0]?.id ?? null;
    }

    return {
      contactId,
      contactName,
      contactEmail: input.toEmail,
      companyId,
      companyName,
      leadId,
      dealId,
      ownerUserId: user.id,
      teamId: user.teamId,
    };
  }

  private mapThreadSummary(r: Record<string, unknown>): InboxThreadSummary {
    return {
      id: String(r['id']),
      subject: String(r['subject']),
      snippet: String(r['snippet'] ?? ''),
      status: (['open', 'replied', 'archived'].includes(String(r['status']))
        ? String(r['status'])
        : 'open') as InboxThreadSummary['status'],
      messageCount: Number(r['message_count'] ?? 1),
      unreadCount: Number(r['unread_count'] ?? 0),
      lastMessageAt: toIso(r['last_message_at'] as Date | string) ?? new Date().toISOString(),
      ownerUserId: String(r['owner_user_id']),
      contactId: typeof r['contact_id'] === 'string' ? r['contact_id'] : null,
      contactName: typeof r['contact_name'] === 'string' ? r['contact_name'] : null,
      contactEmail: typeof r['contact_email'] === 'string' ? r['contact_email'] : null,
      companyId: typeof r['company_id'] === 'string' ? r['company_id'] : null,
      companyName: typeof r['company_name'] === 'string' ? r['company_name'] : null,
      dealId: typeof r['deal_id'] === 'string' ? r['deal_id'] : null,
      dealName: typeof r['deal_name'] === 'string' ? r['deal_name'] : null,
      leadId: typeof r['lead_id'] === 'string' ? r['lead_id'] : null,
      hasFailedOutbound: Boolean(r['has_failed_outbound']),
    };
  }
}
