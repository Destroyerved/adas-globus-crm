import { randomUUID } from 'node:crypto';
import {
  CreateCampaignInputSchema,
  CreateSequenceInputSchema,
  EnrollSequenceInputSchema,
  type CreateCampaignInput,
  type CreateSequenceInput,
  type EnrollSequenceInput,
  type MessageChannel,
  type SendableReasonCode,
  type SessionUser,
} from '@adas/shared';
import { addBusinessDays } from '../../platform/calendar/index.js';
import { type DatabaseService } from '../../platform/db/index.js';
import {
  DomainError,
  NotFoundDomainError,
  ValidationDomainError,
} from '../../platform/errors/index.js';
import { type MailpitTransport } from '../../platform/mail-transport/index.js';
import { normalizeEmail } from '../../platform/normalize/index.js';
import { requireCapability, scopeWhere } from '../../platform/scope/index.js';
import { type ComplianceService } from '../compliance/index.js';

export interface SendMessageJobInput {
  idempotencyKey: string;
  channel: MessageChannel;
  recipientEmail: string;
  contactId?: string | null;
  senderUserId?: string;
  sequenceEnrollmentId?: string | null;
  campaignId?: string | null;
  subject: string;
  bodyText: string;
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
}

export class OutreachService {
  constructor(
    private readonly db: DatabaseService,
    private readonly compliance: ComplianceService,
    private readonly transport: MailpitTransport,
  ) {}

  /**
   * PRD §5.1, §6.7 & AGENTS.md §5 / §10 (A18):
   * `executeSendMessageJob` (`send.message` job) is the ONLY code path that writes to `message_sends`,
   * and it ALWAYS calls `checkSendable` (via `evaluateRecipientSendability`) at send time.
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

    // 1. Idempotency check
    const existing = await this.db.query<{
      id: string;
      provider_message_id: string | null;
      compliance_reason_code: SendableReasonCode;
    }>(
      `SELECT id, provider_message_id, compliance_reason_code
       FROM message_sends
       WHERE idempotency_key = $1
       LIMIT 1`,
      [input.idempotencyKey],
    );
    if (existing.rows[0]) {
      return {
        sent: true,
        deduplicated: true,
        reasonCode: existing.rows[0].compliance_reason_code,
        reasonMessage: 'Idempotent replay of already-sent message',
        messageSendId: existing.rows[0].id,
        providerMessageId: existing.rows[0].provider_message_id,
      };
    }

    // 2. Mandatory compliance gate (`checkSendable`)
    const check = await this.compliance.evaluateRecipientSendability({
      email: cleanEmail,
      channel: input.channel,
      senderUserId: input.senderUserId,
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

    // 3. Generate one-click unsubscribe token for commercial messages
    const unsubToken = await this.compliance.createUnsubscribeToken({
      email: cleanEmail,
      contactId: input.contactId ?? null,
      channel: input.channel,
      sourceId: input.sequenceEnrollmentId ?? input.campaignId ?? null,
    });
    const unsubUrl = `https://go.adasglobuspro.com/u/${unsubToken}`;

    const senderRes = input.senderUserId
      ? await this.db.query<{ email: string }>(`SELECT email FROM users WHERE id = $1 LIMIT 1`, [
          input.senderUserId,
        ])
      : { rows: [] };
    const fromEmail = senderRes.rows[0]?.email ?? 'outreach@adasglobuspro.example.com';

    const payload = {
      idempotencyKey: input.idempotencyKey,
      fromEmail,
      toEmail: cleanEmail,
      subject: input.subject,
      bodyText: `${input.bodyText}\n\n---\nADAS Globus Pro · Unsubscribe: ${unsubUrl}`,
      headers: {
        'List-Unsubscribe': `<${unsubUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    };

    const receipt =
      input.channel === 'campaign'
        ? await this.transport.sendCampaignMessage(payload)
        : await this.transport.sendOneToOne(payload);

    // 4. Write to `message_sends` (the ONLY place in the codebase that inserts into `message_sends`)
    const messageSendId = `msnd_${randomUUID()}`;
    await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO message_sends (
           id, idempotency_key, channel, recipient_email, contact_id, sender_user_id,
           sequence_enrollment_id, campaign_id, subject, body_text,
           transport_provider, provider_message_id, status, compliance_reason_code, sent_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6,
           $7, $8, $9, $10,
           $11, $12, 'sent', 'OK', NOW()
         )`,
        [
          messageSendId,
          input.idempotencyKey,
          input.channel,
          cleanEmail,
          input.contactId ?? null,
          input.senderUserId ?? null,
          input.sequenceEnrollmentId ?? null,
          input.campaignId ?? null,
          input.subject,
          payload.bodyText,
          receipt.provider,
          receipt.providerMessageId,
        ],
      );

      if (input.senderUserId) {
        await tx.query(
          `UPDATE mailbox_connections
           SET sent_today_count = sent_today_count + 1, updated_at = NOW()
           WHERE user_id = $1`,
          [input.senderUserId],
        );
      }
    });

    return {
      sent: true,
      deduplicated: false,
      reasonCode: 'OK',
      reasonMessage: check.reasonMessage,
      messageSendId,
      providerMessageId: receipt.providerMessageId,
    };
  }

  // -------------------------------------------------------------------------
  // Phase 4: Inbox Sync & Reply (PRD §4.11, A10 & A11)
  // -------------------------------------------------------------------------

  async listInboxThreads(user: SessionUser): Promise<Record<string, unknown>[]> {
    const scope = scopeWhere(user, 'inbox.read', { alias: 't', startParamIndex: 1 });
    const res = await this.db.query(
      `SELECT t.*, c.full_name AS contact_name, c.primary_email AS contact_email,
              cmp.name AS company_name
       FROM email_threads t
       JOIN contacts c ON c.id = t.contact_id
       LEFT JOIN companies cmp ON cmp.id = t.company_id
       WHERE ${scope.sql}
       ORDER BY t.last_message_at DESC`,
      scope.params,
    );
    return res.rows;
  }

  /**
   * PRD §4.11 & §4.12 (A10 & A15) — Sync inbound/outbound Microsoft 365 message:
   * - ONLY syncs messages where at least one participant matches a known `contact_emails` row.
   * - Ignores internal/personal emails with unknown participants.
   * - On inbound reply from a contact enrolled in an active sequence, automatically stops
   *   the sequence (`status = 'replied'`) and creates a follow-up task for the sender!
   */
  async syncMailboxMessage(input: {
    providerMessageId: string;
    direction: 'inbound' | 'outbound';
    fromEmail: string;
    toEmails: string[];
    subject: string;
    bodyText: string;
    mailboxOwnerUserId?: string;
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

    // Match against known `contact_emails` (PRD §4.11 privacy rule)
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
      // Find or create thread for this contact
      const existingThread = await tx.query<{ id: string }>(
        `SELECT id FROM email_threads WHERE contact_id = $1 ORDER BY last_message_at DESC LIMIT 1`,
        [matched.contact_id],
      );

      let threadId = existingThread.rows[0]?.id ?? null;
      if (!threadId) {
        threadId = `thd_${randomUUID()}`;
        await tx.query(
          `INSERT INTO email_threads (
             id, subject, contact_id, company_id, owner_user_id, team_id, last_message_at, message_count, status
           ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), 1, $7)`,
          [
            threadId,
            input.subject,
            matched.contact_id,
            matched.company_id,
            input.mailboxOwnerUserId ?? matched.owner_user_id,
            matched.team_id,
            input.direction === 'inbound' ? 'replied' : 'open',
          ],
        );
      } else {
        await tx.query(
          `UPDATE email_threads
           SET last_message_at = NOW(),
               message_count = message_count + 1,
               status = CASE WHEN $2 = 'inbound' THEN 'replied' ELSE status END
           WHERE id = $1`,
          [threadId, input.direction],
        );
      }

      const messageId = `msg_${randomUUID()}`;
      await tx.query(
        `INSERT INTO email_messages (
           id, thread_id, provider_message_id, direction, from_email, to_emails,
           subject, body_preview, body_text
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
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
        ],
      );

      let stoppedSequenceEnrollments = 0;
      let followUpTaskId: string | null = null;

      // PRD §4.12 (A15) — Inbound reply stops active sequence enrollments and creates follow-up task
      if (input.direction === 'inbound') {
        const stoppedRes = await tx.query<{ id: string; sender_user_id: string }>(
          `UPDATE sequence_enrollments
           SET status = 'replied',
               stop_reason = 'Recipient replied to outreach',
               next_send_at = NULL,
               stopped_at = NOW()
           WHERE contact_id = $1 AND status IN ('active', 'paused')
           RETURNING id, sender_user_id`,
          [matched.contact_id],
        );
        stoppedSequenceEnrollments = stoppedRes.rowCount;

        if (stoppedSequenceEnrollments > 0) {
          const assigneeId = stoppedRes.rows[0]?.sender_user_id ?? matched.owner_user_id;
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
  // Phase 5a: Sequences (PRD §4.12, A15, A16, A18)
  // -------------------------------------------------------------------------

  async listSequences(): Promise<Record<string, unknown>[]> {
    const res = await this.db.query(
      `SELECT s.*,
              (SELECT COUNT(*)::int FROM sequence_steps st WHERE st.sequence_id = s.id) AS step_count,
              (SELECT COUNT(*)::int FROM sequence_enrollments se WHERE se.sequence_id = s.id AND se.status = 'active') AS active_enrollments
       FROM sequences s
       ORDER BY s.created_at DESC`,
    );
    return res.rows;
  }

  async createSequence(
    user: SessionUser,
    rawInput: CreateSequenceInput,
  ): Promise<Record<string, unknown>> {
    requireCapability(user, 'sequences.write');
    const input = CreateSequenceInputSchema.parse(rawInput);
    const id = `seq_${randomUUID()}`;

    return this.db.transaction(async (tx) => {
      const inserted = await tx.query(
        `INSERT INTO sequences (id, name, market, status, daily_cap_per_mailbox, owner_user_id, team_id)
         VALUES ($1, $2, $3, 'active', $4, $5, $6)
         RETURNING *`,
        [
          id,
          input.name.trim(),
          input.market,
          input.dailyCapPerMailbox,
          user.id,
          user.teamId ?? 'team_us',
        ],
      );

      for (const step of input.steps) {
        await tx.query(
          `INSERT INTO sequence_steps (id, sequence_id, step_order, delay_business_days, subject_template, body_template)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            `stp_${randomUUID()}`,
            id,
            step.stepOrder,
            step.delayBusinessDays,
            step.subjectTemplate,
            step.bodyTemplate,
          ],
        );
      }

      return inserted.rows[0] ?? { id };
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

    const contactRes = await this.db.query<{
      id: string;
      primary_email: string;
      market: 'US' | 'CA' | 'OTHER';
      timezone: string;
    }>(
      `SELECT id, primary_email, market, timezone FROM contacts WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
      [input.contactId],
    );
    const contact = contactRes.rows[0];
    if (!contact) {
      throw new NotFoundDomainError('Contact', input.contactId);
    }

    const check = await this.compliance.evaluateRecipientSendability({
      email: contact.primary_email,
      channel: 'sequence',
      senderUserId: input.senderUserId ?? user.id,
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

    const enrollmentId = `enr_${randomUUID()}`;
    const nextSendDate = addBusinessDays(new Date(), 0, contact.timezone, contact.market);

    await this.db.query(
      `INSERT INTO sequence_enrollments (
         id, sequence_id, contact_id, email, sender_user_id,
         current_step_order, status, next_send_at
       ) VALUES ($1, $2, $3, $4, $5, 1, 'active', $6)`,
      [
        enrollmentId,
        input.sequenceId,
        contact.id,
        contact.primary_email,
        input.senderUserId ?? user.id,
        nextSendDate.toISOString(),
      ],
    );

    return {
      enrollmentId,
      status: 'active',
      nextSendAt: nextSendDate.toISOString(),
    };
  }

  async executeSequenceEnrollmentStep(
    enrollmentId: string,
    options: { bypassSendWindow?: boolean; now?: Date } = {},
  ): Promise<SendMessageJobResult> {
    const enrRes = await this.db.query<{
      id: string;
      sequence_id: string;
      contact_id: string;
      email: string;
      sender_user_id: string;
      current_step_order: number;
      status: string;
      first_name: string;
      company_name: string | null;
    }>(
      `SELECT se.*, c.first_name, cmp.name AS company_name
       FROM sequence_enrollments se
       JOIN contacts c ON c.id = se.contact_id
       LEFT JOIN companies cmp ON cmp.id = c.company_id
       WHERE se.id = $1
       LIMIT 1`,
      [enrollmentId],
    );
    const enrollment = enrRes.rows[0];
    if (!enrollment) {
      throw new NotFoundDomainError('SequenceEnrollment', enrollmentId);
    }

    const stepRes = await this.db.query<{
      id: string;
      step_order: number;
      subject_template: string;
      body_template: string;
    }>(
      `SELECT id, step_order, subject_template, body_template
       FROM sequence_steps
       WHERE sequence_id = $1 AND step_order = $2
       LIMIT 1`,
      [enrollment.sequence_id, enrollment.current_step_order],
    );
    const step = stepRes.rows[0];
    if (!step) {
      throw new NotFoundDomainError('SequenceStep', String(enrollment.current_step_order));
    }

    const renderTemplate = (tpl: string) =>
      tpl
        .replace(/\{\{\s*contact\.first_name\s*\}\}/g, enrollment.first_name)
        .replace(/\{\{\s*company\.name\s*\}\}/g, enrollment.company_name ?? 'your firm');

    const sendResult = await this.executeSendMessageJob({
      idempotencyKey: `seq_${enrollment.id}_step_${step.step_order}`,
      channel: 'sequence',
      recipientEmail: enrollment.email,
      contactId: enrollment.contact_id,
      senderUserId: enrollment.sender_user_id,
      sequenceEnrollmentId: enrollment.id,
      subject: renderTemplate(step.subject_template),
      bodyText: renderTemplate(step.body_template),
      bypassSendWindow: options.bypassSendWindow ?? true,
      now: options.now,
    });

    if (sendResult.sent) {
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
        await this.db.query(
          `UPDATE sequence_enrollments
           SET current_step_order = $2,
               next_send_at = NOW() + ($3 || ' days')::interval
           WHERE id = $1`,
          [enrollment.id, nextStep.step_order, String(nextStep.delay_business_days)],
        );
      } else {
        await this.db.query(
          `UPDATE sequence_enrollments
           SET status = 'completed', next_send_at = NULL, completed_at = NOW()
           WHERE id = $1`,
          [enrollment.id],
        );
      }
    }

    return sendResult;
  }

  /**
   * PRD §4.12 (A16) — Hard bounce handling: adds a `hard_bounce` suppression,
   * marks active sequence enrollments `bounced`, and blocks all future sends.
   */
  async handleHardBounce(
    email: string,
    diagnostic = '550 5.1.1 User unknown',
  ): Promise<{
    suppressed: boolean;
    stoppedEnrollments: number;
  }> {
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
  // Phase 5b: Campaigns & Deliverability Auto-Pause (PRD §4.13, A19 & A20)
  // -------------------------------------------------------------------------

  async listCampaigns(): Promise<Record<string, unknown>[]> {
    const res = await this.db.query(`SELECT * FROM campaigns ORDER BY created_at DESC`);
    return res.rows;
  }

  async createCampaign(
    user: SessionUser,
    rawInput: CreateCampaignInput,
  ): Promise<Record<string, unknown>> {
    requireCapability(user, 'campaigns.write');
    const input = CreateCampaignInputSchema.parse(rawInput);
    const id = `cmpg_${randomUUID()}`;

    const res = await this.db.query(
      `INSERT INTO campaigns (
         id, name, subject, body_html, market, status, list_id, owner_user_id, team_id
       ) VALUES ($1, $2, $3, $4, $5, 'pending_approval', $6, $7, $8)
       RETURNING *`,
      [
        id,
        input.name.trim(),
        input.subject.trim(),
        input.bodyHtml,
        input.market,
        input.listId ?? null,
        user.id,
        user.teamId ?? 'team_us',
      ],
    );
    return res.rows[0] ?? { id };
  }

  /**
   * PRD §4.13 & §15 Q12 (A19) — Only a user with `campaigns.approve` (Marketing Manager or Admin)
   * can approve a campaign. BDR/SDR, AE, and Sales Manager are rejected with 403 Forbidden.
   */
  async approveCampaign(user: SessionUser, campaignId: string): Promise<Record<string, unknown>> {
    requireCapability(user, 'campaigns.approve');

    return this.db.transaction(async (tx) => {
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
      });

      return campaign;
    });
  }

  /**
   * PRD §4.13 (A20) — Campaign deliverability monitor & auto-pause:
   * Immediately pauses the campaign (`status = 'paused_deliverability'`) if
   * hard bounce rate exceeds 3% (`0.03`) or spam complaint rate exceeds 0.1% (`0.001`).
   */
  async recordCampaignMetricsAndCheckThresholds(
    campaignId: string,
    metrics: {
      sentCount: number;
      deliveredCount: number;
      bouncedCount: number;
      complainedCount: number;
      unsubscribedCount?: number;
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

    const bounceRate = metrics.bouncedCount / metrics.sentCount;
    const complaintRate = metrics.complainedCount / metrics.sentCount;

    let pausedReason: string | null = null;
    if (bounceRate > 0.03) {
      pausedReason = `Auto-paused: hard bounce rate ${(bounceRate * 100).toFixed(2)}% exceeded 3.00% threshold`;
    } else if (complaintRate > 0.001) {
      pausedReason = `Auto-paused: complaint rate ${(complaintRate * 100).toFixed(2)}% exceeded 0.10% threshold`;
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
}
