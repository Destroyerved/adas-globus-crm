import { randomBytes, randomUUID } from 'node:crypto';
import {
  appendOutreachComplianceFooter,
  BatchEnrollSequenceInputSchema,
  CampaignBlockSchema,
  CreateCampaignInputSchema,
  CreateMarketingListInputSchema,
  CreateOutreachTemplateInputSchema,
  CreateSenderIdentityInputSchema,
  CreateSequenceInputSchema,
  DEFAULT_POSTAL_ADDRESSES,
  EnrollmentStateActionInputSchema,
  EnrollSequenceInputSchema,
  extractTrackableUrls,
  ModifyListMembersInputSchema,
  renderCampaignBlocks,
  renderEmailTemplate,
  rewriteUrlsWithClickTokens,
  ScheduleCampaignInputSchema,
  TestSendCampaignInputSchema,
  UpdateCampaignInputSchema,
  UpdateMarketingListInputSchema,
  UpdateOutreachTemplateInputSchema,
  UpdateSenderIdentityInputSchema,
  UpdateSequenceInputSchema,
  type BatchEnrollSequenceInput,
  type CampaignBlock,
  type CreateCampaignInput,
  type CreateMarketingListInput,
  type CreateOutreachTemplateInput,
  type CreateSenderIdentityInput,
  type CreateSequenceInput,
  type EnrollmentStateActionInput,
  type EnrollSequenceInput,
  type Market,
  type MessageChannel,
  type ModifyListMembersInput,
  type ScheduleCampaignInput,
  type SendableReasonCode,
  type SessionUser,
  type TestSendCampaignInput,
  type UpdateCampaignInput,
  type UpdateMarketingListInput,
  type UpdateOutreachTemplateInput,
  type UpdateSenderIdentityInput,
  type UpdateSequenceInput,
} from '@adas/shared';
import { addBusinessDays, nextSendWindowStart } from '../../platform/calendar/index.js';
import { sha256Hex, type DatabaseService, type DbTx } from '../../platform/db/index.js';
import {
  DomainError,
  NotFoundDomainError,
  ValidationDomainError,
  VersionConflictError,
} from '../../platform/errors/index.js';
import { compileFilter, SqlParams, type FieldRegistry } from '../../platform/list/index.js';
import {
  parseEspWebhookPayload,
  verifyEspWebhookSignature,
  type BulkSender,
  type EspBulkSender,
  type MailpitTransport,
  type OutboundEmailPayload,
  type OutboundEmailReceipt,
} from '../../platform/mail-transport/index.js';
import { extractDomainFromEmail, normalizeEmail } from '../../platform/normalize/index.js';
import { type OutboxEvent } from '../../platform/outbox/index.js';
import { getCapabilityScope, requireCapability, scopeWhere } from '../../platform/scope/index.js';
import { type ComplianceService } from '../compliance/index.js';
import { addNotification } from '../notifications/index.js';

export interface SendMessageJobInput {
  idempotencyKey: string;
  channel: MessageChannel;
  recipientEmail: string;
  contactId?: string | null;
  senderUserId?: string;
  senderIdentityId?: string | null;
  sequenceId?: string | null;
  sequenceEnrollmentId?: string | null;
  sequenceStepId?: string | null;
  campaignId?: string | null;
  campaignRecipientId?: string | null;
  subject: string;
  bodyText: string;
  bodyHtml?: string | null;
  clickTrackingEnabled?: boolean;
  excludeUnverifiedInCampaigns?: boolean;
  mailboxDailyCapOverride?: number | null;
  sendWindowStartMinutes?: number;
  sendWindowEndMinutes?: number;
  bypassSendWindow?: boolean;
  now?: Date;
}

export interface SendMessageJobResult {
  sent: boolean;
  deduplicated: boolean;
  reasonCode: SendableReasonCode;
  reasonMessage: string;
  messageSendId: string | null;
  providerMessageId: string | null;
  internetMessageId?: string | null;
}

export type LiveMailboxSenderFn = (
  senderUserId: string,
  payload: OutboundEmailPayload,
) => Promise<OutboundEmailReceipt>;

export interface OutreachServiceOptions {
  nodeEnv?: 'development' | 'test' | 'production';
  mailLive?: boolean;
  publicHost?: string;
  sendingSubdomain?: string;
  espSender?: EspBulkSender | BulkSender | null;
  espWebhookSecret?: string | null;
  liveMailboxSender?: LiveMailboxSenderFn | null;
}

const SEGMENT_CONTACT_REGISTRY: FieldRegistry = {
  market: { sql: 'c.market', type: 'enum' },
  'company.market': { sql: 'COALESCE(cmp.market, c.market)', type: 'enum' },
  'company.firmType': { sql: 'cmp.firm_type', type: 'enum' },
  firmType: { sql: 'cmp.firm_type', type: 'enum' },
  'company.staffBand': { sql: 'cmp.staff_band', type: 'enum' },
  'company.sizeBand': { sql: 'cmp.staff_band', type: 'enum' },
  staffBand: { sql: 'cmp.staff_band', type: 'enum' },
  'company.accountStatus': { sql: 'cmp.account_status', type: 'enum' },
  'company.software': { sql: 'cmp.accounting_software', type: 'jsonArray' },
  software: { sql: 'cmp.accounting_software', type: 'jsonArray' },
  title: { sql: 'c.title', type: 'text' },
  seniority: { sql: 'c.seniority', type: 'enum' },
  email: { sql: 'c.primary_email', type: 'text' },
  emailStatus: { sql: 'c.email_verification_status', type: 'enum' },
  'email.verificationStatus': { sql: 'c.email_verification_status', type: 'enum' },
  doNotContact: { sql: 'c.do_not_contact', type: 'boolean' },
  score: { sql: 'c.lead_score', type: 'number' },
  ownerId: { sql: 'c.owner_user_id', type: 'user' },
  teamId: { sql: 'c.team_id', type: 'enum' },
  createdAt: { sql: 'c.created_at', type: 'date' },
  updatedAt: { sql: 'c.updated_at', type: 'date' },
  lastContactedAt: { sql: 'c.last_contacted_at', type: 'date' },
  tags: { sql: 'c.id', type: 'tags', tagEntity: 'contact' },
};

const TERMINAL_SKIP_CODES = new Set<SendableReasonCode>([
  'INVALID_EMAIL',
  'SUPPRESSED_EMAIL',
  'SUPPRESSED_DOMAIN',
  'UNSUBSCRIBED',
  'COMPLAINED',
  'HARD_BOUNCED',
  'DO_NOT_CONTACT',
  'CONSENT_REVOKED',
  'CONSENT_EXPIRED',
  'NO_LAWFUL_BASIS',
  'MARKET_BLOCKED',
]);

function isNonEmptyFilter(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  return 'field' in raw || 'and' in raw || 'or' in raw;
}

function deterministicJitterMinutes(seed: string, maxMinutes = 15): number {
  if (maxMinutes <= 0) return 0;
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return hash % (maxMinutes + 1);
}

export class OutreachService {
  private readonly nodeEnv: 'development' | 'test' | 'production';
  private readonly mailLive: boolean;
  private readonly publicHost: string;
  private readonly sendingSubdomain: string;
  private readonly espSender: EspBulkSender | BulkSender | null;
  private readonly espWebhookSecret: string | null;
  private liveMailboxSender: LiveMailboxSenderFn | null;

  constructor(
    private readonly db: DatabaseService,
    private readonly compliance: ComplianceService,
    private readonly transport: MailpitTransport,
    options: OutreachServiceOptions = {},
  ) {
    this.nodeEnv = options.nodeEnv ?? 'development';
    this.mailLive = options.mailLive ?? false;
    this.publicHost = options.publicHost ?? 'go.adasglobuspro.com';
    this.sendingSubdomain = options.sendingSubdomain ?? 'mail.adasglobuspro.com';
    this.espSender = options.espSender ?? null;
    this.espWebhookSecret = options.espWebhookSecret ?? null;
    this.liveMailboxSender = options.liveMailboxSender ?? null;
  }

  setLiveMailboxSender(sender: LiveMailboxSenderFn): void {
    this.liveMailboxSender = sender;
  }

  private isLiveMailEnabled(): boolean {
    return this.nodeEnv === 'production' && this.mailLive;
  }

  private async getPostalAddresses(): Promise<Record<Market, string>> {
    const res = await this.db.query<{ key: string; value_json: unknown }>(
      `SELECT key, value_json FROM settings
       WHERE key IN ('compliance.postal_address.US', 'compliance.postal_address.CA')`,
    );
    const result: Record<Market, string> = { ...DEFAULT_POSTAL_ADDRESSES };
    for (const row of res.rows) {
      if (typeof row.value_json === 'string' && row.value_json.trim()) {
        if (row.key === 'compliance.postal_address.US') result.US = row.value_json.trim();
        if (row.key === 'compliance.postal_address.CA') result.CA = row.value_json.trim();
      }
    }
    return result;
  }

  private async isCounselSignedOff(): Promise<boolean> {
    const res = await this.db.query<{ value_json: unknown }>(
      `SELECT value_json FROM settings WHERE key = 'compliance.counsel_signed_off' LIMIT 1`,
    );
    return res.rows[0]?.value_json === true;
  }

  /**
   * PRD §5.1, §6.7, §8.5 & AGENTS.md §5 / §10 (A15, A18):
   * `executeSendMessageJob` (`send.message` job) is the ONLY code path that writes to `message_sends`,
   * and it ALWAYS calls `checkSendable` (via `evaluateRecipientSendability`) immediately before sending.
   */
  async executeSendMessageJob(input: SendMessageJobInput): Promise<SendMessageJobResult> {
    const cleanEmail = normalizeEmail(input.recipientEmail);
    if (!cleanEmail) {
      return {
        sent: false,
        deduplicated: false,
        reasonCode: 'INVALID_EMAIL',
        reasonMessage: 'Invalid email syntax',
        messageSendId: null,
        providerMessageId: null,
      };
    }

    // Counsel sign-off gate before any live commercial send (AGENTS.md §10, PRD §11)
    if (this.isLiveMailEnabled() && input.channel !== 'transactional') {
      const signedOff = await this.isCounselSignedOff();
      if (!signedOff) {
        throw new DomainError({
          status: 422,
          code: 'COUNSEL_SIGNOFF_REQUIRED',
          title: 'Counsel sign-off required before live outreach',
          detail:
            'Live email sending is blocked until legal counsel signs off PRD section 5 in Settings.',
        });
      }
    }

    // 1. Idempotency check (`message_sends.idempotency_key` unique — A15)
    const existing = await this.db.query<{
      id: string;
      provider_message_id: string | null;
      internet_message_id: string | null;
      compliance_reason_code: SendableReasonCode;
    }>(
      `SELECT id, provider_message_id, internet_message_id, compliance_reason_code
       FROM message_sends
       WHERE idempotency_key = $1
       LIMIT 1`,
      [input.idempotencyKey],
    );
    const existingRow = existing.rows[0];
    if (existingRow) {
      return {
        sent: true,
        deduplicated: true,
        reasonCode: existingRow.compliance_reason_code,
        reasonMessage: 'Idempotent replay of already-sent message',
        messageSendId: existingRow.id,
        providerMessageId: existingRow.provider_message_id,
        internetMessageId: existingRow.internet_message_id,
      };
    }

    // 2. Mandatory compliance gate (`checkSendable`)
    const check = await this.compliance.evaluateRecipientSendability({
      email: cleanEmail,
      channel: input.channel,
      senderUserId: input.senderUserId,
      senderIdentityId: input.senderIdentityId ?? null,
      sequenceId: input.sequenceId ?? null,
      campaignId: input.campaignId ?? null,
      mailboxDailyCapOverride: input.mailboxDailyCapOverride ?? null,
      sendWindowStartMinutes: input.sendWindowStartMinutes,
      sendWindowEndMinutes: input.sendWindowEndMinutes,
      excludeUnverifiedInCampaigns: input.excludeUnverifiedInCampaigns ?? false,
      bypassSendWindow: input.bypassSendWindow ?? false,
      now: input.now,
    });

    if (!check.sendable) {
      return {
        sent: false,
        deduplicated: false,
        reasonCode: check.reasonCode,
        reasonMessage: check.reasonMessage,
        messageSendId: null,
        providerMessageId: null,
      };
    }

    // 3. Generate single-purpose hashed unsubscribe token & market-specific postal footer (PRD 5.5, 8.6)
    const unsubToken = await this.compliance.createUnsubscribeToken({
      email: cleanEmail,
      contactId: input.contactId ?? null,
      channel: input.channel,
      sourceId: input.sequenceEnrollmentId ?? input.campaignId ?? null,
    });
    const unsubUrl = `https://${this.publicHost}/u/${unsubToken}`;

    let fromEmail = 'outreach@adasglobuspro.example.com';
    if (input.senderIdentityId) {
      const idRes = await this.db.query<{ from_email: string; from_name: string }>(
        `SELECT from_email, from_name FROM sender_identities WHERE id = $1 LIMIT 1`,
        [input.senderIdentityId],
      );
      if (idRes.rows[0]) {
        fromEmail = idRes.rows[0].from_email;
      }
    } else if (input.senderUserId) {
      const senderRes = await this.db.query<{ email: string }>(
        `SELECT COALESCE(
           (SELECT email FROM mailbox_connections WHERE user_id = $1 AND status = 'connected' LIMIT 1),
           u.email
         ) AS email
         FROM users u
         WHERE u.id = $1
         LIMIT 1`,
        [input.senderUserId],
      );
      if (senderRes.rows[0]) {
        fromEmail = senderRes.rows[0].email;
      }
    }

    const postalAddresses = await this.getPostalAddresses();
    const withFooter =
      input.channel === 'sequence' || input.channel === 'campaign'
        ? appendOutreachComplianceFooter({
            channel: input.channel,
            market: check.market,
            bodyText: input.bodyText,
            bodyHtml: input.bodyHtml ?? null,
            unsubscribeUrl: unsubUrl,
            postalAddress: postalAddresses[check.market],
          })
        : {
            bodyText:
              input.channel === 'one_to_one'
                ? `${input.bodyText}\n\n---\nADAS Globus Pro · Unsubscribe: ${unsubUrl}`
                : input.bodyText,
            bodyHtml: input.bodyHtml ?? undefined,
          };

    // 4. Optional stored-URL click tracking (`click_tokens` on `go.` — PRD 8.6, never open redirect)
    const messageSendId = `msnd_${randomUUID()}`;
    const pendingClickTokens: Array<{ tokenSha256: string; targetUrl: string }> = [];
    let finalBodyText = withFooter.bodyText;
    let finalBodyHtml = withFooter.bodyHtml;

    if (input.clickTrackingEnabled) {
      const trackableUrls = extractTrackableUrls(finalBodyText, finalBodyHtml, unsubUrl);
      const replacements = new Map<string, string>();
      for (const targetUrl of trackableUrls) {
        const rawClickToken = `clk_${randomBytes(18).toString('base64url')}`;
        pendingClickTokens.push({
          tokenSha256: sha256Hex(rawClickToken),
          targetUrl,
        });
        replacements.set(targetUrl, `https://${this.publicHost}/c/${rawClickToken}`);
      }
      if (replacements.size > 0) {
        const rewritten = rewriteUrlsWithClickTokens({
          bodyText: finalBodyText,
          bodyHtml: finalBodyHtml,
          replacements,
        });
        finalBodyText = rewritten.bodyText;
        finalBodyHtml = rewritten.bodyHtml;
      }
    }

    const payload: OutboundEmailPayload = {
      idempotencyKey: input.idempotencyKey,
      fromEmail,
      toEmail: cleanEmail,
      subject: input.subject,
      bodyText: finalBodyText,
      bodyHtml: finalBodyHtml,
      headers:
        input.channel === 'transactional'
          ? {}
          : {
              'List-Unsubscribe': `<${unsubUrl}>`,
              'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
            },
    };

    // 5. Provider dispatch (PRD 8.7: strictly Mailpit outside live production)
    const receipt =
      input.channel === 'campaign'
        ? this.isLiveMailEnabled() && this.espSender
          ? await this.espSender.sendCampaignMessage(payload)
          : await this.transport.sendCampaignMessage(payload)
        : input.channel === 'sequence' &&
            this.isLiveMailEnabled() &&
            this.liveMailboxSender &&
            input.senderUserId
          ? await this.liveMailboxSender(input.senderUserId, payload)
          : await this.transport.sendOneToOne(payload);

    // 6. Persist `message_sends` (the ONLY place in the codebase that inserts into `message_sends`)
    const sentTimestamp = (input.now ?? new Date()).toISOString();
    await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO message_sends (
           id, idempotency_key, channel, recipient_email, contact_id, sender_user_id,
           sender_identity_id, sequence_enrollment_id, sequence_step_id,
           campaign_id, campaign_recipient_id, subject, body_text, body_html,
           transport_provider, provider_message_id, internet_message_id,
           status, compliance_reason_code, sent_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6,
           $7, $8, $9,
           $10, $11, $12, $13, $14,
           $15, $16, $17,
           'sent', 'OK', $18::timestamptz
         )`,
        [
          messageSendId,
          input.idempotencyKey,
          input.channel,
          cleanEmail,
          input.contactId ?? null,
          input.senderUserId ?? null,
          input.senderIdentityId ?? null,
          input.sequenceEnrollmentId ?? null,
          input.sequenceStepId ?? null,
          input.campaignId ?? null,
          input.campaignRecipientId ?? null,
          input.subject,
          finalBodyText,
          finalBodyHtml ?? null,
          receipt.provider,
          receipt.providerMessageId,
          receipt.internetMessageId ?? null,
          sentTimestamp,
        ],
      );

      for (const ct of pendingClickTokens) {
        await tx.query(
          `INSERT INTO click_tokens (
             token_sha256, target_url, message_send_id, campaign_id, sequence_enrollment_id, contact_id
           ) VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (token_sha256) DO NOTHING`,
          [
            ct.tokenSha256,
            ct.targetUrl,
            messageSendId,
            input.campaignId ?? null,
            input.sequenceEnrollmentId ?? null,
            input.contactId ?? null,
          ],
        );
      }

      if (input.senderUserId && (input.channel === 'sequence' || input.channel === 'one_to_one')) {
        await tx.query(
          `UPDATE mailbox_connections
           SET sent_today_count = sent_today_count + 1, updated_at = NOW()
           WHERE user_id = $1`,
          [input.senderUserId],
        );
      }

      if (input.senderIdentityId && input.channel === 'campaign') {
        await tx.query(
          `UPDATE sender_identities
           SET sent_today_count = sent_today_count + 1, updated_at = NOW()
           WHERE id = $1`,
          [input.senderIdentityId],
        );
      }

      if (input.contactId && (input.channel === 'sequence' || input.channel === 'campaign')) {
        const companyLookup = await tx.query<{ company_id: string | null }>(
          `SELECT company_id FROM contacts WHERE id = $1 LIMIT 1`,
          [input.contactId],
        );
        const companyId = companyLookup.rows[0]?.company_id ?? null;
        await tx.query(
          `INSERT INTO activities (
             id, entity_type, entity_id, company_id, contact_id,
             activity_type, title, detail, actor_user_id, metadata, occurred_at
           ) VALUES (
             $1, 'contact', $2, $3, $2,
             $4, $5, $6, $7, $8::jsonb, $9::timestamptz
           )`,
          [
            `act_${randomUUID()}`,
            input.contactId,
            companyId,
            input.channel === 'sequence' ? 'sequence_step' : 'campaign_email',
            input.channel === 'sequence'
              ? `Sequence email sent: ${input.subject}`
              : `Campaign email sent: ${input.subject}`,
            input.subject,
            input.senderUserId ?? null,
            JSON.stringify({
              messageSendId,
              channel: input.channel,
              sequenceEnrollmentId: input.sequenceEnrollmentId ?? null,
              campaignId: input.campaignId ?? null,
            }),
            sentTimestamp,
          ],
        );

        await tx.query(
          `UPDATE contacts
           SET last_contacted_at = GREATEST(COALESCE(last_contacted_at, $2::timestamptz), $2::timestamptz)
           WHERE id = $1`,
          [input.contactId, sentTimestamp],
        );
      }

      await this.db.addOutboxEvent(tx, {
        eventType: input.channel === 'sequence' ? 'sequence.step_sent' : 'email.sent',
        aggregateType: input.channel === 'sequence' ? 'sequence_enrollment' : 'message_send',
        aggregateId: input.sequenceEnrollmentId ?? messageSendId,
        payload: {
          messageSendId,
          channel: input.channel,
          contactId: input.contactId ?? null,
          campaignId: input.campaignId ?? null,
          sequenceEnrollmentId: input.sequenceEnrollmentId ?? null,
        },
      });
    });

    return {
      sent: true,
      deduplicated: false,
      reasonCode: 'OK',
      reasonMessage: check.reasonMessage,
      messageSendId,
      providerMessageId: receipt.providerMessageId,
      internetMessageId: receipt.internetMessageId ?? null,
    };
  }

  // -------------------------------------------------------------------------
  // Phase 4 Compatibility Helpers (PRD §4.11, A10, A11, A15)
  // -------------------------------------------------------------------------

  async listInboxThreads(user: SessionUser): Promise<Record<string, unknown>[]> {
    const scope = scopeWhere(user, 'inbox.read', { alias: 't', startParamIndex: 1 });
    const res = await this.db.query(
      `SELECT t.*, c.full_name AS contact_name, c.primary_email AS contact_email,
              cmp.name AS company_name
       FROM email_threads t
       LEFT JOIN contacts c ON c.id = t.contact_id
       LEFT JOIN companies cmp ON cmp.id = t.company_id
       WHERE ${scope.sql}
       ORDER BY t.last_message_at DESC`,
      scope.params,
    );
    return res.rows;
  }

  async syncMailboxMessage(input: {
    providerMessageId: string;
    direction: 'inbound' | 'outbound';
    fromEmail: string;
    toEmails: string[];
    subject: string;
    bodyText: string;
    mailboxOwnerUserId?: string;
    inReplyTo?: string | null;
  }): Promise<{
    synced: boolean;
    reason?: string;
    threadId: string | null;
    messageId: string | null;
    stoppedSequenceEnrollments: number;
    followUpTaskId: string | null;
  }> {
    const participants = [input.fromEmail, ...input.toEmails]
      .map((e) => normalizeEmail(e))
      .filter((e): e is string => Boolean(e));

    if (participants.length === 0) {
      return {
        synced: false,
        reason: 'no_valid_participants',
        threadId: null,
        messageId: null,
        stoppedSequenceEnrollments: 0,
        followUpTaskId: null,
      };
    }

    const placeholders = participants.map((_, i) => `$${i + 1}`).join(', ');
    const matchedRes = await this.db.query<{
      contact_id: string;
      email: string;
      company_id: string | null;
      owner_user_id: string;
      team_id: string | null;
      full_name: string;
    }>(
      `SELECT ce.contact_id, ce.email, c.company_id, c.owner_user_id, c.team_id, c.full_name
       FROM contact_emails ce
       JOIN contacts c ON c.id = ce.contact_id
       WHERE ce.email IN (${placeholders}) AND c.deleted_at IS NULL
       LIMIT 1`,
      participants,
    );

    const matched = matchedRes.rows[0];
    if (!matched) {
      return {
        synced: false,
        reason: 'unknown_participant_ignored',
        threadId: null,
        messageId: null,
        stoppedSequenceEnrollments: 0,
        followUpTaskId: null,
      };
    }

    return this.db.transaction(async (tx) => {
      const existingThread = await tx.query<{ id: string }>(
        `SELECT id FROM email_threads WHERE contact_id = $1 ORDER BY last_message_at DESC LIMIT 1`,
        [matched.contact_id],
      );

      let threadId = existingThread.rows[0]?.id ?? null;
      if (!threadId) {
        threadId = `thd_${randomUUID()}`;
        await tx.query(
          `INSERT INTO email_threads (
             id, subject, contact_id, company_id, owner_user_id, team_id, last_message_at, message_count, snippet, status
           ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), 1, $7, $8)`,
          [
            threadId,
            input.subject,
            matched.contact_id,
            matched.company_id,
            input.mailboxOwnerUserId ?? matched.owner_user_id,
            matched.team_id,
            input.bodyText.slice(0, 140),
            input.direction === 'inbound' ? 'replied' : 'open',
          ],
        );
      } else {
        await tx.query(
          `UPDATE email_threads
           SET last_message_at = NOW(),
               message_count = message_count + 1,
               snippet = $3,
               status = CASE WHEN $2 = 'inbound' THEN 'replied' ELSE status END,
               updated_at = NOW()
           WHERE id = $1`,
          [threadId, input.direction, input.bodyText.slice(0, 140)],
        );
      }

      const messageId = `msg_${randomUUID()}`;
      await tx.query(
        `INSERT INTO email_messages (
           id, thread_id, provider_message_id, direction, from_email, to_emails,
           subject, body_preview, body_text, in_reply_to
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
         ON CONFLICT (provider_message_id) DO NOTHING`,
        [
          messageId,
          threadId,
          input.providerMessageId,
          input.direction,
          normalizeEmail(input.fromEmail) ?? input.fromEmail,
          JSON.stringify(input.toEmails),
          input.subject,
          input.bodyText.slice(0, 140),
          input.bodyText,
          input.inReplyTo ?? null,
        ],
      );

      let stoppedSequenceEnrollments = 0;
      let followUpTaskId: string | null = null;

      // PRD §4.12 & §8.3 (A15) — Inbound reply stops active sequence enrollments for the contact
      // AND (when `stop_on_company_reply` is enabled) colleagues at the same company!
      if (input.direction === 'inbound') {
        const stoppedRes = await tx.query<{ id: string; sender_user_id: string }>(
          `UPDATE sequence_enrollments se
           SET status = 'replied',
               stop_reason = 'Recipient replied to outreach',
               next_send_at = NULL,
               stopped_at = NOW()
           FROM sequences s
           WHERE se.sequence_id = s.id
             AND se.status IN ('active', 'paused')
             AND (
               se.contact_id = $1
               OR (
                 $2::text IS NOT NULL
                 AND s.stop_on_company_reply = TRUE
                 AND se.contact_id IN (SELECT id FROM contacts WHERE company_id = $2 AND deleted_at IS NULL)
               )
             )
           RETURNING se.id, se.sender_user_id`,
          [matched.contact_id, matched.company_id],
        );
        stoppedSequenceEnrollments = stoppedRes.rows.length;

        if (stoppedSequenceEnrollments > 0) {
          const firstStopped = stoppedRes.rows[0];
          const assigneeId = firstStopped?.sender_user_id ?? matched.owner_user_id;
          followUpTaskId = `tsk_reply_${randomUUID()}`;
          await tx.query(
            `INSERT INTO tasks (
               id, title, task_type, priority, status, due_at,
               assignee_user_id, team_id, company_id, contact_id
             ) VALUES (
               $1, $2, 'follow_up', 'high', 'open', NOW() + INTERVAL '2 hours',
               $3, $4, $5, $6
             )`,
            [
              followUpTaskId,
              `Reply received from ${matched.full_name}: ${input.subject}`,
              assigneeId,
              matched.team_id,
              matched.company_id,
              matched.contact_id,
            ],
          );

          await this.db.addOutboxEvent(tx, {
            eventType: 'email.replied',
            aggregateType: 'contact',
            aggregateId: matched.contact_id,
            payload: {
              contactId: matched.contact_id,
              stoppedEnrollmentIds: stoppedRes.rows.map((r) => r.id),
              followUpTaskId,
            },
          });
        }
      }

      return {
        synced: true,
        threadId,
        messageId,
        stoppedSequenceEnrollments,
        followUpTaskId,
      };
    });
  }

  async sendInboxReply(
    user: SessionUser,
    input: {
      contactId: string;
      subject: string;
      bodyText: string;
      idempotencyKey?: string;
    },
  ): Promise<SendMessageJobResult> {
    requireCapability(user, 'inbox.send');
    const contactRes = await this.db.query<{
      id: string;
      primary_email: string;
      company_id: string | null;
    }>(`SELECT id, primary_email, company_id FROM contacts WHERE id = $1 LIMIT 1`, [
      input.contactId,
    ]);
    const contact = contactRes.rows[0];
    if (!contact) {
      throw new NotFoundDomainError('Contact', input.contactId);
    }

    const result = await this.executeSendMessageJob({
      idempotencyKey: input.idempotencyKey ?? `inbox_${randomUUID()}`,
      channel: 'one_to_one',
      recipientEmail: contact.primary_email,
      contactId: contact.id,
      senderUserId: user.id,
      subject: input.subject,
      bodyText: input.bodyText,
      bypassSendWindow: true,
    });

    if (result.sent && result.providerMessageId) {
      await this.syncMailboxMessage({
        providerMessageId: result.providerMessageId,
        direction: 'outbound',
        fromEmail: user.email,
        toEmails: [contact.primary_email],
        subject: input.subject,
        bodyText: input.bodyText,
        mailboxOwnerUserId: user.id,
      });
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // Templates (PRD §4.12, §4.13, §7.3)
  // -------------------------------------------------------------------------

  async listTemplates(
    user: SessionUser,
    query: { channel?: string; market?: string; q?: string } = {},
  ): Promise<Record<string, unknown>[]> {
    const seqScope = getCapabilityScope(user, 'sequences.read');
    const cmpgScope = getCapabilityScope(user, 'campaigns.read');
    const inboxScope = getCapabilityScope(user, 'inbox.read');
    if (seqScope === 'none' && cmpgScope === 'none' && inboxScope === 'none') {
      requireCapability(user, 'sequences.read');
    }

    const params: unknown[] = [user.id, user.teamId];
    const where: string[] = [
      `(t.shared = TRUE OR t.owner_user_id = $1 OR ($2::text IS NOT NULL AND t.team_id = $2))`,
    ];

    if (query.channel && ['sequence', 'campaign', 'inbox'].includes(query.channel)) {
      params.push(query.channel);
      where.push(`t.channel = $${params.length}`);
    }
    if (query.market && ['US', 'CA', 'OTHER'].includes(query.market)) {
      params.push(query.market);
      where.push(`t.market = $${params.length}`);
    }
    if (query.q && query.q.trim()) {
      params.push(`%${query.q.trim()}%`);
      where.push(`(t.name ILIKE $${params.length} OR t.subject ILIKE $${params.length})`);
    }

    const res = await this.db.query(
      `SELECT t.*, u.name AS owner_name
       FROM templates t
       LEFT JOIN users u ON u.id = t.owner_user_id
       WHERE ${where.join(' AND ')}
       ORDER BY t.updated_at DESC, t.created_at DESC`,
      params,
    );
    return res.rows;
  }

  async createTemplate(
    user: SessionUser,
    rawInput: CreateOutreachTemplateInput,
  ): Promise<Record<string, unknown>> {
    const input = CreateOutreachTemplateInputSchema.parse(rawInput);
    if (input.channel === 'campaign') {
      requireCapability(user, 'campaigns.write');
    } else {
      requireCapability(user, 'sequences.write');
    }

    let bodyHtml = input.bodyHtml ?? null;
    let bodyText = input.bodyText;
    if (input.blocks.length > 0) {
      const rendered = renderCampaignBlocks(input.blocks);
      bodyHtml = rendered.html;
      if (!bodyText.trim()) bodyText = rendered.text;
    }
    if (!bodyText.trim()) {
      throw new ValidationDomainError('Enter plain-text copy or add at least one content block.', {
        bodyText: ['Enter template copy.'],
      });
    }

    const id = `tpl_${randomUUID()}`;
    const res = await this.db.query(
      `INSERT INTO templates (
         id, name, category, channel, market, subject, body_text, body_html,
         blocks_json, variables, shared, owner_user_id, team_id, version
       ) VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, 1)
       RETURNING *`,
      [
        id,
        input.name,
        input.channel,
        input.market,
        input.subject,
        bodyText,
        bodyHtml,
        JSON.stringify(input.blocks),
        JSON.stringify(input.variables),
        input.shared,
        user.id,
        user.teamId,
      ],
    );
    return res.rows[0] ?? { id };
  }

  async updateTemplate(
    user: SessionUser,
    templateId: string,
    rawInput: UpdateOutreachTemplateInput,
  ): Promise<Record<string, unknown>> {
    const input = UpdateOutreachTemplateInputSchema.parse(rawInput);
    const existingRes = await this.db.query<{
      id: string;
      channel: string;
      owner_user_id: string;
      version: number;
      body_text: string;
      body_html: string | null;
      blocks_json: CampaignBlock[];
    }>(`SELECT * FROM templates WHERE id = $1 LIMIT 1`, [templateId]);
    const existing = existingRes.rows[0];
    if (!existing) throw new NotFoundDomainError('Template', templateId);

    if (existing.channel === 'campaign') {
      requireCapability(user, 'campaigns.write');
    } else {
      requireCapability(user, 'sequences.write');
    }

    if (
      existing.owner_user_id !== user.id &&
      user.role !== 'Admin' &&
      user.role !== 'Marketing Manager'
    ) {
      throw new DomainError({
        status: 403,
        code: 'FORBIDDEN_SCOPE',
        title: 'Cannot edit another user’s template',
        detail: 'Only the template owner, a Marketing Manager, or an Admin can edit this template.',
      });
    }

    const nextBlocks = input.blocks ?? existing.blocks_json ?? [];
    let nextBodyHtml = input.bodyHtml !== undefined ? input.bodyHtml : existing.body_html;
    let nextBodyText = input.bodyText !== undefined ? input.bodyText : existing.body_text;
    if (input.blocks && input.blocks.length > 0) {
      const rendered = renderCampaignBlocks(input.blocks);
      nextBodyHtml = rendered.html;
      if (!input.bodyText) nextBodyText = rendered.text;
    }

    const updated = await this.db.query(
      `UPDATE templates
       SET name = COALESCE($3, name),
           market = COALESCE($4, market),
           subject = COALESCE($5, subject),
           body_text = $6,
           body_html = $7,
           blocks_json = $8::jsonb,
           variables = COALESCE($9::jsonb, variables),
           shared = COALESCE($10, shared),
           version = version + 1,
           updated_at = NOW()
       WHERE id = $1 AND version = $2
       RETURNING *`,
      [
        templateId,
        input.version,
        input.name ?? null,
        input.market ?? null,
        input.subject ?? null,
        nextBodyText,
        nextBodyHtml,
        JSON.stringify(nextBlocks),
        input.variables ? JSON.stringify(input.variables) : null,
        input.shared ?? null,
      ],
    );
    const row = updated.rows[0];
    if (!row) throw new VersionConflictError('Template', templateId);
    return row;
  }

  // -------------------------------------------------------------------------
  // Phase 5a: Sequences Engine & `sequence.tick` (PRD §4.12, §8.3, A15–A18)
  // -------------------------------------------------------------------------

  async listSequences(user: SessionUser): Promise<Record<string, unknown>[]> {
    const scope = scopeWhere(user, 'sequences.read', { alias: 's', startParamIndex: 1 });
    const res = await this.db.query(
      `SELECT s.*,
              u.name AS owner_name,
              (SELECT COUNT(*)::int FROM sequence_steps st WHERE st.sequence_id = s.id) AS step_count,
              (SELECT COUNT(*)::int FROM sequence_enrollments se WHERE se.sequence_id = s.id) AS enrolled_count,
              (SELECT COUNT(*)::int FROM sequence_enrollments se WHERE se.sequence_id = s.id AND se.status = 'active') AS active_enrollments,
              (SELECT COUNT(*)::int FROM sequence_enrollments se WHERE se.sequence_id = s.id AND se.status = 'replied') AS replied_count,
              (SELECT COUNT(*)::int FROM sequence_enrollments se WHERE se.sequence_id = s.id AND se.status = 'bounced') AS bounced_count,
              (SELECT COUNT(*)::int FROM sequence_enrollments se WHERE se.sequence_id = s.id AND se.status = 'unsubscribed') AS unsubscribed_count,
              (SELECT COUNT(*)::int FROM sequence_enrollments se WHERE se.sequence_id = s.id AND se.status = 'stopped_meeting') AS meetings_count,
              (SELECT COUNT(*)::int FROM message_sends ms
               JOIN sequence_enrollments se ON se.id = ms.sequence_enrollment_id
               WHERE se.sequence_id = s.id) AS sent_count
       FROM sequences s
       LEFT JOIN users u ON u.id = s.owner_user_id
       WHERE ${scope.sql}
       ORDER BY s.created_at DESC`,
      scope.params,
    );
    return res.rows;
  }

  async getSequenceDetail(user: SessionUser, sequenceId: string): Promise<Record<string, unknown>> {
    const scope = scopeWhere(user, 'sequences.read', { alias: 's', startParamIndex: 2 });
    const seqRes = await this.db.query<Record<string, unknown>>(
      `SELECT s.*, u.name AS owner_name
       FROM sequences s
       LEFT JOIN users u ON u.id = s.owner_user_id
       WHERE s.id = $1 AND (${scope.sql})
       LIMIT 1`,
      [sequenceId, ...scope.params],
    );
    const seq = seqRes.rows[0];
    if (!seq) throw new NotFoundDomainError('Sequence', sequenceId);

    const [stepsRes, enrollmentsRes, metricsRes] = await Promise.all([
      this.db.query<Record<string, unknown> & { id: string; step_order: number }>(
        `SELECT st.*,
                (SELECT COUNT(*)::int FROM message_sends ms
                 JOIN sequence_enrollments se ON se.id = ms.sequence_enrollment_id
                 WHERE se.sequence_id = st.sequence_id
                   AND (ms.sequence_step_id = st.id OR ms.idempotency_key LIKE ('%\\_step\\_' || st.step_order::text))) AS sent_count,
                (SELECT COUNT(*)::int FROM sequence_enrollments se
                 WHERE se.sequence_id = st.sequence_id
                   AND se.status = 'replied'
                   AND se.current_step_order = st.step_order) AS replied_count,
                (SELECT COUNT(*)::int FROM sequence_enrollments se
                 WHERE se.sequence_id = st.sequence_id
                   AND se.status = 'bounced'
                   AND se.current_step_order = st.step_order) AS bounced_count
         FROM sequence_steps st
         WHERE st.sequence_id = $1
         ORDER BY st.step_order ASC`,
        [sequenceId],
      ),
      this.db.query<Record<string, unknown>>(
        `SELECT se.*, c.full_name AS contact_name, c.title AS contact_title,
                c.market AS contact_market, c.timezone AS contact_timezone,
                cmp.name AS company_name, u.name AS sender_name
         FROM sequence_enrollments se
         JOIN contacts c ON c.id = se.contact_id
         LEFT JOIN companies cmp ON cmp.id = c.company_id
         LEFT JOIN users u ON u.id = se.sender_user_id
         WHERE se.sequence_id = $1
         ORDER BY se.enrolled_at DESC
         LIMIT 200`,
        [sequenceId],
      ),
      this.db.query<{
        enrolled_count: number;
        active_count: number;
        paused_count: number;
        completed_count: number;
        replied_count: number;
        bounced_count: number;
        unsubscribed_count: number;
        meetings_count: number;
        sent_count: number;
      }>(
        `SELECT
           COUNT(*)::int AS enrolled_count,
           COUNT(*) FILTER (WHERE status = 'active')::int AS active_count,
           COUNT(*) FILTER (WHERE status = 'paused')::int AS paused_count,
           COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_count,
           COUNT(*) FILTER (WHERE status = 'replied')::int AS replied_count,
           COUNT(*) FILTER (WHERE status = 'bounced')::int AS bounced_count,
           COUNT(*) FILTER (WHERE status = 'unsubscribed')::int AS unsubscribed_count,
           COUNT(*) FILTER (WHERE status = 'stopped_meeting')::int AS meetings_count,
           (SELECT COUNT(*)::int FROM message_sends ms
            JOIN sequence_enrollments se2 ON se2.id = ms.sequence_enrollment_id
            WHERE se2.sequence_id = $1) AS sent_count
         FROM sequence_enrollments
         WHERE sequence_id = $1`,
        [sequenceId],
      ),
    ]);

    const steps = stepsRes.rows.map((st) => {
      const sentCount = Number(st['sent_count'] ?? 0);
      const repliedCount = Number(st['replied_count'] ?? 0);
      const replyRatePct =
        sentCount > 0 ? Number(((repliedCount / sentCount) * 100).toFixed(1)) : 0;
      return { ...st, replyRatePct };
    });

    const m = metricsRes.rows[0] ?? {
      enrolled_count: 0,
      active_count: 0,
      paused_count: 0,
      completed_count: 0,
      replied_count: 0,
      bounced_count: 0,
      unsubscribed_count: 0,
      meetings_count: 0,
      sent_count: 0,
    };

    return {
      sequence: seq,
      steps,
      enrollments: enrollmentsRes.rows,
      metrics: {
        enrolledCount: m.enrolled_count,
        activeCount: m.active_count,
        pausedCount: m.paused_count,
        completedCount: m.completed_count,
        sentCount: m.sent_count,
        repliedCount: m.replied_count,
        bouncedCount: m.bounced_count,
        unsubscribedCount: m.unsubscribed_count,
        meetingsCount: m.meetings_count,
        replyRatePct:
          m.enrolled_count > 0
            ? Number(((m.replied_count / m.enrolled_count) * 100).toFixed(1))
            : 0,
      },
    };
  }

  async createSequence(
    user: SessionUser,
    rawInput: CreateSequenceInput,
  ): Promise<Record<string, unknown>> {
    requireCapability(user, 'sequences.write');
    const input = CreateSequenceInputSchema.parse(rawInput);

    // PRD 4.12: default 50 per mailbox per day; only Admin can raise it above 50 up to 150.
    if (input.dailyCapPerMailbox > 50 && user.role !== 'Admin') {
      throw new DomainError({
        status: 403,
        code: 'MAILBOX_CAP_ADMIN_ONLY',
        title: 'Daily mailbox cap above 50 requires Admin approval',
        detail: 'Ask an Admin to raise a sequence daily mailbox cap above 50 sends per day.',
      });
    }

    const id = `seq_${randomUUID()}`;
    return this.db.transaction(async (tx) => {
      const inserted = await tx.query(
        `INSERT INTO sequences (
           id, name, description, market, status, shared, daily_cap_per_mailbox,
           send_window_start_minutes, send_window_end_minutes, stop_on_company_reply,
           click_tracking_enabled, owner_user_id, team_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING *`,
        [
          id,
          input.name.trim(),
          input.description ?? null,
          input.market,
          input.status,
          input.shared,
          input.dailyCapPerMailbox,
          input.sendWindowStartMinutes,
          input.sendWindowEndMinutes,
          input.stopOnCompanyReply,
          input.clickTrackingEnabled,
          user.id,
          user.teamId ?? 'team_us',
        ],
      );

      for (const step of input.steps) {
        let subjectTpl = step.subjectTemplate;
        let bodyTpl = step.bodyTemplate;
        if (step.templateId && (!subjectTpl || !bodyTpl)) {
          const tplRes = await tx.query<{ subject: string; body_text: string }>(
            `SELECT subject, body_text FROM templates WHERE id = $1 LIMIT 1`,
            [step.templateId],
          );
          if (tplRes.rows[0]) {
            subjectTpl = subjectTpl || tplRes.rows[0].subject;
            bodyTpl = bodyTpl || tplRes.rows[0].body_text;
          }
        }

        await tx.query(
          `INSERT INTO sequence_steps (
             id, sequence_id, step_order, step_kind, delay_business_days,
             subject_template, body_template, reply_in_thread, task_type, task_title, template_id
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            `stp_${randomUUID()}`,
            id,
            step.stepOrder,
            step.stepKind,
            step.delayBusinessDays,
            subjectTpl,
            bodyTpl,
            step.replyInThread,
            step.taskType,
            step.taskTitle ?? null,
            step.templateId ?? null,
          ],
        );
      }

      await this.db.writeAuditLog(tx, {
        actorUserId: user.id,
        actorEmail: user.email,
        action: 'sequence.created',
        entityType: 'sequence',
        entityId: id,
        metadata: { market: input.market, stepCount: input.steps.length },
      });

      return inserted.rows[0] ?? { id };
    });
  }

  async updateSequence(
    user: SessionUser,
    sequenceId: string,
    rawInput: UpdateSequenceInput,
  ): Promise<Record<string, unknown>> {
    const scope = scopeWhere(user, 'sequences.write', { alias: 's', startParamIndex: 2 });
    const input = UpdateSequenceInputSchema.parse(rawInput);

    if (input.dailyCapPerMailbox && input.dailyCapPerMailbox > 50 && user.role !== 'Admin') {
      throw new DomainError({
        status: 403,
        code: 'MAILBOX_CAP_ADMIN_ONLY',
        title: 'Daily mailbox cap above 50 requires Admin approval',
        detail: 'Ask an Admin to raise a sequence daily mailbox cap above 50 sends per day.',
      });
    }

    return this.db.transaction(async (tx) => {
      const existing = await tx.query<{ id: string; version: number }>(
        `SELECT s.id, s.version FROM sequences s WHERE s.id = $1 AND (${scope.sql}) FOR UPDATE`,
        [sequenceId, ...scope.params],
      );
      if (!existing.rows[0]) throw new NotFoundDomainError('Sequence', sequenceId);
      if (existing.rows[0].version !== input.version) {
        throw new VersionConflictError('Sequence', sequenceId);
      }

      const updated = await tx.query(
        `UPDATE sequences
         SET name = COALESCE($2, name),
             description = CASE WHEN $3::boolean THEN $4 ELSE description END,
             market = COALESCE($5, market),
             status = COALESCE($6, status),
             shared = COALESCE($7, shared),
             daily_cap_per_mailbox = COALESCE($8, daily_cap_per_mailbox),
             send_window_start_minutes = COALESCE($9, send_window_start_minutes),
             send_window_end_minutes = COALESCE($10, send_window_end_minutes),
             stop_on_company_reply = COALESCE($11, stop_on_company_reply),
             click_tracking_enabled = COALESCE($12, click_tracking_enabled),
             version = version + 1,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [
          sequenceId,
          input.name ?? null,
          input.description !== undefined,
          input.description ?? null,
          input.market ?? null,
          input.status ?? null,
          input.shared ?? null,
          input.dailyCapPerMailbox ?? null,
          input.sendWindowStartMinutes ?? null,
          input.sendWindowEndMinutes ?? null,
          input.stopOnCompanyReply ?? null,
          input.clickTrackingEnabled ?? null,
        ],
      );

      if (input.steps) {
        await tx.query(`DELETE FROM sequence_steps WHERE sequence_id = $1`, [sequenceId]);
        for (const step of input.steps) {
          await tx.query(
            `INSERT INTO sequence_steps (
               id, sequence_id, step_order, step_kind, delay_business_days,
               subject_template, body_template, reply_in_thread, task_type, task_title, template_id
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
              `stp_${randomUUID()}`,
              sequenceId,
              step.stepOrder,
              step.stepKind,
              step.delayBusinessDays,
              step.subjectTemplate,
              step.bodyTemplate,
              step.replyInThread,
              step.taskType,
              step.taskTitle ?? null,
              step.templateId ?? null,
            ],
          );
        }
      }

      return updated.rows[0] ?? { id: sequenceId };
    });
  }

  async enrollInSequence(
    user: SessionUser,
    rawInput: EnrollSequenceInput,
  ): Promise<{
    enrollmentId: string;
    status: string;
    nextSendAt: string;
  }> {
    requireCapability(user, 'sequences.enroll');
    const input = EnrollSequenceInputSchema.parse(rawInput);

    const [contactRes, seqRes] = await Promise.all([
      this.db.query<{
        id: string;
        primary_email: string;
        market: Market;
        timezone: string;
      }>(
        `SELECT id, primary_email, market, timezone FROM contacts WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
        [input.contactId],
      ),
      this.db.query<{
        id: string;
        status: string;
        send_window_start_minutes: number;
        send_window_end_minutes: number;
      }>(
        `SELECT id, status, send_window_start_minutes, send_window_end_minutes
         FROM sequences WHERE id = $1 LIMIT 1`,
        [input.sequenceId],
      ),
    ]);
    const contact = contactRes.rows[0];
    if (!contact) {
      throw new NotFoundDomainError('Contact', input.contactId);
    }
    const sequence = seqRes.rows[0];
    if (!sequence) {
      throw new NotFoundDomainError('Sequence', input.sequenceId);
    }
    if (sequence.status !== 'active') {
      throw new DomainError({
        status: 422,
        code: 'SEQUENCE_INACTIVE',
        title: 'Sequence is not active',
        detail: 'Activate the sequence before enrolling contacts.',
      });
    }

    const senderUserId = input.senderUserId ?? user.id;
    const check = await this.compliance.evaluateRecipientSendability({
      email: contact.primary_email,
      channel: 'sequence',
      senderUserId,
      sequenceId: sequence.id,
      bypassSendWindow: true,
    });

    if (!check.sendable) {
      throw new DomainError({
        status: 422,
        code: check.reasonCode,
        title: 'Recipient ineligible for sequence enrollment',
        detail: check.reasonMessage,
      });
    }

    // PRD §5.6 & A17: only one active sequence per contact across all sequences.
    const activeRes = await this.db.query<{ id: string; sequence_id: string }>(
      `SELECT id, sequence_id FROM sequence_enrollments
       WHERE contact_id = $1 AND status IN ('active', 'paused')
       LIMIT 1`,
      [contact.id],
    );
    if (activeRes.rows[0]) {
      throw new DomainError({
        status: 409,
        code: 'IN_OTHER_ACTIVE_SEQUENCE',
        title: 'Contact is already in an active sequence',
        detail: 'Stop or finish the contact’s current sequence before enrolling them in another.',
      });
    }

    const mbxRes = await this.db.query<{ id: string }>(
      `SELECT id FROM mailbox_connections WHERE user_id = $1 LIMIT 1`,
      [senderUserId],
    );

    const enrollmentId = `enr_${randomUUID()}`;
    const firstStepRes = await this.db.query<{ step_order: number; delay_business_days: number }>(
      `SELECT step_order, delay_business_days FROM sequence_steps WHERE sequence_id = $1 ORDER BY step_order ASC LIMIT 1`,
      [sequence.id],
    );
    const firstStepOrder = firstStepRes.rows[0]?.step_order ?? 1;
    const firstStepDelay = firstStepRes.rows[0]?.delay_business_days ?? 0;

    const baseDate = addBusinessDays(new Date(), firstStepDelay, contact.timezone, contact.market);
    const nextSendDate = nextSendWindowStart(baseDate, contact.timezone, contact.market, {
      windowStartMinutes: sequence.send_window_start_minutes,
      windowEndMinutes: sequence.send_window_end_minutes,
    });

    try {
      await this.db.transaction(async (tx) => {
        await tx.query(`SELECT id FROM contacts WHERE id = $1 FOR UPDATE`, [contact.id]);
        const lockedActive = await tx.query<{ id: string }>(
          `SELECT id FROM sequence_enrollments
           WHERE contact_id = $1 AND status IN ('active', 'paused')
           LIMIT 1`,
          [contact.id],
        );
        if (lockedActive.rows[0]) {
          throw new DomainError({
            status: 409,
            code: 'IN_OTHER_ACTIVE_SEQUENCE',
            title: 'Contact is already in an active sequence',
            detail:
              'Stop or finish the contact’s current sequence before enrolling them in another.',
          });
        }

        await tx.query(
          `INSERT INTO sequence_enrollments (
             id, sequence_id, contact_id, email, sender_user_id, mailbox_connection_id,
             enrolled_by_user_id, current_step_order, status, next_send_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9)`,
          [
            enrollmentId,
            sequence.id,
            contact.id,
            contact.primary_email,
            senderUserId,
            mbxRes.rows[0]?.id ?? null,
            user.id,
            firstStepOrder,
            nextSendDate.toISOString(),
          ],
        );

        await this.db.addOutboxEvent(tx, {
          eventType: 'sequence.enrolled',
          aggregateType: 'sequence_enrollment',
          aggregateId: enrollmentId,
          payload: {
            enrollmentId,
            sequenceId: sequence.id,
            contactId: contact.id,
            senderUserId,
          },
        });
      });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new DomainError({
          status: 409,
          code: 'IN_OTHER_ACTIVE_SEQUENCE',
          title: 'Contact is already in an active sequence',
          detail: 'Stop or finish the contact’s current sequence before enrolling them in another.',
        });
      }
      throw err;
    }

    return {
      enrollmentId,
      status: 'active',
      nextSendAt: nextSendDate.toISOString(),
    };
  }

  /**
   * Enrolls multiple contacts from a view, list, or sequence drawer, skipping ineligible contacts
   * with explicit reason codes so the UI displays every skip transparently (PRD 4.12, A16, A17).
   */
  async batchEnrollInSequence(
    user: SessionUser,
    sequenceId: string,
    rawInput: BatchEnrollSequenceInput,
  ): Promise<{
    enrolled: Array<{ contactId: string; enrollmentId: string; nextSendAt: string }>;
    skipped: Array<{ contactId: string; reasonCode: string; reasonMessage: string }>;
  }> {
    requireCapability(user, 'sequences.enroll');
    const input = BatchEnrollSequenceInputSchema.parse(rawInput);
    const contactScope = scopeWhere(user, 'contacts.read', { alias: 'c', startParamIndex: 2 });

    const enrolled: Array<{ contactId: string; enrollmentId: string; nextSendAt: string }> = [];
    const skipped: Array<{ contactId: string; reasonCode: string; reasonMessage: string }> = [];

    for (const contactId of [...new Set(input.contactIds)]) {
      const visible = await this.db.query<{ id: string }>(
        `SELECT c.id FROM contacts c WHERE c.id = $1 AND c.deleted_at IS NULL AND (${contactScope.sql}) LIMIT 1`,
        [contactId, ...contactScope.params],
      );
      if (!visible.rows[0]) {
        skipped.push({
          contactId,
          reasonCode: 'OUT_OF_SCOPE',
          reasonMessage: 'Contact is outside your access scope.',
        });
        continue;
      }

      try {
        const res = await this.enrollInSequence(user, {
          sequenceId,
          contactId,
          senderUserId: input.senderUserId,
        });
        enrolled.push({
          contactId,
          enrollmentId: res.enrollmentId,
          nextSendAt: res.nextSendAt,
        });
      } catch (err) {
        if (err instanceof DomainError) {
          skipped.push({
            contactId,
            reasonCode: err.code,
            reasonMessage: err.message,
          });
        } else {
          throw err;
        }
      }
    }

    return { enrolled, skipped };
  }

  async updateEnrollmentState(
    user: SessionUser,
    enrollmentId: string,
    rawInput: EnrollmentStateActionInput,
  ): Promise<Record<string, unknown>> {
    requireCapability(user, 'sequences.enroll');
    const input = EnrollmentStateActionInputSchema.parse(rawInput);

    return this.db.transaction(async (tx) => {
      const enrRes = await tx.query<{
        id: string;
        sequence_id: string;
        contact_id: string;
        sender_user_id: string;
        status: string;
        timezone: string;
        market: Market;
      }>(
        `SELECT se.id, se.sequence_id, se.contact_id, se.sender_user_id, se.status,
                c.timezone, c.market
         FROM sequence_enrollments se
         JOIN contacts c ON c.id = se.contact_id
         WHERE se.id = $1 FOR UPDATE`,
        [enrollmentId],
      );
      const enr = enrRes.rows[0];
      if (!enr) throw new NotFoundDomainError('SequenceEnrollment', enrollmentId);

      const scope = getCapabilityScope(user, 'sequences.enroll');
      if (scope === 'own' && enr.sender_user_id !== user.id) {
        throw new DomainError({
          status: 403,
          code: 'FORBIDDEN_SCOPE',
          title: 'Cannot modify another sender’s enrollment',
          detail: 'You can only manage sequence enrollments assigned to you.',
        });
      }
      if (
        scope === 'team' &&
        enr.sender_user_id !== user.id &&
        !user.teamMemberIds.includes(enr.sender_user_id)
      ) {
        throw new DomainError({
          status: 403,
          code: 'FORBIDDEN_SCOPE',
          title: 'Enrollment outside your team',
          detail: 'You can only manage sequence enrollments for your team.',
        });
      }

      if (input.action === 'pause') {
        const updated = await tx.query(
          `UPDATE sequence_enrollments
           SET status = 'paused', stop_reason = $2
           WHERE id = $1 RETURNING *`,
          [enrollmentId, input.reason ?? 'Paused manually'],
        );
        return updated.rows[0] ?? { id: enrollmentId };
      }

      if (input.action === 'resume') {
        const nextWindow = nextSendWindowStart(new Date(), enr.timezone, enr.market);
        const updated = await tx.query(
          `UPDATE sequence_enrollments
           SET status = 'active', stop_reason = NULL, next_send_at = $2
           WHERE id = $1 RETURNING *`,
          [enrollmentId, nextWindow.toISOString()],
        );
        return updated.rows[0] ?? { id: enrollmentId };
      }

      const updated = await tx.query(
        `UPDATE sequence_enrollments
         SET status = 'stopped_manual',
             stop_reason = $2,
             next_send_at = NULL,
             stopped_at = NOW()
         WHERE id = $1 RETURNING *`,
        [enrollmentId, input.reason ?? 'Removed manually'],
      );
      await this.db.addOutboxEvent(tx, {
        eventType: 'sequence.stopped',
        aggregateType: 'sequence_enrollment',
        aggregateId: enrollmentId,
        payload: { enrollmentId, reason: input.reason ?? 'Removed manually' },
      });
      return updated.rows[0] ?? { id: enrollmentId };
    });
  }

  async executeSequenceEnrollmentStep(
    enrollmentId: string,
    options: { bypassSendWindow?: boolean; now?: Date; jitterMinutes?: number } = {},
  ): Promise<SendMessageJobResult & { taskCreatedId?: string | null; nextSendAt?: string | null }> {
    const now = options.now ?? new Date();
    const enrRes = await this.db.query<{
      id: string;
      sequence_id: string;
      contact_id: string;
      email: string;
      sender_user_id: string;
      current_step_order: number;
      status: string;
      first_name: string;
      last_name: string;
      full_name: string;
      market: Market;
      timezone: string;
      company_id: string | null;
      company_name: string | null;
      accounting_software: string[] | null;
      sender_name: string | null;
      sender_email: string | null;
      seq_status: string;
      daily_cap_per_mailbox: number;
      send_window_start_minutes: number;
      send_window_end_minutes: number;
      click_tracking_enabled: boolean;
    }>(
      `SELECT se.*,
              c.first_name, c.last_name, c.full_name, c.market, c.timezone, c.company_id,
              cmp.name AS company_name, cmp.accounting_software,
              u.name AS sender_name, u.email AS sender_email,
              s.status AS seq_status, s.daily_cap_per_mailbox,
              s.send_window_start_minutes, s.send_window_end_minutes, s.click_tracking_enabled
       FROM sequence_enrollments se
       JOIN contacts c ON c.id = se.contact_id
       JOIN sequences s ON s.id = se.sequence_id
       LEFT JOIN companies cmp ON cmp.id = c.company_id
       LEFT JOIN users u ON u.id = se.sender_user_id
       WHERE se.id = $1
       LIMIT 1`,
      [enrollmentId],
    );
    const enrollment = enrRes.rows[0];
    if (!enrollment) {
      throw new NotFoundDomainError('SequenceEnrollment', enrollmentId);
    }

    if (enrollment.status !== 'active') {
      const preCheck = await this.compliance.evaluateRecipientSendability({
        email: enrollment.email,
        channel: 'sequence',
        senderUserId: enrollment.sender_user_id,
        sequenceId: enrollment.sequence_id,
        bypassSendWindow: options.bypassSendWindow ?? true,
        now,
      });
      if (!preCheck.sendable) {
        return {
          sent: false,
          deduplicated: false,
          reasonCode: preCheck.reasonCode,
          reasonMessage: preCheck.reasonMessage,
          messageSendId: null,
          providerMessageId: null,
        };
      }
      return {
        sent: false,
        deduplicated: false,
        reasonCode: 'SEQUENCE_INACTIVE',
        reasonMessage: `Enrollment status is ${enrollment.status}`,
        messageSendId: null,
        providerMessageId: null,
      };
    }

    const stepRes = await this.db.query<{
      id: string;
      step_order: number;
      step_kind: 'email' | 'task';
      delay_business_days: number;
      subject_template: string;
      body_template: string;
      reply_in_thread: boolean;
      task_type: string;
      task_title: string | null;
    }>(
      `SELECT id, step_order, step_kind, delay_business_days, subject_template, body_template,
              reply_in_thread, task_type, task_title
       FROM sequence_steps
       WHERE sequence_id = $1 AND step_order = $2
       LIMIT 1`,
      [enrollment.sequence_id, enrollment.current_step_order],
    );
    const step = stepRes.rows[0];
    if (!step) {
      throw new NotFoundDomainError('SequenceStep', String(enrollment.current_step_order));
    }

    const advanceOrCompleteEnrollment = async (lastSentAt: Date | null): Promise<string | null> => {
      const nextStepRes = await this.db.query<{ step_order: number; delay_business_days: number }>(
        `SELECT step_order, delay_business_days
         FROM sequence_steps
         WHERE sequence_id = $1 AND step_order > $2
         ORDER BY step_order ASC
         LIMIT 1`,
        [enrollment.sequence_id, step.step_order],
      );
      const nextStep = nextStepRes.rows[0];
      if (nextStep) {
        const afterBusinessDays = addBusinessDays(
          now,
          nextStep.delay_business_days,
          enrollment.timezone,
          enrollment.market,
        );
        const jitter =
          options.jitterMinutes ??
          deterministicJitterMinutes(`${enrollment.id}:${nextStep.step_order}`, 15);
        const scheduledAt = nextSendWindowStart(
          afterBusinessDays,
          enrollment.timezone,
          enrollment.market,
          {
            windowStartMinutes: enrollment.send_window_start_minutes,
            windowEndMinutes: enrollment.send_window_end_minutes,
            jitterMinutes: jitter,
          },
        );
        await this.db.query(
          `UPDATE sequence_enrollments
           SET current_step_order = $2,
               next_send_at = $3::timestamptz,
               last_step_sent_at = COALESCE($4::timestamptz, last_step_sent_at),
               last_skip_reason = NULL
           WHERE id = $1`,
          [
            enrollment.id,
            nextStep.step_order,
            scheduledAt.toISOString(),
            lastSentAt ? lastSentAt.toISOString() : null,
          ],
        );
        return scheduledAt.toISOString();
      }

      await this.db.query(
        `UPDATE sequence_enrollments
         SET status = 'completed',
             next_send_at = NULL,
             last_step_sent_at = COALESCE($2::timestamptz, last_step_sent_at),
             last_skip_reason = NULL,
             completed_at = NOW()
         WHERE id = $1`,
        [enrollment.id, lastSentAt ? lastSentAt.toISOString() : null],
      );
      return null;
    };

    // Task step (`PRD 4.12`: call, LinkedIn research, follow-up — manual action, never scrapes LinkedIn)
    if (step.step_kind === 'task') {
      const taskId = `tsk_seq_${randomUUID()}`;
      const title = renderEmailTemplate(
        step.task_title ||
          `${step.task_type === 'research' ? 'LinkedIn research' : 'Sequence call'}: ${enrollment.full_name}`,
        {
          'contact.first_name': enrollment.first_name,
          first_name: enrollment.first_name,
          'company.name': enrollment.company_name ?? 'prospect firm',
          company_name: enrollment.company_name ?? 'prospect firm',
        },
      );
      await this.db.query(
        `INSERT INTO tasks (
           id, title, task_type, priority, status, due_at,
           assignee_user_id, company_id, contact_id, created_by_user_id
         ) VALUES ($1, $2, $3, 'normal', 'open', $4::timestamptz + INTERVAL '4 hours', $5, $6, $7, $5)`,
        [
          taskId,
          title,
          step.task_type || 'call',
          now.toISOString(),
          enrollment.sender_user_id,
          enrollment.company_id,
          enrollment.contact_id,
        ],
      );
      const nextSendAt = await advanceOrCompleteEnrollment(null);
      return {
        sent: true,
        deduplicated: false,
        reasonCode: 'OK',
        reasonMessage: 'Sequence task step created.',
        messageSendId: null,
        providerMessageId: null,
        taskCreatedId: taskId,
        nextSendAt,
      };
    }

    const softwareText = Array.isArray(enrollment.accounting_software)
      ? enrollment.accounting_software.join(', ')
      : '';
    const vars: Record<string, string> = {
      'contact.first_name': enrollment.first_name,
      'contact.last_name': enrollment.last_name,
      'contact.full_name': enrollment.full_name,
      first_name: enrollment.first_name,
      last_name: enrollment.last_name,
      'company.name': enrollment.company_name ?? 'your firm',
      company_name: enrollment.company_name ?? 'your firm',
      'company.software': softwareText || 'your accounting stack',
      sender_name: enrollment.sender_name ?? 'ADAS Globus Pro',
    };

    let subject = renderEmailTemplate(step.subject_template, vars);
    if (step.reply_in_thread && step.step_order > 1 && !/^re:/i.test(subject)) {
      subject = `Re: ${subject}`;
    }
    const bodyText = renderEmailTemplate(step.body_template, vars);

    const sendResult = await this.executeSendMessageJob({
      idempotencyKey: `seq_${enrollment.id}_step_${step.step_order}`,
      channel: 'sequence',
      recipientEmail: enrollment.email,
      contactId: enrollment.contact_id,
      senderUserId: enrollment.sender_user_id,
      sequenceId: enrollment.sequence_id,
      sequenceEnrollmentId: enrollment.id,
      sequenceStepId: step.id,
      subject,
      bodyText,
      clickTrackingEnabled: enrollment.click_tracking_enabled,
      mailboxDailyCapOverride: enrollment.daily_cap_per_mailbox,
      sendWindowStartMinutes: enrollment.send_window_start_minutes,
      sendWindowEndMinutes: enrollment.send_window_end_minutes,
      bypassSendWindow: options.bypassSendWindow ?? true,
      now,
    });

    if (sendResult.sent) {
      if (sendResult.providerMessageId && !sendResult.deduplicated) {
        await this.syncMailboxMessage({
          providerMessageId: sendResult.providerMessageId,
          direction: 'outbound',
          fromEmail: enrollment.sender_email ?? 'outreach@adasglobuspro.example.com',
          toEmails: [enrollment.email],
          subject,
          bodyText,
          mailboxOwnerUserId: enrollment.sender_user_id,
        });
      }
      const nextSendAt = await advanceOrCompleteEnrollment(now);
      return { ...sendResult, nextSendAt };
    }

    // Rollover vs terminal compliance stop (PRD 8.3 & A18)
    if (
      sendResult.reasonCode === 'MAILBOX_DAILY_CAP' ||
      sendResult.reasonCode === 'OUTSIDE_SEND_WINDOW' ||
      sendResult.reasonCode === 'FREQUENCY_CAP'
    ) {
      const jitter =
        options.jitterMinutes ??
        deterministicJitterMinutes(`${enrollment.id}:roll:${step.step_order}`, 15);
      const nextWindow = nextSendWindowStart(now, enrollment.timezone, enrollment.market, {
        windowStartMinutes: enrollment.send_window_start_minutes,
        windowEndMinutes: enrollment.send_window_end_minutes,
        forceNextBusinessDay:
          sendResult.reasonCode === 'MAILBOX_DAILY_CAP' ||
          sendResult.reasonCode === 'FREQUENCY_CAP',
        jitterMinutes: jitter,
      });
      await this.db.query(
        `UPDATE sequence_enrollments
         SET next_send_at = $2::timestamptz,
             last_skip_reason = $3
         WHERE id = $1`,
        [enrollment.id, nextWindow.toISOString(), sendResult.reasonCode],
      );
      return { ...sendResult, nextSendAt: nextWindow.toISOString() };
    }

    if (TERMINAL_SKIP_CODES.has(sendResult.reasonCode)) {
      await this.db.query(
        `UPDATE sequence_enrollments
         SET status = 'stopped_suppressed',
             stop_reason = $2,
             last_skip_reason = $2,
             next_send_at = NULL,
             stopped_at = NOW()
         WHERE id = $1`,
        [enrollment.id, sendResult.reasonCode],
      );
    }

    return sendResult;
  }

  /**
   * Worker job `sequence.tick` (every minute — PRD 6.9, 8.3):
   * Finds due active enrollments and executes them inside recipient local send windows and mailbox caps.
   */
  async runSequenceTick(
    options: { now?: Date; limit?: number; jitterMinutes?: number } = {},
  ): Promise<{
    checked: number;
    sent: number;
    tasksCreated: number;
    rolledToNextWindow: number;
    stoppedCompliance: number;
  }> {
    const now = options.now ?? new Date();
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 250);

    const dueRes = await this.db.query<{ id: string }>(
      `SELECT se.id
       FROM sequence_enrollments se
       JOIN sequences s ON s.id = se.sequence_id
       WHERE se.status = 'active'
         AND s.status = 'active'
         AND se.next_send_at IS NOT NULL
         AND se.next_send_at <= $1::timestamptz
       ORDER BY se.next_send_at ASC
       LIMIT $2`,
      [now.toISOString(), limit],
    );

    let sent = 0;
    let tasksCreated = 0;
    let rolledToNextWindow = 0;
    let stoppedCompliance = 0;

    for (const row of dueRes.rows) {
      const res = await this.executeSequenceEnrollmentStep(row.id, {
        bypassSendWindow: false,
        now,
        jitterMinutes: options.jitterMinutes,
      });
      if (res.taskCreatedId) {
        tasksCreated += 1;
      } else if (res.sent) {
        sent += 1;
      } else if (
        res.reasonCode === 'MAILBOX_DAILY_CAP' ||
        res.reasonCode === 'OUTSIDE_SEND_WINDOW' ||
        res.reasonCode === 'FREQUENCY_CAP'
      ) {
        rolledToNextWindow += 1;
      } else if (TERMINAL_SKIP_CODES.has(res.reasonCode)) {
        stoppedCompliance += 1;
      }
    }

    return {
      checked: dueRes.rows.length,
      sent,
      tasksCreated,
      rolledToNextWindow,
      stoppedCompliance,
    };
  }

  /**
   * Outbox event handler stopping active sequence enrollments when a deal is created/won or a
   * meeting is logged for the contact (PRD 4.12 stop conditions).
   */
  async handleOutboxStopCondition(event: OutboxEvent, tx: DbTx): Promise<void> {
    if (event.eventType === 'deal.created' || event.eventType === 'deal.won') {
      const dealId = event.aggregateId;
      const dealRes = await tx.query<{ primary_contact_id: string | null }>(
        `SELECT primary_contact_id FROM deals WHERE id = $1 LIMIT 1`,
        [dealId],
      );
      const contactId =
        (typeof event.payload['contactId'] === 'string' ? event.payload['contactId'] : null) ??
        dealRes.rows[0]?.primary_contact_id ??
        null;
      if (contactId) {
        await tx.query(
          `UPDATE sequence_enrollments
           SET status = 'stopped_deal_won',
               stop_reason = $2,
               next_send_at = NULL,
               stopped_at = NOW()
           WHERE contact_id = $1 AND status IN ('active', 'paused')`,
          [contactId, event.eventType === 'deal.won' ? 'Deal won' : 'Deal created for contact'],
        );
      }
      return;
    }

    if (
      event.eventType === 'activity.logged' &&
      (event.payload['activityType'] === 'meeting' ||
        event.payload['activityType'] === 'meeting_booked')
    ) {
      let contactId =
        typeof event.payload['contactId'] === 'string'
          ? event.payload['contactId']
          : event.aggregateType === 'contact'
            ? event.aggregateId
            : null;
      if (!contactId && typeof event.payload['activityId'] === 'string') {
        const actRes = await tx.query<{ contact_id: string | null }>(
          `SELECT contact_id FROM activities WHERE id = $1 LIMIT 1`,
          [event.payload['activityId']],
        );
        contactId = actRes.rows[0]?.contact_id ?? null;
      }
      if (contactId) {
        await tx.query(
          `UPDATE sequence_enrollments
           SET status = 'stopped_meeting',
               stop_reason = 'Meeting booked with contact',
               next_send_at = NULL,
               stopped_at = NOW()
           WHERE contact_id = $1 AND status IN ('active', 'paused')`,
          [contactId],
        );
      }
    }
  }

  async handleHardBounce(
    email: string,
    diagnostic = '550 5.1.1 User unknown',
  ): Promise<{
    suppressed: boolean;
    stoppedEnrollments: number;
  }> {
    const cleanEmail = normalizeEmail(email);
    if (cleanEmail) {
      await this.db.query(
        `UPDATE contact_emails SET verification_status = 'invalid' WHERE email = $1`,
        [cleanEmail],
      );
      await this.db.query(
        `UPDATE contacts SET email_verification_status = 'invalid', hard_bounced_at = NOW()
         WHERE primary_email = $1 AND deleted_at IS NULL`,
        [cleanEmail],
      );
    }
    const res = await this.compliance.addSuppression({
      email,
      reason: 'hard_bounce',
      source: 'transport_bounce_webhook',
      notes: diagnostic,
    });
    return {
      suppressed: true,
      stoppedEnrollments: res.stoppedEnrollments,
    };
  }

  // -------------------------------------------------------------------------
  // Segments, Static Lists & Sender Identities (PRD §4.13, §5.4, §6.8)
  // -------------------------------------------------------------------------

  private async resolveSegmentOrListContacts(
    userId: string,
    options: {
      listId?: string | null;
      segmentFilterJson?: Record<string, unknown> | null;
      market?: Market;
    },
  ): Promise<
    Array<{
      id: string;
      full_name: string;
      first_name: string;
      primary_email: string;
      market: Market;
      timezone: string;
      email_verification_status: string;
      company_name: string | null;
    }>
  > {
    if (options.listId) {
      const listRes = await this.db.query<{
        id: string;
        list_type: 'static' | 'dynamic';
        market: Market;
        filter_json: Record<string, unknown>;
      }>(`SELECT id, list_type, market, filter_json FROM lists WHERE id = $1 LIMIT 1`, [
        options.listId,
      ]);
      const list = listRes.rows[0];
      if (!list) throw new NotFoundDomainError('MarketingList', options.listId);

      if (list.list_type === 'static') {
        const res = await this.db.query<{
          id: string;
          full_name: string;
          first_name: string;
          primary_email: string;
          market: Market;
          timezone: string;
          email_verification_status: string;
          company_name: string | null;
        }>(
          `SELECT c.id, c.full_name, c.first_name, c.primary_email, c.market, c.timezone,
                  c.email_verification_status, cmp.name AS company_name
           FROM list_members lm
           JOIN contacts c ON c.id = lm.contact_id
           LEFT JOIN companies cmp ON cmp.id = c.company_id
           WHERE lm.list_id = $1 AND c.deleted_at IS NULL
           ORDER BY c.full_name ASC`,
          [list.id],
        );
        return res.rows;
      }

      return this.queryDynamicContacts(userId, list.filter_json, list.market);
    }

    if (options.segmentFilterJson && isNonEmptyFilter(options.segmentFilterJson)) {
      return this.queryDynamicContacts(userId, options.segmentFilterJson, options.market);
    }

    if (options.market) {
      return this.queryDynamicContacts(userId, {}, options.market);
    }

    return [];
  }

  private async queryDynamicContacts(
    userId: string,
    filterJson: Record<string, unknown>,
    market?: Market,
  ): Promise<
    Array<{
      id: string;
      full_name: string;
      first_name: string;
      primary_email: string;
      market: Market;
      timezone: string;
      email_verification_status: string;
      company_name: string | null;
    }>
  > {
    const params = new SqlParams();
    const where: string[] = ['c.deleted_at IS NULL'];
    if (market) {
      where.push(`c.market = ${params.add(market)}`);
    }
    if (isNonEmptyFilter(filterJson)) {
      where.push(
        compileFilter(filterJson, SEGMENT_CONTACT_REGISTRY, params, {
          userId,
          customFieldsSql: 'c.custom_fields',
        }),
      );
    }

    const res = await this.db.query<{
      id: string;
      full_name: string;
      first_name: string;
      primary_email: string;
      market: Market;
      timezone: string;
      email_verification_status: string;
      company_name: string | null;
    }>(
      `SELECT c.id, c.full_name, c.first_name, c.primary_email, c.market, c.timezone,
              c.email_verification_status, cmp.name AS company_name
       FROM contacts c
       LEFT JOIN companies cmp ON cmp.id = c.company_id
       WHERE ${where.join(' AND ')}
       ORDER BY c.full_name ASC
       LIMIT 5000`,
      params.values,
    );
    return res.rows;
  }

  async listMarketingLists(user: SessionUser): Promise<Record<string, unknown>[]> {
    const cmpgScope = getCapabilityScope(user, 'campaigns.read');
    if (cmpgScope === 'none') {
      requireCapability(user, 'sequences.read');
    }
    const res = await this.db.query<
      Record<string, unknown> & {
        id: string;
        list_type: 'static' | 'dynamic';
        market: Market;
        filter_json: Record<string, unknown>;
      }
    >(
      `SELECT l.*, u.name AS owner_name,
              (SELECT COUNT(*)::int FROM list_members lm
               JOIN contacts c ON c.id = lm.contact_id
               WHERE lm.list_id = l.id AND c.deleted_at IS NULL) AS static_count
       FROM lists l
       LEFT JOIN users u ON u.id = l.owner_user_id
       WHERE l.shared = TRUE OR l.owner_user_id = $1
       ORDER BY l.updated_at DESC, l.created_at DESC`,
      [user.id],
    );

    const out: Record<string, unknown>[] = [];
    for (const row of res.rows) {
      let resolvedCount = Number(row['static_count'] ?? row['member_count'] ?? 0);
      if (row.list_type === 'dynamic') {
        const dynamicRows = await this.queryDynamicContacts(user.id, row.filter_json, row.market);
        resolvedCount = dynamicRows.length;
      }
      out.push({ ...row, member_count: resolvedCount });
    }
    return out;
  }

  async getMarketingListDetail(
    user: SessionUser,
    listId: string,
  ): Promise<Record<string, unknown>> {
    const cmpgScope = getCapabilityScope(user, 'campaigns.read');
    if (cmpgScope === 'none') {
      requireCapability(user, 'sequences.read');
    }

    const listRes = await this.db.query<Record<string, unknown>>(
      `SELECT l.*, u.name AS owner_name
       FROM lists l
       LEFT JOIN users u ON u.id = l.owner_user_id
       WHERE l.id = $1
       LIMIT 1`,
      [listId],
    );
    const list = listRes.rows[0];
    if (!list) throw new NotFoundDomainError('MarketingList', listId);

    const members = await this.resolveSegmentOrListContacts(user.id, { listId });
    return {
      list: { ...list, member_count: members.length },
      members: members.slice(0, 200),
      totalCount: members.length,
    };
  }

  async createMarketingList(
    user: SessionUser,
    rawInput: CreateMarketingListInput,
  ): Promise<Record<string, unknown>> {
    requireCapability(user, 'campaigns.write');
    const input = CreateMarketingListInputSchema.parse(rawInput);

    if (input.listType === 'dynamic' && isNonEmptyFilter(input.filterJson)) {
      const p = new SqlParams();
      compileFilter(input.filterJson, SEGMENT_CONTACT_REGISTRY, p, {
        userId: user.id,
        customFieldsSql: 'c.custom_fields',
      });
    }

    const id = `lst_${randomUUID()}`;
    return this.db.transaction(async (tx) => {
      const inserted = await tx.query(
        `INSERT INTO lists (
           id, name, description, list_type, market, filter_json, member_count,
           shared, owner_user_id, team_id, version
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, 1)
         RETURNING *`,
        [
          id,
          input.name,
          input.description ?? null,
          input.listType,
          input.market,
          JSON.stringify(input.filterJson),
          input.contactIds.length,
          input.shared,
          user.id,
          user.teamId,
        ],
      );

      if (input.listType === 'static' && input.contactIds.length > 0) {
        for (const cid of [...new Set(input.contactIds)]) {
          await tx.query(
            `INSERT INTO list_members (list_id, contact_id, added_by_user_id)
             SELECT $1, id, $3 FROM contacts WHERE id = $2 AND deleted_at IS NULL
             ON CONFLICT DO NOTHING`,
            [id, cid, user.id],
          );
        }
      }

      return inserted.rows[0] ?? { id };
    });
  }

  async updateMarketingList(
    user: SessionUser,
    listId: string,
    rawInput: UpdateMarketingListInput,
  ): Promise<Record<string, unknown>> {
    requireCapability(user, 'campaigns.write');
    const input = UpdateMarketingListInputSchema.parse(rawInput);

    if (input.filterJson && isNonEmptyFilter(input.filterJson)) {
      const p = new SqlParams();
      compileFilter(input.filterJson, SEGMENT_CONTACT_REGISTRY, p, {
        userId: user.id,
        customFieldsSql: 'c.custom_fields',
      });
    }

    const updated = await this.db.query(
      `UPDATE lists
       SET name = COALESCE($3, name),
           description = CASE WHEN $4::boolean THEN $5 ELSE description END,
           market = COALESCE($6, market),
           filter_json = COALESCE($7::jsonb, filter_json),
           shared = COALESCE($8, shared),
           version = version + 1,
           updated_at = NOW()
       WHERE id = $1 AND version = $2
       RETURNING *`,
      [
        listId,
        input.version,
        input.name ?? null,
        input.description !== undefined,
        input.description ?? null,
        input.market ?? null,
        input.filterJson ? JSON.stringify(input.filterJson) : null,
        input.shared ?? null,
      ],
    );
    const row = updated.rows[0];
    if (!row) throw new VersionConflictError('MarketingList', listId);
    return row;
  }

  async addListMembers(
    user: SessionUser,
    listId: string,
    rawInput: ModifyListMembersInput,
  ): Promise<{ addedCount: number; memberCount: number }> {
    requireCapability(user, 'campaigns.write');
    const input = ModifyListMembersInputSchema.parse(rawInput);

    return this.db.transaction(async (tx) => {
      const listRes = await tx.query<{ id: string; list_type: string }>(
        `SELECT id, list_type FROM lists WHERE id = $1 LIMIT 1`,
        [listId],
      );
      const list = listRes.rows[0];
      if (!list) throw new NotFoundDomainError('MarketingList', listId);
      if (list.list_type !== 'static') {
        throw new ValidationDomainError(
          'Dynamic segments resolve members automatically from their filter.',
        );
      }

      let addedCount = 0;
      for (const cid of [...new Set(input.contactIds)]) {
        const ins = await tx.query(
          `INSERT INTO list_members (list_id, contact_id, added_by_user_id)
           SELECT $1, id, $3 FROM contacts WHERE id = $2 AND deleted_at IS NULL
           ON CONFLICT DO NOTHING`,
          [listId, cid, user.id],
        );
        addedCount += ins.rowCount;
      }

      const countRes = await tx.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM list_members WHERE list_id = $1`,
        [listId],
      );
      const memberCount = countRes.rows[0]?.n ?? 0;
      await tx.query(`UPDATE lists SET member_count = $2, updated_at = NOW() WHERE id = $1`, [
        listId,
        memberCount,
      ]);

      return { addedCount, memberCount };
    });
  }

  async removeListMember(
    user: SessionUser,
    listId: string,
    contactId: string,
  ): Promise<{ memberCount: number }> {
    requireCapability(user, 'campaigns.write');
    return this.db.transaction(async (tx) => {
      await tx.query(`DELETE FROM list_members WHERE list_id = $1 AND contact_id = $2`, [
        listId,
        contactId,
      ]);
      const countRes = await tx.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM list_members WHERE list_id = $1`,
        [listId],
      );
      const memberCount = countRes.rows[0]?.n ?? 0;
      await tx.query(`UPDATE lists SET member_count = $2, updated_at = NOW() WHERE id = $1`, [
        listId,
        memberCount,
      ]);
      return { memberCount };
    });
  }

  async listSenderIdentities(user: SessionUser): Promise<Record<string, unknown>[]> {
    const canRead =
      getCapabilityScope(user, 'campaigns.read') !== 'none' ||
      getCapabilityScope(user, 'settings.manage') !== 'none';
    if (!canRead) requireCapability(user, 'campaigns.read');

    const res = await this.db.query(`SELECT * FROM sender_identities ORDER BY created_at DESC`);
    return res.rows;
  }

  async createSenderIdentity(
    user: SessionUser,
    rawInput: CreateSenderIdentityInput,
  ): Promise<Record<string, unknown>> {
    if (
      getCapabilityScope(user, 'settings.manage') === 'none' &&
      getCapabilityScope(user, 'campaigns.approve') === 'none'
    ) {
      requireCapability(user, 'settings.manage');
    }
    const input = CreateSenderIdentityInputSchema.parse(rawInput);
    const domain = extractDomainFromEmail(input.fromEmail);
    if (!domain) {
      throw new ValidationDomainError('Enter a valid sender email address.', {
        fromEmail: ['Enter a valid sender email address.'],
      });
    }

    // PRD 5.4: Never send campaigns from the root employee domain (`adasglobuspro.com` / `adasglobuspro.example.com`)
    const parts = domain.split('.');
    if (
      parts.length < 3 ||
      domain === 'adasglobuspro.com' ||
      domain === 'adasglobuspro.example.com'
    ) {
      throw new ValidationDomainError(
        'Campaign sender identities must use a dedicated sending subdomain such as mail.adasglobuspro.com, never the root domain.',
        {
          fromEmail: ['Use a dedicated sending subdomain (e.g. briefings@mail.adasglobuspro.com).'],
        },
      );
    }

    const id = `snd_${randomUUID()}`;
    const res = await this.db.query(
      `INSERT INTO sender_identities (
         id, from_name, from_email, reply_to_email, domain, daily_warmup_cap, owner_user_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        id,
        input.fromName,
        input.fromEmail,
        input.replyToEmail ?? null,
        domain,
        input.dailyWarmupCap,
        user.id,
      ],
    );
    return res.rows[0] ?? { id };
  }

  async updateSenderIdentity(
    user: SessionUser,
    senderIdentityId: string,
    rawInput: UpdateSenderIdentityInput,
  ): Promise<Record<string, unknown>> {
    if (
      getCapabilityScope(user, 'settings.manage') === 'none' &&
      getCapabilityScope(user, 'campaigns.approve') === 'none'
    ) {
      requireCapability(user, 'settings.manage');
    }
    const input = UpdateSenderIdentityInputSchema.parse(rawInput);

    const existingRes = await this.db.query<{
      spf_verified: boolean;
      dkim_verified: boolean;
      dmarc_verified: boolean;
    }>(`SELECT spf_verified, dkim_verified, dmarc_verified FROM sender_identities WHERE id = $1`, [
      senderIdentityId,
    ]);
    const existing = existingRes.rows[0];
    if (!existing) throw new NotFoundDomainError('SenderIdentity', senderIdentityId);

    const spf = input.spfVerified ?? existing.spf_verified;
    const dkim = input.dkimVerified ?? existing.dkim_verified;
    const dmarc = input.dmarcVerified ?? existing.dmarc_verified;
    const allVerified = spf && dkim && dmarc;

    const updated = await this.db.query(
      `UPDATE sender_identities
       SET spf_verified = $2,
           dkim_verified = $3,
           dmarc_verified = $4,
           verified_at = CASE WHEN $5 THEN COALESCE(verified_at, NOW()) ELSE NULL END,
           daily_warmup_cap = COALESCE($6, daily_warmup_cap),
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [senderIdentityId, spf, dkim, dmarc, allVerified, input.dailyWarmupCap ?? null],
    );
    return updated.rows[0] ?? { id: senderIdentityId };
  }

  // -------------------------------------------------------------------------
  // Phase 5b: Campaigns, Preflight, Approval, Throttling & Auto-Pause (PRD §4.13, A19, A20)
  // -------------------------------------------------------------------------

  async listCampaigns(user: SessionUser): Promise<Record<string, unknown>[]> {
    const scope = scopeWhere(user, 'campaigns.read', { alias: 'c', startParamIndex: 1 });
    const res = await this.db.query(
      `SELECT c.*,
              l.name AS list_name,
              l.list_type,
              si.from_name AS sender_from_name,
              si.from_email AS sender_from_email,
              u.name AS owner_name,
              ap.name AS approved_by_name
       FROM campaigns c
       LEFT JOIN lists l ON l.id = c.list_id
       LEFT JOIN sender_identities si ON si.id = c.sender_identity_id
       LEFT JOIN users u ON u.id = c.owner_user_id
       LEFT JOIN users ap ON ap.id = c.approved_by_user_id
       WHERE ${scope.sql}
       ORDER BY c.created_at DESC`,
      scope.params,
    );
    return res.rows;
  }

  async createCampaign(
    user: SessionUser,
    rawInput: CreateCampaignInput,
  ): Promise<Record<string, unknown>> {
    requireCapability(user, 'campaigns.write');
    const input = CreateCampaignInputSchema.parse(rawInput);
    const id = `cmpg_${randomUUID()}`;

    const parsedBlocks: CampaignBlock[] = [];
    for (const rawBlock of input.blocks) {
      parsedBlocks.push(CampaignBlockSchema.parse(rawBlock));
    }

    let bodyHtml = input.bodyHtml;
    let bodyText = input.bodyText;
    if (parsedBlocks.length > 0) {
      const rendered = renderCampaignBlocks(parsedBlocks);
      bodyHtml = rendered.html;
      if (!bodyText.trim()) bodyText = rendered.text;
    }
    if (!bodyHtml.trim() && bodyText.trim()) {
      bodyHtml = `<p>${bodyText.trim()}</p>`;
    }
    if (!bodyHtml.trim()) {
      throw new ValidationDomainError('Campaign needs HTML or block content.', {
        bodyHtml: ['Add at least one block or HTML body.'],
      });
    }
    if (!bodyText.trim()) {
      bodyText = bodyHtml
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    let senderIdentityId = input.senderIdentityId ?? null;
    if (!senderIdentityId) {
      const defaultSender = await this.db.query<{ id: string }>(
        `SELECT id FROM sender_identities WHERE verified_at IS NOT NULL ORDER BY created_at ASC LIMIT 1`,
      );
      senderIdentityId = defaultSender.rows[0]?.id ?? null;
    }

    return this.db.transaction(async (tx) => {
      const res = await tx.query(
        `INSERT INTO campaigns (
           id, name, subject, body_html, body_text, blocks_json, market, status,
           list_id, segment_filter_json, template_id, sender_identity_id,
           throttle_per_hour, respect_recipient_timezone, click_tracking_enabled,
           exclude_unverified, owner_user_id, team_id
         ) VALUES (
           $1, $2, $3, $4, $5, $6::jsonb, $7, $8,
           $9, $10::jsonb, $11, $12,
           $13, $14, $15,
           $16, $17, $18
         )
         RETURNING *`,
        [
          id,
          input.name.trim(),
          input.subject.trim(),
          bodyHtml,
          bodyText,
          JSON.stringify(parsedBlocks),
          input.market,
          input.initialStatus,
          input.listId ?? null,
          input.segmentFilterJson ? JSON.stringify(input.segmentFilterJson) : null,
          input.templateId ?? null,
          senderIdentityId,
          input.throttlePerHour,
          input.respectRecipientTimezone,
          input.clickTrackingEnabled,
          input.excludeUnverified,
          user.id,
          user.teamId ?? 'team_us',
        ],
      );

      if (input.recipientContactIds.length > 0) {
        for (const cid of [...new Set(input.recipientContactIds)]) {
          const contactRow = await tx.query<{ id: string; primary_email: string }>(
            `SELECT id, primary_email FROM contacts WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
            [cid],
          );
          if (contactRow.rows[0]) {
            await tx.query(
              `INSERT INTO campaign_recipients (id, campaign_id, contact_id, email, status)
               VALUES ($1, $2, $3, $4, 'queued')
               ON CONFLICT (campaign_id, email) DO NOTHING`,
              [`crec_${randomUUID()}`, id, contactRow.rows[0].id, contactRow.rows[0].primary_email],
            );
          }
        }
      }

      return res.rows[0] ?? { id };
    });
  }

  /**
   * Updates a campaign. Per PRD 4.13: editing an approved or scheduled campaign automatically
   * returns its status to `draft` and clears its approval so a second reviewer checks the changes.
   */
  async updateCampaign(
    user: SessionUser,
    campaignId: string,
    rawInput: UpdateCampaignInput,
  ): Promise<Record<string, unknown>> {
    const scope = scopeWhere(user, 'campaigns.write', { alias: 'c', startParamIndex: 2 });
    const input = UpdateCampaignInputSchema.parse(rawInput);

    return this.db.transaction(async (tx) => {
      const existingRes = await tx.query<{
        id: string;
        version: number;
        status: string;
        body_html: string;
        body_text: string;
        blocks_json: CampaignBlock[];
      }>(
        `SELECT c.id, c.version, c.status, c.body_html, c.body_text, c.blocks_json
         FROM campaigns c
         WHERE c.id = $1 AND (${scope.sql})
         FOR UPDATE`,
        [campaignId, ...scope.params],
      );
      const existing = existingRes.rows[0];
      if (!existing) throw new NotFoundDomainError('Campaign', campaignId);
      if (existing.version !== input.version) {
        throw new VersionConflictError('Campaign', campaignId);
      }
      if (
        existing.status === 'sending' ||
        existing.status === 'completed' ||
        existing.status === 'sent'
      ) {
        throw new DomainError({
          status: 409,
          code: 'CAMPAIGN_LOCKED',
          title: 'Cannot edit a campaign that has already started sending',
          detail: 'Duplicate this campaign to send an updated version.',
        });
      }

      const nextBlocks = input.blocks ?? existing.blocks_json ?? [];
      let nextHtml = input.bodyHtml ?? existing.body_html;
      let nextText = input.bodyText ?? existing.body_text;
      if (input.blocks && input.blocks.length > 0) {
        const rendered = renderCampaignBlocks(input.blocks);
        nextHtml = rendered.html;
        if (input.bodyText === undefined) nextText = rendered.text;
      }

      const resetToDraft =
        existing.status === 'approved' ||
        existing.status === 'scheduled' ||
        existing.status === 'pending_approval';

      const updated = await tx.query(
        `UPDATE campaigns
         SET name = COALESCE($2, name),
             subject = COALESCE($3, subject),
             body_html = $4,
             body_text = $5,
             blocks_json = $6::jsonb,
             market = COALESCE($7, market),
             list_id = CASE WHEN $8::boolean THEN $9 ELSE list_id END,
             segment_filter_json = CASE WHEN $10::boolean THEN $11::jsonb ELSE segment_filter_json END,
             template_id = CASE WHEN $12::boolean THEN $13 ELSE template_id END,
             sender_identity_id = CASE WHEN $14::boolean THEN $15 ELSE sender_identity_id END,
             throttle_per_hour = COALESCE($16, throttle_per_hour),
             respect_recipient_timezone = COALESCE($17, respect_recipient_timezone),
             click_tracking_enabled = COALESCE($18, click_tracking_enabled),
             exclude_unverified = COALESCE($19, exclude_unverified),
             status = CASE WHEN $20::boolean THEN 'draft' ELSE status END,
             approved_by_user_id = CASE WHEN $20::boolean THEN NULL ELSE approved_by_user_id END,
             approved_at = CASE WHEN $20::boolean THEN NULL ELSE approved_at END,
             scheduled_at = CASE WHEN $20::boolean THEN NULL ELSE scheduled_at END,
             version = version + 1,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [
          campaignId,
          input.name ?? null,
          input.subject ?? null,
          nextHtml,
          nextText,
          JSON.stringify(nextBlocks),
          input.market ?? null,
          input.listId !== undefined,
          input.listId ?? null,
          input.segmentFilterJson !== undefined,
          input.segmentFilterJson ? JSON.stringify(input.segmentFilterJson) : null,
          input.templateId !== undefined,
          input.templateId ?? null,
          input.senderIdentityId !== undefined,
          input.senderIdentityId ?? null,
          input.throttlePerHour ?? null,
          input.respectRecipientTimezone ?? null,
          input.clickTrackingEnabled ?? null,
          input.excludeUnverified ?? null,
          resetToDraft,
        ],
      );

      return updated.rows[0] ?? { id: campaignId };
    });
  }

  async getCampaignPreflight(
    user: SessionUser,
    campaignId: string,
  ): Promise<{
    campaignId: string;
    senderVerified: boolean;
    senderFromEmail: string | null;
    sendingSubdomainOk: boolean;
    unsubscribeFooterAutomatic: boolean;
    postalAddressConfigured: boolean;
    postalAddress: string;
    totalAudienceCount: number;
    eligibleCount: number;
    suppressedCount: number;
    skippedByReason: Record<string, number>;
    counselSignedOff: boolean;
    mailLive: boolean;
    readyToApprove: boolean;
  }> {
    requireCapability(user, 'campaigns.read');
    const cmpgRes = await this.db.query<{
      id: string;
      market: Market;
      list_id: string | null;
      segment_filter_json: Record<string, unknown> | null;
      sender_identity_id: string | null;
      exclude_unverified: boolean;
    }>(`SELECT * FROM campaigns WHERE id = $1 LIMIT 1`, [campaignId]);
    const cmpg = cmpgRes.rows[0];
    if (!cmpg) throw new NotFoundDomainError('Campaign', campaignId);

    let senderVerified = false;
    let senderFromEmail: string | null = null;
    let sendingSubdomainOk = false;
    if (cmpg.sender_identity_id) {
      const siRes = await this.db.query<{
        from_email: string;
        domain: string;
        verified_at: Date | string | null;
        spf_verified: boolean;
        dkim_verified: boolean;
        dmarc_verified: boolean;
      }>(`SELECT * FROM sender_identities WHERE id = $1 LIMIT 1`, [cmpg.sender_identity_id]);
      const si = siRes.rows[0];
      if (si) {
        senderFromEmail = si.from_email;
        senderVerified = Boolean(
          si.verified_at && si.spf_verified && si.dkim_verified && si.dmarc_verified,
        );
        sendingSubdomainOk = si.domain.split('.').length >= 3;
      }
    }

    const postalAddresses = await this.getPostalAddresses();
    const postalAddress = postalAddresses[cmpg.market];
    const counselSignedOff = await this.isCounselSignedOff();

    // Candidate audience from list/segment or explicit `campaign_recipients`
    let candidates = await this.resolveSegmentOrListContacts(user.id, {
      listId: cmpg.list_id,
      segmentFilterJson: cmpg.segment_filter_json,
      market: !cmpg.list_id && !cmpg.segment_filter_json ? cmpg.market : undefined,
    });
    if (candidates.length === 0) {
      const explicitRes = await this.db.query<{
        id: string;
        full_name: string;
        first_name: string;
        primary_email: string;
        market: Market;
        timezone: string;
        email_verification_status: string;
        company_name: string | null;
      }>(
        `SELECT c.id, c.full_name, c.first_name, c.primary_email, c.market, c.timezone,
                c.email_verification_status, cmp.name AS company_name
         FROM campaign_recipients cr
         JOIN contacts c ON c.id = cr.contact_id
         LEFT JOIN companies cmp ON cmp.id = c.company_id
         WHERE cr.campaign_id = $1 AND c.deleted_at IS NULL`,
        [campaignId],
      );
      candidates = explicitRes.rows;
    }

    let eligibleCount = 0;
    let suppressedCount = 0;
    const skippedByReason: Record<string, number> = {};

    for (const candidate of candidates) {
      const check = await this.compliance.evaluateRecipientSendability({
        email: candidate.primary_email,
        channel: 'campaign',
        senderIdentityId: cmpg.sender_identity_id,
        excludeUnverifiedInCampaigns: cmpg.exclude_unverified,
        bypassSendWindow: true,
      });
      if (check.sendable) {
        eligibleCount += 1;
      } else {
        skippedByReason[check.reasonCode] = (skippedByReason[check.reasonCode] ?? 0) + 1;
        if (
          check.reasonCode === 'SUPPRESSED_EMAIL' ||
          check.reasonCode === 'SUPPRESSED_DOMAIN' ||
          check.reasonCode === 'HARD_BOUNCED' ||
          check.reasonCode === 'DO_NOT_CONTACT'
        ) {
          suppressedCount += 1;
        }
      }
    }

    return {
      campaignId,
      senderVerified,
      senderFromEmail,
      sendingSubdomainOk,
      unsubscribeFooterAutomatic: true,
      postalAddressConfigured: Boolean(postalAddress && postalAddress.length >= 10),
      postalAddress,
      totalAudienceCount: candidates.length,
      eligibleCount,
      suppressedCount,
      skippedByReason,
      counselSignedOff,
      mailLive: this.isLiveMailEnabled(),
      readyToApprove: senderVerified && sendingSubdomainOk && Boolean(postalAddress),
    };
  }

  async getCampaignDetail(user: SessionUser, campaignId: string): Promise<Record<string, unknown>> {
    const scope = scopeWhere(user, 'campaigns.read', { alias: 'c', startParamIndex: 2 });
    const cmpgRes = await this.db.query<Record<string, unknown>>(
      `SELECT c.*,
              l.name AS list_name,
              si.from_name AS sender_from_name,
              si.from_email AS sender_from_email,
              u.name AS owner_name,
              ap.name AS approved_by_name
       FROM campaigns c
       LEFT JOIN lists l ON l.id = c.list_id
       LEFT JOIN sender_identities si ON si.id = c.sender_identity_id
       LEFT JOIN users u ON u.id = c.owner_user_id
       LEFT JOIN users ap ON ap.id = c.approved_by_user_id
       WHERE c.id = $1 AND (${scope.sql})
       LIMIT 1`,
      [campaignId, ...scope.params],
    );
    const campaign = cmpgRes.rows[0];
    if (!campaign) throw new NotFoundDomainError('Campaign', campaignId);

    const [preflight, recipientsRes, clicksByLinkRes] = await Promise.all([
      this.getCampaignPreflight(user, campaignId),
      this.db.query<Record<string, unknown>>(
        `SELECT cr.*, c.full_name AS contact_name, cmp.name AS company_name
         FROM campaign_recipients cr
         JOIN contacts c ON c.id = cr.contact_id
         LEFT JOIN companies cmp ON cmp.id = c.company_id
         WHERE cr.campaign_id = $1
         ORDER BY cr.updated_at DESC
         LIMIT 200`,
        [campaignId],
      ),
      this.db.query<{ target_url: string; total_clicks: number; unique_clickers: number }>(
        `SELECT target_url,
                SUM(click_count)::int AS total_clicks,
                COUNT(*) FILTER (WHERE click_count > 0)::int AS unique_clickers
         FROM click_tokens
         WHERE campaign_id = $1 AND click_count > 0
         GROUP BY target_url
         ORDER BY total_clicks DESC`,
        [campaignId],
      ),
    ]);

    return {
      campaign,
      preflight,
      recipients: recipientsRes.rows,
      clicksByLink: clicksByLinkRes.rows,
    };
  }

  async submitCampaignForApproval(
    user: SessionUser,
    campaignId: string,
  ): Promise<Record<string, unknown>> {
    requireCapability(user, 'campaigns.write');
    return this.db.transaction(async (tx) => {
      const existing = await tx.query<{ id: string; name: string; status: string }>(
        `SELECT id, name, status FROM campaigns WHERE id = $1 FOR UPDATE`,
        [campaignId],
      );
      const cmpg = existing.rows[0];
      if (!cmpg) throw new NotFoundDomainError('Campaign', campaignId);
      if (cmpg.status !== 'draft' && cmpg.status !== 'pending_approval') {
        throw new DomainError({
          status: 409,
          code: 'INVALID_CAMPAIGN_STATE',
          title: 'Only draft campaigns can be submitted for approval',
          detail: `Campaign is currently ${cmpg.status}.`,
        });
      }

      const updated = await tx.query(
        `UPDATE campaigns
         SET status = 'pending_approval', version = version + 1, updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [campaignId],
      );

      // Notify Marketing Managers and Admins (excluding submitter)
      const approvers = await tx.query<{ id: string }>(
        `SELECT u.id FROM users u
         JOIN roles r ON r.id = u.role_id
         WHERE u.status = 'active' AND u.id <> $1 AND r.name IN ('Marketing Manager', 'Admin')`,
        [user.id],
      );
      for (const approver of approvers.rows) {
        await addNotification(tx, {
          userId: approver.id,
          kind: 'general',
          title: `Campaign ready for approval: ${cmpg.name}`,
          body: `${user.name} submitted "${cmpg.name}" for review.`,
          entityType: 'campaign',
          entityId: campaignId,
          dedupeKey: `cmpg_submit:${campaignId}:${approver.id}:${Date.now()}`,
        });
      }

      return updated.rows[0] ?? { id: campaignId };
    });
  }

  /**
   * PRD §4.13 & §15 Q12 (A19) — Only a user with `campaigns.approve` (Marketing Manager or Admin)
   * can approve a campaign, and the creator cannot approve their own campaign (Admin override audited).
   */
  async approveCampaign(user: SessionUser, campaignId: string): Promise<Record<string, unknown>> {
    requireCapability(user, 'campaigns.approve');

    return this.db.transaction(async (tx) => {
      const existing = await tx.query<{ owner_user_id: string | null; status: string }>(
        `SELECT owner_user_id, status FROM campaigns WHERE id = $1 LIMIT 1 FOR UPDATE`,
        [campaignId],
      );
      if (!existing.rows[0]) {
        throw new NotFoundDomainError('Campaign', campaignId);
      }
      const isSelfApproval = existing.rows[0].owner_user_id === user.id;
      if (isSelfApproval && user.role !== 'Admin') {
        throw new DomainError({
          status: 403,
          code: 'SELF_APPROVAL_NOT_ALLOWED',
          title: 'Campaign needs a second approver',
          detail: 'You created this campaign, so someone else has to approve it.',
        });
      }

      const updated = await tx.query(
        `UPDATE campaigns
         SET status = 'approved',
             approved_by_user_id = $2,
             approved_at = NOW(),
             version = version + 1,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [campaignId, user.id],
      );
      const campaign = updated.rows[0];
      if (!campaign) {
        throw new NotFoundDomainError('Campaign', campaignId);
      }

      await this.db.writeAuditLog(tx, {
        actorUserId: user.id,
        actorEmail: user.email,
        action: 'campaign.approved',
        entityType: 'campaign',
        entityId: campaignId,
        metadata: isSelfApproval ? { adminSelfApprovalOverride: true } : {},
      });

      await this.db.addOutboxEvent(tx, {
        eventType: 'campaign.approved',
        aggregateType: 'campaign',
        aggregateId: campaignId,
        payload: { campaignId, approvedByUserId: user.id },
      });

      return campaign;
    });
  }

  /**
   * Sends a `[TEST]` copy of a campaign to an internal CRM user's email address (PRD 4.13).
   */
  async testSendCampaign(
    user: SessionUser,
    campaignId: string,
    rawInput: TestSendCampaignInput,
  ): Promise<SendMessageJobResult> {
    if (
      getCapabilityScope(user, 'campaigns.write') === 'none' &&
      getCapabilityScope(user, 'campaigns.approve') === 'none'
    ) {
      requireCapability(user, 'campaigns.write');
    }
    const input = TestSendCampaignInputSchema.parse(rawInput);

    const internalUser = await this.db.query<{ id: string }>(
      `SELECT id FROM users WHERE LOWER(email) = $1 AND status = 'active' LIMIT 1`,
      [input.recipientEmail],
    );
    if (!internalUser.rows[0]) {
      throw new ValidationDomainError(
        'Test sends can only be sent to active internal CRM user email addresses.',
        { recipientEmail: ['Choose an active internal employee email address.'] },
      );
    }

    const cmpgRes = await this.db.query<{
      id: string;
      subject: string;
      body_html: string;
      body_text: string;
      sender_identity_id: string | null;
    }>(
      `SELECT id, subject, body_html, body_text, sender_identity_id FROM campaigns WHERE id = $1`,
      [campaignId],
    );
    const cmpg = cmpgRes.rows[0];
    if (!cmpg) throw new NotFoundDomainError('Campaign', campaignId);

    const vars = {
      'contact.first_name': user.name.split(' ')[0] ?? 'Colleague',
      first_name: user.name.split(' ')[0] ?? 'Colleague',
      'company.name': 'Sample CPA Firm LLP',
      company_name: 'Sample CPA Firm LLP',
    };

    return this.executeSendMessageJob({
      idempotencyKey: `cmpg_test_${campaignId}_${randomUUID()}`,
      channel: 'transactional',
      recipientEmail: input.recipientEmail,
      senderUserId: user.id,
      senderIdentityId: cmpg.sender_identity_id,
      subject: `[TEST] ${renderEmailTemplate(cmpg.subject, vars)}`,
      bodyText: renderEmailTemplate(cmpg.body_text || cmpg.body_html, vars),
      bodyHtml: renderEmailTemplate(cmpg.body_html, vars),
      bypassSendWindow: true,
    });
  }

  private async snapshotCampaignAudience(
    userId: string,
    campaignId: string,
  ): Promise<{ queuedCount: number; skippedCount: number }> {
    const cmpgRes = await this.db.query<{
      id: string;
      market: Market;
      list_id: string | null;
      segment_filter_json: Record<string, unknown> | null;
      sender_identity_id: string | null;
      exclude_unverified: boolean;
    }>(`SELECT * FROM campaigns WHERE id = $1 LIMIT 1`, [campaignId]);
    const cmpg = cmpgRes.rows[0];
    if (!cmpg) throw new NotFoundDomainError('Campaign', campaignId);

    const candidates = await this.resolveSegmentOrListContacts(userId, {
      listId: cmpg.list_id,
      segmentFilterJson: cmpg.segment_filter_json,
      market: !cmpg.list_id && !cmpg.segment_filter_json ? cmpg.market : undefined,
    });

    if (candidates.length === 0) {
      const existingRecips = await this.db.query<{ contact_id: string; email: string }>(
        `SELECT contact_id, email FROM campaign_recipients WHERE campaign_id = $1`,
        [campaignId],
      );
      if (existingRecips.rows.length > 0) {
        let queuedCount = 0;
        let skippedCount = 0;
        for (const r of existingRecips.rows) {
          const check = await this.compliance.evaluateRecipientSendability({
            email: r.email,
            channel: 'campaign',
            senderIdentityId: cmpg.sender_identity_id,
            excludeUnverifiedInCampaigns: cmpg.exclude_unverified,
            bypassSendWindow: true,
          });
          if (check.sendable) {
            queuedCount += 1;
          } else {
            skippedCount += 1;
            await this.db.query(
              `UPDATE campaign_recipients
               SET status = 'skipped_compliance', reason_code = $3, updated_at = NOW()
               WHERE campaign_id = $1 AND contact_id = $2 AND status = 'queued'`,
              [campaignId, r.contact_id, check.reasonCode],
            );
          }
        }
        return { queuedCount, skippedCount };
      }
    }

    let queuedCount = 0;
    let skippedCount = 0;
    for (const candidate of candidates) {
      const check = await this.compliance.evaluateRecipientSendability({
        email: candidate.primary_email,
        channel: 'campaign',
        senderIdentityId: cmpg.sender_identity_id,
        excludeUnverifiedInCampaigns: cmpg.exclude_unverified,
        bypassSendWindow: true,
      });
      const status = check.sendable ? 'queued' : 'skipped_compliance';
      if (check.sendable) queuedCount += 1;
      else skippedCount += 1;

      await this.db.query(
        `INSERT INTO campaign_recipients (id, campaign_id, contact_id, email, status, reason_code)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (campaign_id, email) DO NOTHING`,
        [
          `crec_${randomUUID()}`,
          campaignId,
          candidate.id,
          candidate.primary_email,
          status,
          check.reasonCode,
        ],
      );
    }

    return { queuedCount, skippedCount };
  }

  async scheduleCampaign(
    user: SessionUser,
    campaignId: string,
    rawInput: ScheduleCampaignInput,
  ): Promise<Record<string, unknown>> {
    if (
      getCapabilityScope(user, 'campaigns.write') === 'none' &&
      getCapabilityScope(user, 'campaigns.approve') === 'none'
    ) {
      requireCapability(user, 'campaigns.write');
    }
    const input = ScheduleCampaignInputSchema.parse(rawInput);

    const cmpgRes = await this.db.query<{
      id: string;
      status: string;
      approved_at: Date | string | null;
      owner_user_id: string;
    }>(`SELECT id, status, approved_at, owner_user_id FROM campaigns WHERE id = $1 LIMIT 1`, [
      campaignId,
    ]);
    const cmpg = cmpgRes.rows[0];
    if (!cmpg) throw new NotFoundDomainError('Campaign', campaignId);

    if (
      (cmpg.status !== 'approved' && cmpg.status !== 'paused' && cmpg.status !== 'scheduled') ||
      !cmpg.approved_at
    ) {
      throw new DomainError({
        status: 422,
        code: 'CAMPAIGN_NOT_APPROVED',
        title: 'Campaign must be approved before scheduling or sending',
        detail: 'Ask a Marketing Manager or Admin to approve this campaign first.',
      });
    }

    const sendNow = input.sendNow || !input.scheduledAt;
    const scheduledAt = sendNow ? new Date().toISOString() : input.scheduledAt;

    if (sendNow) {
      await this.snapshotCampaignAudience(cmpg.owner_user_id, campaignId);
    }

    return this.db.transaction(async (tx) => {
      const updated = await tx.query(
        `UPDATE campaigns
         SET status = $2,
             scheduled_at = $3::timestamptz,
             started_at = CASE WHEN $2 = 'sending' THEN COALESCE(started_at, NOW()) ELSE started_at END,
             throttle_per_hour = COALESCE($4, throttle_per_hour),
             paused_reason = NULL,
             version = version + 1,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [campaignId, sendNow ? 'sending' : 'scheduled', scheduledAt, input.throttlePerHour ?? null],
      );

      await this.db.writeAuditLog(tx, {
        actorUserId: user.id,
        actorEmail: user.email,
        action: sendNow ? 'campaign.started' : 'campaign.scheduled',
        entityType: 'campaign',
        entityId: campaignId,
        metadata: { scheduledAt },
      });

      await this.db.addOutboxEvent(tx, {
        eventType: sendNow ? 'campaign.started' : 'campaign.scheduled',
        aggregateType: 'campaign',
        aggregateId: campaignId,
        payload: { campaignId, scheduledAt },
      });

      return updated.rows[0] ?? { id: campaignId };
    });
  }

  async pauseCampaign(
    user: SessionUser,
    campaignId: string,
    reason = 'Paused manually',
  ): Promise<Record<string, unknown>> {
    if (
      getCapabilityScope(user, 'campaigns.write') === 'none' &&
      getCapabilityScope(user, 'campaigns.approve') === 'none'
    ) {
      requireCapability(user, 'campaigns.write');
    }

    return this.db.transaction(async (tx) => {
      const updated = await tx.query(
        `UPDATE campaigns
         SET status = 'paused',
             paused_reason = $2,
             version = version + 1,
             updated_at = NOW()
         WHERE id = $1 AND status IN ('approved', 'scheduled', 'sending')
         RETURNING *`,
        [campaignId, reason],
      );
      const row = updated.rows[0];
      if (!row) {
        throw new DomainError({
          status: 409,
          code: 'INVALID_CAMPAIGN_STATE',
          title: 'Campaign cannot be paused in its current state',
          detail: 'Only approved, scheduled, or sending campaigns can be paused.',
        });
      }
      await this.db.addOutboxEvent(tx, {
        eventType: 'campaign.paused',
        aggregateType: 'campaign',
        aggregateId: campaignId,
        payload: { campaignId, reason },
      });
      return row;
    });
  }

  async cancelCampaign(user: SessionUser, campaignId: string): Promise<Record<string, unknown>> {
    if (
      getCapabilityScope(user, 'campaigns.write') === 'none' &&
      getCapabilityScope(user, 'campaigns.approve') === 'none'
    ) {
      requireCapability(user, 'campaigns.write');
    }

    const updated = await this.db.query(
      `UPDATE campaigns
       SET status = 'cancelled',
           version = version + 1,
           updated_at = NOW()
       WHERE id = $1 AND status IN ('draft', 'pending_approval', 'approved', 'scheduled', 'sending', 'paused')
       RETURNING *`,
      [campaignId],
    );
    const row = updated.rows[0];
    if (!row) throw new NotFoundDomainError('Campaign', campaignId);
    return row;
  }

  /**
   * Worker job `campaign.tick` (every minute — PRD 6.9, 8.4):
   * Starts due `scheduled` campaigns (snapshotting their audience) and releases `queued`
   * `campaign_recipients` within `throttle_per_hour` and `sender_identities.daily_warmup_cap`.
   */
  async runCampaignTick(options: { now?: Date } = {}): Promise<{
    startedCampaigns: number;
    sentMessages: number;
    skippedCompliance: number;
    completedCampaigns: number;
  }> {
    const now = options.now ?? new Date();
    const nowIso = now.toISOString();

    let startedCampaigns = 0;
    let sentMessages = 0;
    let skippedCompliance = 0;
    let completedCampaigns = 0;

    // 1. Start due scheduled campaigns
    const dueScheduled = await this.db.query<{ id: string; owner_user_id: string }>(
      `SELECT id, owner_user_id
       FROM campaigns
       WHERE status = 'scheduled'
         AND approved_at IS NOT NULL
         AND scheduled_at IS NOT NULL
         AND scheduled_at <= $1::timestamptz`,
      [nowIso],
    );

    for (const c of dueScheduled.rows) {
      await this.snapshotCampaignAudience(c.owner_user_id, c.id);
      await this.db.query(
        `UPDATE campaigns
         SET status = 'sending', started_at = COALESCE(started_at, $2::timestamptz), updated_at = NOW()
         WHERE id = $1 AND status = 'scheduled'`,
        [c.id, nowIso],
      );
      startedCampaigns += 1;
    }

    // 2. Process active `sending` campaigns within hourly throttle and warm-up cap
    const sendingRes = await this.db.query<{
      id: string;
      subject: string;
      body_html: string;
      body_text: string;
      sender_identity_id: string | null;
      owner_user_id: string;
      throttle_per_hour: number;
      respect_recipient_timezone: boolean;
      click_tracking_enabled: boolean;
      exclude_unverified: boolean;
    }>(`SELECT * FROM campaigns WHERE status = 'sending' ORDER BY started_at ASC NULLS FIRST`);

    for (const cmpg of sendingRes.rows) {
      const [sentLastHourRes, warmupRes] = await Promise.all([
        this.db.query<{ cnt: number }>(
          `SELECT COUNT(*)::int AS cnt
           FROM message_sends
           WHERE campaign_id = $1 AND sent_at >= $2::timestamptz - INTERVAL '1 hour'`,
          [cmpg.id, nowIso],
        ),
        cmpg.sender_identity_id
          ? this.db.query<{ daily_warmup_cap: number; sent_today: number }>(
              `SELECT si.daily_warmup_cap,
                      (SELECT COUNT(*)::int FROM message_sends ms
                       WHERE ms.sender_identity_id = si.id
                         AND ms.sent_at >= date_trunc('day', $2::timestamptz)) AS sent_today
               FROM sender_identities si WHERE si.id = $1 LIMIT 1`,
              [cmpg.sender_identity_id, nowIso],
            )
          : Promise.resolve({ rows: [], rowCount: 0 }),
      ]);

      const hourlyRemaining = Math.max(
        0,
        cmpg.throttle_per_hour - (sentLastHourRes.rows[0]?.cnt ?? 0),
      );
      const warmupRow = warmupRes.rows[0];
      const warmupRemaining = warmupRow
        ? Math.max(0, warmupRow.daily_warmup_cap - warmupRow.sent_today)
        : hourlyRemaining;
      const batchBudget = Math.min(hourlyRemaining, warmupRemaining, 50);

      if (batchBudget > 0) {
        const queuedRes = await this.db.query<{
          id: string;
          contact_id: string;
          email: string;
          first_name: string;
          company_name: string | null;
        }>(
          `SELECT cr.id, cr.contact_id, cr.email, c.first_name, cmp.name AS company_name
           FROM campaign_recipients cr
           JOIN contacts c ON c.id = cr.contact_id
           LEFT JOIN companies cmp ON cmp.id = c.company_id
           WHERE cr.campaign_id = $1 AND cr.status = 'queued'
           ORDER BY cr.id ASC
           LIMIT $2`,
          [cmpg.id, batchBudget],
        );

        for (const rec of queuedRes.rows) {
          const vars = {
            'contact.first_name': rec.first_name,
            first_name: rec.first_name,
            'company.name': rec.company_name ?? 'your firm',
            company_name: rec.company_name ?? 'your firm',
          };

          const sendRes = await this.executeSendMessageJob({
            idempotencyKey: `cmp:${rec.id}`,
            channel: 'campaign',
            recipientEmail: rec.email,
            contactId: rec.contact_id,
            senderUserId: cmpg.owner_user_id,
            senderIdentityId: cmpg.sender_identity_id,
            campaignId: cmpg.id,
            campaignRecipientId: rec.id,
            subject: renderEmailTemplate(cmpg.subject, vars),
            bodyText: renderEmailTemplate(cmpg.body_text || cmpg.body_html, vars),
            bodyHtml: renderEmailTemplate(cmpg.body_html, vars),
            clickTrackingEnabled: cmpg.click_tracking_enabled,
            excludeUnverifiedInCampaigns: cmpg.exclude_unverified,
            bypassSendWindow: !cmpg.respect_recipient_timezone,
            now,
          });

          if (sendRes.sent) {
            sentMessages += 1;
            await this.db.query(
              `UPDATE campaign_recipients
               SET status = 'sent',
                   reason_code = 'OK',
                   message_send_id = $2,
                   sent_at = $3::timestamptz,
                   updated_at = NOW()
               WHERE id = $1`,
              [rec.id, sendRes.messageSendId, nowIso],
            );
            await this.db.query(
              `UPDATE campaigns SET sent_count = sent_count + 1, updated_at = NOW() WHERE id = $1`,
              [cmpg.id],
            );
          } else if (sendRes.reasonCode !== 'OUTSIDE_SEND_WINDOW') {
            skippedCompliance += 1;
            await this.db.query(
              `UPDATE campaign_recipients
               SET status = 'skipped_compliance',
                   reason_code = $2,
                   updated_at = NOW()
               WHERE id = $1`,
              [rec.id, sendRes.reasonCode],
            );
          }
        }
      }

      // Mark completed if no queued recipients remain
      const remainingRes = await this.db.query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM campaign_recipients WHERE campaign_id = $1 AND status = 'queued'`,
        [cmpg.id],
      );
      if ((remainingRes.rows[0]?.cnt ?? 0) === 0) {
        await this.db.transaction(async (tx) => {
          await tx.query(
            `UPDATE campaigns
             SET status = 'completed', completed_at = COALESCE(completed_at, $2::timestamptz), updated_at = NOW()
             WHERE id = $1 AND status = 'sending'`,
            [cmpg.id, nowIso],
          );
          await this.db.addOutboxEvent(tx, {
            eventType: 'campaign.completed',
            aggregateType: 'campaign',
            aggregateId: cmpg.id,
            payload: { campaignId: cmpg.id },
          });
        });
        completedCampaigns += 1;
      }
    }

    return { startedCampaigns, sentMessages, skippedCompliance, completedCampaigns };
  }

  private async notifyCampaignDeliverabilityPause(
    tx: DbTx,
    campaignId: string,
    pausedReason: string,
  ): Promise<void> {
    const cmpgRes = await tx.query<{ name: string; owner_user_id: string }>(
      `SELECT name, owner_user_id FROM campaigns WHERE id = $1 LIMIT 1`,
      [campaignId],
    );
    const cmpg = cmpgRes.rows[0];
    if (!cmpg) return;

    const recipients = await tx.query<{ id: string }>(
      `SELECT u.id FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE u.status = 'active' AND (u.id = $1 OR r.name = 'Marketing Manager')`,
      [cmpg.owner_user_id],
    );

    for (const r of recipients.rows) {
      await addNotification(tx, {
        userId: r.id,
        kind: 'general',
        title: `Campaign auto-paused: ${cmpg.name}`,
        body: pausedReason,
        entityType: 'campaign',
        entityId: campaignId,
        dedupeKey: `cmpg_autopause:${campaignId}:${r.id}`,
      });
    }
  }

  /**
   * PRD §4.13 & §5.6 (A20) — Campaign deliverability monitor & auto-pause:
   * Immediately pauses the campaign (`status = 'paused_deliverability'`) and notifies the owner
   * and Marketing Manager if hard bounce rate exceeds 3% (`0.03`) or complaint rate exceeds 0.1% (`0.001`).
   */
  async recordCampaignMetricsAndCheckThresholds(
    campaignId: string,
    metrics: {
      sentCount: number;
      deliveredCount: number;
      bouncedCount: number;
      complainedCount: number;
      unsubscribedCount?: number;
      minSampleSize?: number;
    },
  ): Promise<{
    campaignId: string;
    status: string;
    autoPaused: boolean;
    bounceRate: number;
    complaintRate: number;
    pausedReason: string | null;
  }> {
    if (metrics.sentCount <= 0) {
      throw new ValidationDomainError('sentCount must be positive');
    }

    const minSample = metrics.minSampleSize ?? 1;
    const bounceRate = metrics.bouncedCount / metrics.sentCount;
    const complaintRate = metrics.complainedCount / metrics.sentCount;

    let pausedReason: string | null = null;
    if (metrics.sentCount >= minSample) {
      if (bounceRate > 0.03) {
        pausedReason = `Auto-paused: hard bounce rate ${(bounceRate * 100).toFixed(2)}% exceeded 3.00% threshold`;
      } else if (complaintRate > 0.001) {
        pausedReason = `Auto-paused: complaint rate ${(complaintRate * 100).toFixed(2)}% exceeded 0.10% threshold`;
      }
    }

    const newStatus = pausedReason ? 'paused_deliverability' : 'sending';

    await this.db.transaction(async (tx) => {
      await tx.query(
        `UPDATE campaigns
         SET sent_count = $2,
             delivered_count = $3,
             bounced_count = $4,
             complained_count = $5,
             unsubscribed_count = $6,
             status = $7,
             paused_reason = $8,
             updated_at = NOW()
         WHERE id = $1`,
        [
          campaignId,
          metrics.sentCount,
          metrics.deliveredCount,
          metrics.bouncedCount,
          metrics.complainedCount,
          metrics.unsubscribedCount ?? 0,
          newStatus,
          pausedReason,
        ],
      );

      if (pausedReason) {
        await this.notifyCampaignDeliverabilityPause(tx, campaignId, pausedReason);
        await this.db.writeAuditLog(tx, {
          action: 'campaign.auto_paused_deliverability',
          entityType: 'campaign',
          entityId: campaignId,
          metadata: { bounceRate, complaintRate, pausedReason },
        });
        await this.db.addOutboxEvent(tx, {
          eventType: 'campaign.auto_paused',
          aggregateType: 'campaign',
          aggregateId: campaignId,
          payload: { campaignId, bounceRate, complaintRate, pausedReason },
        });
      }
    });

    return {
      campaignId,
      status: newStatus,
      autoPaused: Boolean(pausedReason),
      bounceRate,
      complaintRate,
      pausedReason,
    };
  }

  // -------------------------------------------------------------------------
  // Public ESP Webhook (`POST /api/v1/webhooks/esp`) & Stored Click Redirect (`GET /c/:token`)
  // (PRD §5.6, §8.4, §8.6, §12.1 A20)
  // -------------------------------------------------------------------------

  async handleEspWebhook(input: {
    rawBody: string;
    signatureHeader: string | undefined;
    timestampHeader?: string | undefined;
    parsedBody: unknown;
  }): Promise<{
    processedEvents: number;
    deduplicatedEvents: number;
    autoPausedCampaigns: string[];
  }> {
    let verified = false;
    if (this.espSender && 'verifyWebhook' in this.espSender) {
      verified = this.espSender.verifyWebhook(
        input.rawBody,
        input.signatureHeader,
        input.timestampHeader,
      );
    }
    if (!verified && this.espWebhookSecret) {
      verified = verifyEspWebhookSignature({
        rawBody: input.rawBody,
        signatureHeader: input.signatureHeader,
        timestampHeader: input.timestampHeader,
        secret: this.espWebhookSecret,
      });
    }
    if (!verified) {
      throw new DomainError({
        status: 401,
        code: 'INVALID_WEBHOOK_SIGNATURE',
        title: 'Invalid ESP webhook signature',
        detail: 'Webhook HMAC signature verification failed.',
      });
    }

    const events = parseEspWebhookPayload(input.parsedBody);
    let processedEvents = 0;
    let deduplicatedEvents = 0;
    const touchedCampaignIds = new Set<string>();

    for (const ev of events) {
      const dedupRes = await this.db.query<{ id: string }>(
        `INSERT INTO inbound_events (id, provider, provider_event_id, status, processed_at, metadata)
         VALUES ($1, 'esp_bulk', $2, 'processed', NOW(), $3::jsonb)
         ON CONFLICT (provider, provider_event_id) DO NOTHING
         RETURNING id`,
        [`inb_${randomUUID()}`, ev.providerEventId, JSON.stringify({ eventType: ev.eventType })],
      );
      if (dedupRes.rows.length === 0) {
        deduplicatedEvents += 1;
        continue;
      }

      processedEvents += 1;

      const sendRes = ev.providerMessageId
        ? await this.db.query<{
            id: string;
            campaign_id: string | null;
            campaign_recipient_id: string | null;
            sequence_enrollment_id: string | null;
            contact_id: string | null;
            recipient_email: string;
          }>(
            `SELECT id, campaign_id, campaign_recipient_id, sequence_enrollment_id, contact_id, recipient_email
             FROM message_sends
             WHERE provider_message_id = $1
             LIMIT 1`,
            [ev.providerMessageId],
          )
        : { rows: [] };

      const sendRow = sendRes.rows[0] ?? null;
      const email = ev.recipientEmail ?? sendRow?.recipient_email ?? null;
      const campaignId = sendRow?.campaign_id ?? null;

      await this.db.query(
        `INSERT INTO send_events (
           id, message_send_id, campaign_id, sequence_enrollment_id, contact_id,
           event_type, provider, provider_event_id, link_url, metadata, occurred_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'esp_bulk', $7, $8, $9::jsonb, $10::timestamptz)
         ON CONFLICT (provider, provider_event_id) DO NOTHING`,
        [
          `sev_${randomUUID()}`,
          sendRow?.id ?? null,
          campaignId,
          sendRow?.sequence_enrollment_id ?? null,
          sendRow?.contact_id ?? null,
          ev.eventType,
          ev.providerEventId,
          ev.linkUrl,
          JSON.stringify({ diagnostic: ev.diagnostic }),
          ev.occurredAt,
        ],
      );

      if (ev.eventType === 'delivered') {
        if (sendRow) {
          await this.db.query(`UPDATE message_sends SET status = 'delivered' WHERE id = $1`, [
            sendRow.id,
          ]);
        }
        if (sendRow?.campaign_recipient_id) {
          await this.db.query(
            `UPDATE campaign_recipients SET status = 'delivered', delivered_at = NOW(), updated_at = NOW() WHERE id = $1`,
            [sendRow.campaign_recipient_id],
          );
        }
        if (campaignId) {
          await this.db.query(
            `UPDATE campaigns SET delivered_count = delivered_count + 1, updated_at = NOW() WHERE id = $1`,
            [campaignId],
          );
          touchedCampaignIds.add(campaignId);
        }
      } else if (ev.eventType === 'bounced_hard') {
        if (sendRow) {
          await this.db.query(`UPDATE message_sends SET status = 'bounced' WHERE id = $1`, [
            sendRow.id,
          ]);
        }
        if (sendRow?.campaign_recipient_id) {
          await this.db.query(
            `UPDATE campaign_recipients SET status = 'bounced', updated_at = NOW() WHERE id = $1`,
            [sendRow.campaign_recipient_id],
          );
        }
        if (email) {
          await this.handleHardBounce(email, ev.diagnostic ?? 'ESP hard bounce');
        }
        if (campaignId) {
          await this.db.query(
            `UPDATE campaigns SET bounced_count = bounced_count + 1, updated_at = NOW() WHERE id = $1`,
            [campaignId],
          );
          touchedCampaignIds.add(campaignId);
        }
      } else if (ev.eventType === 'bounced_soft') {
        if (sendRow) {
          await this.db.query(`UPDATE message_sends SET status = 'soft_bounced' WHERE id = $1`, [
            sendRow.id,
          ]);
        }
        if (sendRow?.campaign_recipient_id) {
          await this.db.query(
            `UPDATE campaign_recipients SET status = 'soft_bounced', updated_at = NOW() WHERE id = $1`,
            [sendRow.campaign_recipient_id],
          );
        }
        if (campaignId) {
          await this.db.query(
            `UPDATE campaigns SET soft_bounced_count = soft_bounced_count + 1, updated_at = NOW() WHERE id = $1`,
            [campaignId],
          );
        }
      } else if (ev.eventType === 'complained') {
        if (sendRow) {
          await this.db.query(`UPDATE message_sends SET status = 'complained' WHERE id = $1`, [
            sendRow.id,
          ]);
        }
        if (sendRow?.campaign_recipient_id) {
          await this.db.query(
            `UPDATE campaign_recipients SET status = 'complained', updated_at = NOW() WHERE id = $1`,
            [sendRow.campaign_recipient_id],
          );
        }
        if (email) {
          await this.compliance.addSuppression({
            email,
            reason: 'complaint',
            source: 'esp_webhook',
            notes: ev.diagnostic ?? 'ESP spam complaint',
          });
        }
        if (campaignId) {
          await this.db.query(
            `UPDATE campaigns SET complained_count = complained_count + 1, updated_at = NOW() WHERE id = $1`,
            [campaignId],
          );
          touchedCampaignIds.add(campaignId);
        }
      } else if (ev.eventType === 'unsubscribed') {
        if (sendRow?.campaign_recipient_id) {
          await this.db.query(
            `UPDATE campaign_recipients SET status = 'unsubscribed', updated_at = NOW() WHERE id = $1`,
            [sendRow.campaign_recipient_id],
          );
        }
        if (email) {
          await this.compliance.addSuppression({
            email,
            reason: 'unsubscribe',
            source: 'esp_webhook',
          });
        }
        if (campaignId) {
          await this.db.query(
            `UPDATE campaigns SET unsubscribed_count = unsubscribed_count + 1, updated_at = NOW() WHERE id = $1`,
            [campaignId],
          );
        }
      } else if (ev.eventType === 'clicked') {
        if (campaignId) {
          await this.db.query(
            `UPDATE campaigns SET clicked_count = clicked_count + 1, updated_at = NOW() WHERE id = $1`,
            [campaignId],
          );
        }
      } else if (ev.eventType === 'opened') {
        // PRD 4.5, 4.13: Opens are recorded ONLY under an explicit "unreliable" counter and NEVER trigger scoring/automation.
        if (campaignId) {
          await this.db.query(
            `UPDATE campaigns SET opened_unreliable_count = opened_unreliable_count + 1, updated_at = NOW() WHERE id = $1`,
            [campaignId],
          );
        }
      }
    }

    // PRD 5.6 & 12.1 A20: After >= 200 deliveries/attempts, >3% hard bounce or >0.1% complaint auto-pauses and alerts!
    const autoPausedCampaigns: string[] = [];
    for (const cid of touchedCampaignIds) {
      const cRes = await this.db.query<{
        sent_count: number;
        delivered_count: number;
        bounced_count: number;
        complained_count: number;
        unsubscribed_count: number;
        status: string;
      }>(`SELECT * FROM campaigns WHERE id = $1 LIMIT 1`, [cid]);
      const c = cRes.rows[0];
      if (!c || c.status === 'paused_deliverability') continue;
      const sampleDenominator = Math.max(c.sent_count, c.delivered_count + c.bounced_count);
      if (sampleDenominator >= 200) {
        const checkRes = await this.recordCampaignMetricsAndCheckThresholds(cid, {
          sentCount: sampleDenominator,
          deliveredCount: c.delivered_count,
          bouncedCount: c.bounced_count,
          complainedCount: c.complained_count,
          unsubscribedCount: c.unsubscribed_count,
          minSampleSize: 200,
        });
        if (checkRes.autoPaused) {
          autoPausedCampaigns.push(cid);
        }
      }
    }

    return { processedEvents, deduplicatedEvents, autoPausedCampaigns };
  }

  /**
   * Public `GET /c/:token` click handler on `go.` (PRD 8.6):
   * Redirects ONLY to the `target_url` stored in `click_tokens` for `sha256(token)`.
   * Never reads a URL from query parameters (impossible to abuse as an open redirect).
   */
  async handleClickRedirect(rawToken: string): Promise<{ targetUrl: string }> {
    const clean = rawToken.trim();
    if (!clean || clean.length > 200) {
      throw new NotFoundDomainError('ClickLink', 'invalid');
    }
    const tokenSha256 = sha256Hex(clean);

    return this.db.transaction(async (tx) => {
      const res = await tx.query<{
        token_sha256: string;
        target_url: string;
        message_send_id: string | null;
        campaign_id: string | null;
        sequence_enrollment_id: string | null;
        contact_id: string | null;
        click_count: number;
      }>(`SELECT * FROM click_tokens WHERE token_sha256 = $1 LIMIT 1 FOR UPDATE`, [tokenSha256]);
      const row = res.rows[0];
      if (!row || !/^https?:\/\//i.test(row.target_url)) {
        throw new NotFoundDomainError('ClickLink', 'invalid');
      }

      const isFirstClick = row.click_count === 0;
      await tx.query(
        `UPDATE click_tokens
         SET click_count = click_count + 1,
             first_clicked_at = COALESCE(first_clicked_at, NOW()),
             last_clicked_at = NOW()
         WHERE token_sha256 = $1`,
        [tokenSha256],
      );

      await tx.query(
        `INSERT INTO send_events (
           id, message_send_id, campaign_id, sequence_enrollment_id, contact_id,
           event_type, provider, link_url, occurred_at
         ) VALUES ($1, $2, $3, $4, $5, 'clicked', 'go_redirect', $6, NOW())`,
        [
          `sev_${randomUUID()}`,
          row.message_send_id,
          row.campaign_id,
          row.sequence_enrollment_id,
          row.contact_id,
          row.target_url,
        ],
      );

      if (isFirstClick && row.campaign_id) {
        await tx.query(
          `UPDATE campaigns SET clicked_count = clicked_count + 1, updated_at = NOW() WHERE id = $1`,
          [row.campaign_id],
        );
        if (row.message_send_id) {
          await tx.query(
            `UPDATE campaign_recipients SET clicked_at = COALESCE(clicked_at, NOW()), updated_at = NOW()
             WHERE message_send_id = $1`,
            [row.message_send_id],
          );
        }
      }

      await this.db.addOutboxEvent(tx, {
        eventType: 'recipient.clicked',
        aggregateType: 'contact',
        aggregateId: row.contact_id ?? tokenSha256,
        payload: {
          contactId: row.contact_id,
          campaignId: row.campaign_id,
          sequenceEnrollmentId: row.sequence_enrollment_id,
          linkUrl: row.target_url,
        },
      });

      return { targetUrl: row.target_url };
    });
  }

  // -------------------------------------------------------------------------
  // Contact Profile Outreach History Tab (PRD §4.4)
  // -------------------------------------------------------------------------

  async getContactOutreachHistory(
    user: SessionUser,
    contactId: string,
  ): Promise<{
    enrollments: Record<string, unknown>[];
    campaigns: Record<string, unknown>[];
    sends: Record<string, unknown>[];
  }> {
    const scope = scopeWhere(user, 'contacts.read', { alias: 'c', startParamIndex: 2 });
    const contactRes = await this.db.query<{ id: string }>(
      `SELECT c.id FROM contacts c WHERE c.id = $1 AND c.deleted_at IS NULL AND (${scope.sql}) LIMIT 1`,
      [contactId, ...scope.params],
    );
    if (!contactRes.rows[0]) throw new NotFoundDomainError('Contact', contactId);

    const [enrollmentsRes, campaignsRes, sendsRes] = await Promise.all([
      this.db.query<Record<string, unknown>>(
        `SELECT se.*, s.name AS sequence_name, s.market AS sequence_market, u.name AS sender_name
         FROM sequence_enrollments se
         JOIN sequences s ON s.id = se.sequence_id
         LEFT JOIN users u ON u.id = se.sender_user_id
         WHERE se.contact_id = $1
         ORDER BY se.enrolled_at DESC`,
        [contactId],
      ),
      this.db.query<Record<string, unknown>>(
        `SELECT cr.*, c.name AS campaign_name, c.subject AS campaign_subject
         FROM campaign_recipients cr
         JOIN campaigns c ON c.id = cr.campaign_id
         WHERE cr.contact_id = $1
         ORDER BY cr.updated_at DESC`,
        [contactId],
      ),
      this.db.query<Record<string, unknown>>(
        `SELECT id, channel, subject, status, compliance_reason_code, transport_provider, sent_at
         FROM message_sends
         WHERE contact_id = $1
         ORDER BY sent_at DESC
         LIMIT 50`,
        [contactId],
      ),
    ]);

    return {
      enrollments: enrollmentsRes.rows,
      campaigns: campaignsRes.rows,
      sends: sendsRes.rows,
    };
  }
}

export { registerOutreachRoutes } from './routes.js';
