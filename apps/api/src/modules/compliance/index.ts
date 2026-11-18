import { randomBytes, randomUUID } from 'node:crypto';
import {
  AddSuppressedDomainInputSchema,
  AddSuppressionInputSchema,
  CheckSendableInputSchema,
  LiftSuppressionInputSchema,
  PrivacyEraseInputSchema,
  RecordConsentInputSchema,
  RemoveSuppressedDomainInputSchema,
  SuppressionListQuerySchema,
  WithdrawConsentInputSchema,
  type CheckSendableInput,
  type CheckSendableResult,
  type ConsentBasis,
  type Market,
  type MessageChannel,
  type SessionUser,
  type SuppressionReason,
} from '@adas/shared';
import { isWithinSendWindow } from '../../platform/calendar/index.js';
import { CSV_BOM, csvLine } from '../../platform/csv/index.js';
import { type DatabaseService, sha256Hex, type DbTx } from '../../platform/db/index.js';
import {
  DomainError,
  NotFoundDomainError,
  ValidationDomainError,
} from '../../platform/errors/index.js';
import {
  extractDomainFromEmail,
  isFreeMailDomain,
  normalizeDomain,
  normalizeEmail,
} from '../../platform/normalize/index.js';
import { requireCapability, scopeWhere } from '../../platform/scope/index.js';

export interface MarketComplianceRule {
  market: Market;
  regulation: string;
  requiresPriorConsentForColdOutreach: boolean;
  allowedBases: readonly ConsentBasis[];
  impliedInquiryMonths: number | null;
  impliedEbrMonths: number | null;
  requiresPhysicalAddress: boolean;
  requiresOneClickUnsubscribe: boolean;
}

/**
 * PRD §5.2 & AGENTS.md §10 — Market rules are data, not scattered if statements.
 */
export const MARKET_COMPLIANCE_RULES: Record<Market, MarketComplianceRule> = {
  US: {
    market: 'US',
    regulation: 'CAN-SPAM Act (15 U.S.C. § 7701)',
    requiresPriorConsentForColdOutreach: false,
    allowedBases: [
      'express',
      'implied_inquiry',
      'implied_ebr',
      'implied_published',
      'legitimate_interest_b2b',
    ],
    impliedInquiryMonths: null,
    impliedEbrMonths: null,
    requiresPhysicalAddress: true,
    requiresOneClickUnsubscribe: true,
  },
  CA: {
    market: 'CA',
    regulation: 'Canada Anti-Spam Legislation (CASL, S.C. 2010, c. 23)',
    requiresPriorConsentForColdOutreach: true,
    allowedBases: ['express', 'implied_inquiry', 'implied_ebr', 'implied_published'],
    impliedInquiryMonths: 6,
    impliedEbrMonths: 24,
    requiresPhysicalAddress: true,
    requiresOneClickUnsubscribe: true,
  },
  OTHER: {
    market: 'OTHER',
    regulation: 'Strict Opt-In Default (Non-US/CA Market)',
    requiresPriorConsentForColdOutreach: true,
    allowedBases: ['express'],
    impliedInquiryMonths: null,
    impliedEbrMonths: null,
    requiresPhysicalAddress: true,
    requiresOneClickUnsubscribe: true,
  },
};

/**
 * PRD §5.1 — Single compliance gate for every outbound message.
 * Every reason code in PRD §5.1 is deterministic and unit-tested.
 */
export function checkSendable(rawInput: CheckSendableInput): CheckSendableResult {
  const input = CheckSendableInputSchema.parse(rawInput);
  const nowIso = input.nowIso ?? new Date().toISOString();
  const nowMs = new Date(nowIso).getTime();
  const normalizedEmail = normalizeEmail(input.email);

  const reject = (
    reasonCode: CheckSendableResult['reasonCode'],
    reasonMessage: string,
  ): CheckSendableResult => ({
    sendable: false,
    reasonCode,
    reasonMessage,
    market: input.market,
    evaluatedAt: nowIso,
  });

  if (!normalizedEmail) {
    return reject(
      'INVALID_EMAIL',
      'Recipient email address is syntactically invalid or failed verification.',
    );
  }

  if (input.suppressedEmail) {
    return reject('SUPPRESSED_EMAIL', 'Recipient email is on the global suppression list.');
  }

  if (input.suppressedDomain) {
    return reject('SUPPRESSED_DOMAIN', 'Recipient domain is on the suppressed domains list.');
  }

  if (input.emailVerificationStatus === 'invalid') {
    return reject(
      'INVALID_EMAIL',
      'Recipient email address is syntactically invalid or failed verification.',
    );
  }

  if (
    input.channel === 'campaign' &&
    input.excludeUnverifiedInCampaigns &&
    (input.emailVerificationStatus === 'unknown' || input.emailVerificationStatus === 'risky')
  ) {
    return reject(
      'EMAIL_UNVERIFIED_OR_RISKY',
      'Contacts with unknown or risky email verification are excluded from campaigns.',
    );
  }

  if (input.unsubscribed) {
    return reject('UNSUBSCRIBED', 'Recipient has unsubscribed from outreach and marketing emails.');
  }

  if (input.complained) {
    return reject('COMPLAINED', 'Recipient previously reported a spam complaint.');
  }

  if (input.hardBounced) {
    return reject('HARD_BOUNCED', 'Recipient email previously hard-bounced.');
  }

  if (input.contactDoNotContact || input.companyAccountStatus === 'do_not_contact') {
    return reject('DO_NOT_CONTACT', 'Contact or company is marked Do Not Contact.');
  }

  if (input.consent?.status === 'revoked') {
    return reject('CONSENT_REVOKED', 'Recipient revoked marketing consent.');
  }

  if (input.consent) {
    if (input.consent.status === 'expired') {
      return reject('CONSENT_EXPIRED', 'Recipient implied consent has expired.');
    }
    if (input.consent.expiresAt && new Date(input.consent.expiresAt).getTime() <= nowMs) {
      return reject(
        'CONSENT_EXPIRED',
        'Recipient implied consent expiration timestamp has passed.',
      );
    }
  }

  const rule = MARKET_COMPLIANCE_RULES[input.market];
  if (input.channel !== 'transactional') {
    if (input.market === 'OTHER' && input.consent?.basis !== 'express') {
      return reject(
        'MARKET_BLOCKED',
        'Non-US/CA market requires explicit express opt-in consent before outreach.',
      );
    }

    if (rule.requiresPriorConsentForColdOutreach) {
      if (!input.consent || !rule.allowedBases.includes(input.consent.basis)) {
        return reject(
          'NO_LAWFUL_BASIS',
          `Market ${input.market} (${rule.regulation}) requires an active Express or CASL Implied consent basis.`,
        );
      }
    }
  }

  if (input.alreadySentThisStep) {
    return reject(
      'ALREADY_SENT_THIS_STEP',
      'This sequence step or campaign message has already been sent to this recipient.',
    );
  }

  if (input.inOtherActiveSequence) {
    return reject(
      'IN_OTHER_ACTIVE_SEQUENCE',
      'Recipient is already enrolled in another active sequence.',
    );
  }

  if (input.sequenceInactive) {
    return reject('SEQUENCE_INACTIVE', 'Sequence is paused, draft, or archived.');
  }

  if (input.campaignNotApproved) {
    return reject('CAMPAIGN_NOT_APPROVED', 'Campaign has not been approved by a second reviewer.');
  }

  if (input.campaignPaused) {
    return reject('CAMPAIGN_PAUSED', 'Campaign is paused or cancelled.');
  }

  if (input.senderNotVerified) {
    return reject(
      'SENDER_NOT_VERIFIED',
      'Sender identity SPF, DKIM, and DMARC records are not verified.',
    );
  }

  if (input.mailboxDisconnected) {
    return reject(
      'MAILBOX_DISCONNECTED',
      'Sender mailbox is disconnected or requires reconnection.',
    );
  }

  if (input.channel === 'sequence' || input.channel === 'campaign') {
    if (input.sendsInLast7Days >= input.maxSendsPer7Days) {
      return reject(
        'FREQUENCY_CAP',
        `Recipient has already received ${input.sendsInLast7Days} outreach messages in the frequency window (cap: ${input.maxSendsPer7Days}).`,
      );
    }
  }

  if (input.channel === 'sequence' || input.channel === 'one_to_one') {
    if (input.mailboxSendsToday >= input.mailboxDailyCap) {
      return reject(
        'MAILBOX_DAILY_CAP',
        `Sender mailbox has reached its daily cap of ${input.mailboxDailyCap} sends.`,
      );
    }
  }

  if (input.channel === 'sequence' || input.channel === 'campaign') {
    if (!input.bypassSendWindow && !input.withinSendWindow) {
      return reject(
        'OUTSIDE_SEND_WINDOW',
        'Current time is outside the recipient local business-day send window.',
      );
    }
  }

  return {
    sendable: true,
    reasonCode: 'OK',
    reasonMessage: `Eligible to send under ${rule.regulation}.`,
    market: input.market,
    evaluatedAt: nowIso,
  };
}

const BASIS_LABEL: Record<ConsentBasis, string> = {
  express: 'Express opt-in',
  implied_inquiry: 'Implied consent (inquiry)',
  implied_ebr: 'Implied consent (client relationship)',
  implied_published: 'Implied consent (published business address)',
  legitimate_interest_b2b: 'US business outreach',
};

function parseCursor(raw: string | undefined): [string | null, string] {
  if (!raw) return [null, ''];
  const split = raw.lastIndexOf('|');
  const at = split > 0 ? raw.slice(0, split) : raw;
  const id = split > 0 ? raw.slice(split + 1) : '';
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)?$/.test(at)) {
    return [null, ''];
  }
  return [at, id];
}

function escapeIlike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

function isoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value.trim()) return value;
  return '';
}

export class ComplianceService {
  constructor(private readonly db: DatabaseService) {}

  async evaluateRecipientSendability(options: {
    email: string;
    channel: MessageChannel;
    senderUserId?: string;
    senderIdentityId?: string | null;
    sequenceId?: string | null;
    campaignId?: string | null;
    mailboxDailyCapOverride?: number | null;
    sendWindowStartMinutes?: number;
    sendWindowEndMinutes?: number;
    excludeUnverifiedInCampaigns?: boolean;
    requireConnectedMailbox?: boolean;
    bypassSendWindow?: boolean;
    now?: Date;
  }): Promise<CheckSendableResult> {
    const now = options.now ?? new Date();
    const nowIso = now.toISOString();
    const cleanEmail = normalizeEmail(options.email) ?? options.email.trim().toLowerCase();
    const emailHash = sha256Hex(cleanEmail);
    const domain = extractDomainFromEmail(cleanEmail);

    const [
      supEmailRes,
      supDomainRes,
      contactRes,
      consentRes,
      freqRes,
      senderCapRes,
      senderIdRes,
      seqRes,
      cmpgRes,
    ] = await Promise.all([
      this.db.query<{ id: string }>(
        `SELECT id FROM suppressions
           WHERE (email = $1 OR email_sha256 = $2) AND lifted_at IS NULL
           LIMIT 1`,
        [cleanEmail, emailHash],
      ),
      domain
        ? this.db.query<{ id: string }>(
            `SELECT id FROM suppressed_domains WHERE domain = $1 LIMIT 1`,
            [domain],
          )
        : Promise.resolve({ rows: [], rowCount: 0 }),
      this.db.query<{
        id: string;
        market: Market;
        timezone: string;
        do_not_contact: boolean;
        email_verification_status: 'unknown' | 'valid' | 'risky' | 'invalid';
        hard_bounced_at: string | null;
        account_status:
          'prospect' | 'client' | 'former_client' | 'partner' | 'do_not_contact' | null;
      }>(
        `SELECT c.id, c.market, c.timezone, c.do_not_contact,
                  c.email_verification_status, c.hard_bounced_at,
                  cmp.account_status
           FROM contacts c
           LEFT JOIN companies cmp ON cmp.id = c.company_id
           LEFT JOIN contact_emails ce ON ce.contact_id = c.id
           WHERE (c.primary_email = $1 OR ce.email = $1) AND c.deleted_at IS NULL
           LIMIT 1`,
        [cleanEmail],
      ),
      this.db.query<{
        basis: ConsentBasis;
        status: 'active' | 'expired' | 'revoked';
        expires_at: string | null;
        captured_at: string;
      }>(
        `SELECT basis, status, expires_at, captured_at
           FROM consent_records
           WHERE email = $1
           ORDER BY created_at DESC
           LIMIT 1`,
        [cleanEmail],
      ),
      this.db.query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt
           FROM message_sends
           WHERE recipient_email = $1
             AND channel IN ('sequence', 'campaign')
             AND sent_at >= $2::timestamptz - INTERVAL '7 days'`,
        [cleanEmail, nowIso],
      ),
      options.senderUserId
        ? this.db.query<{
            cnt: number;
            cap: number;
            mbx_status: string | null;
            mbx_sent_today: number | null;
          }>(
            `SELECT
                 (SELECT COUNT(*)::int FROM message_sends WHERE sender_user_id = $1 AND sent_at >= date_trunc('day', $2::timestamptz)) AS cnt,
                 COALESCE(
                   (SELECT daily_send_cap FROM mailbox_connections WHERE user_id = $1),
                   (SELECT daily_send_cap FROM users WHERE id = $1),
                   50
                 ) AS cap,
                 (SELECT status FROM mailbox_connections WHERE user_id = $1 LIMIT 1) AS mbx_status,
                 (SELECT sent_today_count FROM mailbox_connections WHERE user_id = $1 LIMIT 1) AS mbx_sent_today`,
            [options.senderUserId, nowIso],
          )
        : Promise.resolve({
            rows: [{ cnt: 0, cap: 50, mbx_status: null, mbx_sent_today: null }],
            rowCount: 1,
          }),
      options.senderIdentityId
        ? this.db.query<{
            verified_at: Date | string | null;
            spf_verified: boolean;
            dkim_verified: boolean;
            dmarc_verified: boolean;
          }>(
            `SELECT verified_at, spf_verified, dkim_verified, dmarc_verified
               FROM sender_identities WHERE id = $1 LIMIT 1`,
            [options.senderIdentityId],
          )
        : Promise.resolve({ rows: [], rowCount: 0 }),
      options.sequenceId
        ? this.db.query<{ status: string }>(`SELECT status FROM sequences WHERE id = $1 LIMIT 1`, [
            options.sequenceId,
          ])
        : Promise.resolve({ rows: [], rowCount: 0 }),
      options.campaignId
        ? this.db.query<{ status: string; approved_at: Date | string | null }>(
            `SELECT status, approved_at FROM campaigns WHERE id = $1 LIMIT 1`,
            [options.campaignId],
          )
        : Promise.resolve({ rows: [], rowCount: 0 }),
    ]);

    const contact = contactRes.rows[0];
    const consentRow = consentRes.rows[0];
    const market: Market = contact?.market ?? 'US';
    const timezone = contact?.timezone ?? 'America/New_York';
    const withinWindow = isWithinSendWindow(
      now,
      timezone,
      market,
      options.sendWindowStartMinutes ?? 8 * 60,
      options.sendWindowEndMinutes ?? 17 * 60,
    );

    const senderCapRow = senderCapRes.rows[0];
    const mbxStatus = senderCapRow?.mbx_status ?? null;
    const mailboxDisconnected =
      mbxStatus !== null ? mbxStatus !== 'connected' : Boolean(options.requireConnectedMailbox);

    const senderIdentity = senderIdRes.rows[0];
    const senderNotVerified = options.senderIdentityId
      ? !senderIdentity ||
        !senderIdentity.verified_at ||
        !senderIdentity.spf_verified ||
        !senderIdentity.dkim_verified ||
        !senderIdentity.dmarc_verified
      : false;

    const seqStatus = seqRes.rows[0]?.status;
    const sequenceInactive = options.sequenceId ? seqStatus !== 'active' : false;

    const cmpgRow = cmpgRes.rows[0];
    const campaignPaused = options.campaignId
      ? cmpgRow?.status === 'paused' ||
        cmpgRow?.status === 'paused_deliverability' ||
        cmpgRow?.status === 'cancelled'
      : false;
    const campaignNotApproved =
      options.campaignId && !campaignPaused
        ? !cmpgRow ||
          cmpgRow.status === 'draft' ||
          cmpgRow.status === 'pending_approval' ||
          !cmpgRow.approved_at
        : false;

    const effectiveCap =
      options.mailboxDailyCapOverride && options.mailboxDailyCapOverride > 0
        ? Math.min(options.mailboxDailyCapOverride, senderCapRow?.cap ?? 50)
        : (senderCapRow?.cap ?? 50);

    return checkSendable({
      email: cleanEmail,
      channel: options.channel,
      market,
      contactDoNotContact: contact?.do_not_contact ?? false,
      companyAccountStatus: contact?.account_status ?? 'prospect',
      emailVerificationStatus: contact?.email_verification_status ?? 'unknown',
      excludeUnverifiedInCampaigns: options.excludeUnverifiedInCampaigns ?? false,
      hardBounced: Boolean(contact?.hard_bounced_at),
      suppressedEmail: supEmailRes.rows.length > 0,
      suppressedDomain: supDomainRes.rows.length > 0,
      sequenceInactive,
      campaignNotApproved,
      campaignPaused,
      senderNotVerified,
      mailboxDisconnected,
      consent: consentRow
        ? {
            basis: consentRow.basis,
            status: consentRow.status,
            expiresAt: consentRow.expires_at ? new Date(consentRow.expires_at).toISOString() : null,
            capturedAt: new Date(consentRow.captured_at).toISOString(),
          }
        : null,
      sendsInLast7Days: freqRes.rows[0]?.cnt ?? 0,
      maxSendsPer7Days: 3,
      mailboxSendsToday: senderCapRow?.cnt ?? 0,
      mailboxDailyCap: effectiveCap,
      withinSendWindow: withinWindow,
      bypassSendWindow: options.bypassSendWindow ?? true,
      nowIso,
    });
  }

  async addSuppression(
    options: {
      email: string;
      reason: SuppressionReason;
      source: string;
      notes?: string;
      actorUserId?: string | null;
      ipAddress?: string | null;
    },
    existingTx?: DbTx,
  ): Promise<{
    id: string;
    email: string | null;
    emailSha256: string;
    stoppedEnrollments: number;
  }> {
    const cleanEmail = normalizeEmail(options.email);
    if (!cleanEmail) {
      throw new ValidationDomainError('Enter a valid email address.', {
        email: ['Enter a valid email address.'],
      });
    }
    const emailSha256 = sha256Hex(cleanEmail);
    const isErasure = options.reason === 'privacy_erasure';

    const runInTx = async (tx: DbTx) => {
      const existing = await tx.query<{ id: string; reason: string }>(
        `SELECT id, reason FROM suppressions WHERE email_sha256 = $1 LIMIT 1 FOR UPDATE`,
        [emailSha256],
      );
      if (existing.rows[0]?.reason === 'privacy_erasure' && !isErasure) {
        throw new DomainError({
          status: 409,
          code: 'PRIVACY_ERASED',
          title: 'Address permanently suppressed',
          detail:
            'This email address was erased after a privacy request and is already permanently suppressed.',
          fieldErrors: {
            email: ['This address is already permanently suppressed after a privacy erasure.'],
          },
        });
      }

      const id = `sup_${randomUUID()}`;
      const storedEmail = isErasure ? null : cleanEmail;
      const storedNotes = isErasure ? null : options.notes?.trim() || null;
      const upserted = await tx.query<{ id: string }>(
        `INSERT INTO suppressions (id, email, email_sha256, reason, source, notes, actor_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (email_sha256) DO UPDATE
           SET email = EXCLUDED.email,
               reason = EXCLUDED.reason,
               source = EXCLUDED.source,
               notes = EXCLUDED.notes,
               actor_user_id = EXCLUDED.actor_user_id,
               lifted_at = NULL,
               lifted_by = NULL,
               lifted_reason = NULL
         RETURNING id`,
        [
          id,
          storedEmail,
          emailSha256,
          options.reason,
          options.source,
          storedNotes,
          options.actorUserId ?? null,
        ],
      );
      const suppressionId = upserted.rows[0]?.id ?? id;

      await tx.query(
        `UPDATE contacts
         SET do_not_contact = TRUE,
             hard_bounced_at = CASE WHEN $2 = 'hard_bounce' THEN NOW() ELSE hard_bounced_at END,
             version = version + 1,
             updated_at = NOW()
         WHERE (primary_email = $1 OR id IN (SELECT contact_id FROM contact_emails WHERE email = $1))
           AND deleted_at IS NULL`,
        [cleanEmail, options.reason],
      );

      await tx.query(
        `UPDATE consent_records
         SET status = 'revoked', revoked_at = NOW()
         WHERE email = $1 AND status = 'active'`,
        [cleanEmail],
      );

      const newEnrollmentStatus =
        options.reason === 'hard_bounce'
          ? 'bounced'
          : options.reason === 'unsubscribe'
            ? 'unsubscribed'
            : 'stopped_suppressed';

      const stopped = await tx.query<{ id: string }>(
        `UPDATE sequence_enrollments
         SET status = $2,
             stop_reason = $3,
             next_send_at = NULL,
             stopped_at = NOW()
         WHERE email = $1 AND status IN ('active', 'paused')
         RETURNING id`,
        [cleanEmail, newEnrollmentStatus, `Suppressed (${options.reason})`],
      );

      await tx.query(
        `UPDATE campaign_recipients
         SET status = 'skipped_compliance', reason_code = 'SUPPRESSED_EMAIL'
         WHERE email = $1 AND status = 'queued'`,
        [cleanEmail],
      );

      await this.db.writeAuditLog(tx, {
        actorUserId: options.actorUserId ?? null,
        action: 'compliance.suppression_added',
        entityType: 'suppression',
        entityId: suppressionId,
        metadata: {
          reason: options.reason,
          source: options.source,
          emailSha256,
          stoppedEnrollments: stopped.rowCount,
        },
        ipAddress: options.ipAddress ?? null,
      });

      await this.db.addOutboxEvent(tx, {
        eventType: 'suppression.added',
        aggregateType: 'suppression',
        aggregateId: suppressionId,
        payload: {
          suppressionId,
          emailSha256,
          reason: options.reason,
          stoppedEnrollments: stopped.rowCount,
        },
      });

      return {
        id: suppressionId,
        email: storedEmail,
        emailSha256,
        stoppedEnrollments: stopped.rowCount,
      };
    };

    if (existingTx) {
      return runInTx(existingTx);
    }
    return this.db.transaction(runInTx);
  }

  /**
   * Manual suppression from Settings -> Suppressions (PRD 4.17, 5.6).
   */
  async addManualSuppression(user: SessionUser, rawInput: unknown, ip: string | null) {
    requireCapability(user, 'compliance.manage');
    const input = AddSuppressionInputSchema.parse(rawInput);
    return this.addSuppression({
      email: input.email,
      reason: input.reason,
      source: input.source,
      notes: input.notes,
      actorUserId: user.id,
      ipAddress: ip,
    });
  }

  /**
   * Keyset-paged suppression list (PRD 4.17, 5.6). When `q` contains an email address,
   * also checks `email_sha256` so an admin can verify whether an address is blocked under a
   * permanent privacy-erasure hash without storing or exposing cleartext emails.
   */
  async listSuppressions(
    user: SessionUser,
    rawQuery: Record<string, unknown> = {},
  ): Promise<{ items: Record<string, unknown>[]; nextCursor: string | null; total: number }> {
    requireCapability(user, 'compliance.manage');
    const query = SuppressionListQuerySchema.parse(rawQuery);
    const [cursorAt, cursorId] = parseCursor(query.cursor);
    const conditions: string[] = ['1 = 1'];
    const params: unknown[] = [];
    const addParam = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };

    if (query.state === 'active') {
      conditions.push('s.lifted_at IS NULL');
    } else if (query.state === 'lifted') {
      conditions.push('s.lifted_at IS NOT NULL');
    }

    if (query.reason) {
      conditions.push(`s.reason = ${addParam(query.reason)}`);
    }

    if (query.q) {
      const pattern = `%${escapeIlike(query.q.toLowerCase())}%`;
      const pLike = addParam(pattern);
      const normalized = normalizeEmail(query.q);
      if (normalized) {
        const pHash = addParam(sha256Hex(normalized));
        conditions.push(`(s.email ILIKE ${pLike} ESCAPE '\\' OR s.email_sha256 = ${pHash})`);
      } else {
        const pPrefix = addParam(`${query.q.toLowerCase()}%`);
        conditions.push(`(s.email ILIKE ${pLike} ESCAPE '\\' OR s.email_sha256 LIKE ${pPrefix})`);
      }
    }

    const filterWhere = conditions.join(' AND ');
    const filterParams = [...params];

    if (cursorAt) {
      const pAt = addParam(cursorAt);
      const pId = addParam(cursorId);
      conditions.push(`(s.created_at, s.id) < (${pAt}::timestamptz, ${pId}::text)`);
    }

    const [res, countRes] = await Promise.all([
      this.db.query<Record<string, unknown> & { id: string; cursor_at: string }>(
        `SELECT s.id, s.email, s.email_sha256, s.reason, s.source, s.notes,
                s.actor_user_id, u_add.name AS actor_name,
                s.lifted_at, s.lifted_by, u_lift.name AS lifted_by_name, s.lifted_reason,
                s.created_at, s.created_at::text AS cursor_at
         FROM suppressions s
         LEFT JOIN users u_add ON u_add.id = s.actor_user_id
         LEFT JOIN users u_lift ON u_lift.id = s.lifted_by
         WHERE ${conditions.join(' AND ')}
         ORDER BY s.created_at DESC, s.id DESC
         LIMIT ${query.limit + 1}`,
        params,
      ),
      this.db.query<{ total: number }>(
        `SELECT COUNT(*)::int AS total FROM suppressions s WHERE ${filterWhere}`,
        filterParams,
      ),
    ]);

    const hasMore = res.rows.length > query.limit;
    const rows = hasMore ? res.rows.slice(0, query.limit) : res.rows;
    const last = rows[rows.length - 1];
    const items = rows.map((row) => ({
      id: String(row['id']),
      email: (row['email'] as string | null) ?? null,
      emailSha256: String(row['email_sha256'] ?? ''),
      reason: String(row['reason']),
      source: String(row['source'] ?? ''),
      notes: (row['notes'] as string | null) ?? null,
      createdByUserId: (row['actor_user_id'] as string | null) ?? null,
      createdByName: (row['actor_name'] as string | null) ?? null,
      createdAt: isoString(row['created_at']),
      liftedAt: row['lifted_at'] ? isoString(row['lifted_at']) : null,
      liftedByUserId: (row['lifted_by'] as string | null) ?? null,
      liftedByName: (row['lifted_by_name'] as string | null) ?? null,
      liftedReason: (row['lifted_reason'] as string | null) ?? null,
      isPermanent: row['reason'] === 'privacy_erasure',
    }));
    return {
      items,
      nextCursor: hasMore && last ? `${last.cursor_at}|${last.id}` : null,
      total: Number(countRes.rows[0]?.total ?? 0),
    };
  }

  /**
   * Lifts an active suppression without deleting the underlying row (PRD 4.17, 5.6, 7.4).
   * Requires `privacy.manage` and a reason; refuses `privacy_erasure` rows permanently.
   */
  async liftSuppression(
    user: SessionUser,
    suppressionId: string,
    rawInput: unknown,
    ip: string | null,
  ): Promise<Record<string, unknown>> {
    requireCapability(user, 'privacy.manage');
    const input = LiftSuppressionInputSchema.parse(rawInput);

    return this.db.transaction(async (tx) => {
      const res = await tx.query<{
        id: string;
        email: string | null;
        email_sha256: string;
        reason: SuppressionReason;
        lifted_at: string | null;
      }>(
        `SELECT id, email, email_sha256, reason, lifted_at
         FROM suppressions
         WHERE id = $1
         FOR UPDATE`,
        [suppressionId],
      );
      const row = res.rows[0];
      if (!row) {
        throw new NotFoundDomainError('Suppression', suppressionId);
      }
      if (row.reason === 'privacy_erasure') {
        throw new DomainError({
          status: 409,
          code: 'PRIVACY_ERASURE_PERMANENT',
          title: 'Permanent suppression',
          detail: 'Privacy erasure suppressions are permanent and cannot be lifted.',
        });
      }
      if (row.lifted_at !== null) {
        throw new DomainError({
          status: 409,
          code: 'ALREADY_LIFTED',
          title: 'Already lifted',
          detail: 'This suppression has already been lifted.',
        });
      }

      const updated = await tx.query(
        `UPDATE suppressions
         SET lifted_at = NOW(),
             lifted_by = $2,
             lifted_reason = $3
         WHERE id = $1
         RETURNING *`,
        [suppressionId, user.id, input.reason],
      );

      if (row.email) {
        const contacts = await tx.query<{ id: string; do_not_contact: boolean }>(
          `SELECT id, do_not_contact
           FROM contacts
           WHERE (primary_email = $1 OR id IN (SELECT contact_id FROM contact_emails WHERE email = $1))
             AND deleted_at IS NULL
           FOR UPDATE`,
          [row.email],
        );
        for (const c of contacts.rows) {
          if (c.do_not_contact) {
            await tx.query(
              `UPDATE contacts
               SET do_not_contact = FALSE,
                   hard_bounced_at = CASE WHEN $2 = 'hard_bounce' THEN NULL ELSE hard_bounced_at END,
                   version = version + 1,
                   updated_at = NOW()
               WHERE id = $1`,
              [c.id, row.reason],
            );
            await this.db.writeRecordHistory(tx, {
              entityType: 'contact',
              entityId: c.id,
              fieldName: 'do_not_contact',
              oldValue: true,
              newValue: false,
              changedByUserId: user.id,
              via: 'ui',
            });
          }
        }
      }

      await this.db.writeAuditLog(tx, {
        actorUserId: user.id,
        actorEmail: user.email,
        action: 'compliance.suppression_lifted',
        entityType: 'suppression',
        entityId: suppressionId,
        metadata: {
          emailSha256: row.email_sha256,
          previousReason: row.reason,
          reason: input.reason,
        },
        ipAddress: ip,
      });

      await this.db.addOutboxEvent(tx, {
        eventType: 'suppression.lifted',
        aggregateType: 'suppression',
        aggregateId: suppressionId,
        payload: {
          suppressionId,
          emailSha256: row.email_sha256,
        },
      });

      return updated.rows[0] ?? { id: suppressionId };
    });
  }

  async addSuppressedDomain(options: {
    domain: string;
    reason: string;
    actorUserId?: string | null;
    ipAddress?: string | null;
  }): Promise<{ id: string; domain: string }> {
    const cleanDomain = normalizeDomain(options.domain);
    if (!cleanDomain) {
      throw new ValidationDomainError('Enter a valid domain such as example.com.', {
        domain: ['Enter a valid domain such as example.com.'],
      });
    }
    if (isFreeMailDomain(cleanDomain)) {
      throw new ValidationDomainError(
        'Shared mailbox providers cannot be blocked as a company domain.',
        {
          domain: ['Suppress individual addresses on free-mail providers instead.'],
        },
      );
    }
    return this.db.transaction(async (tx) => {
      const id = `sdom_${randomUUID()}`;
      const res = await tx.query<{ id: string }>(
        `INSERT INTO suppressed_domains (id, domain, reason, actor_user_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (domain) DO UPDATE
           SET reason = EXCLUDED.reason,
               actor_user_id = EXCLUDED.actor_user_id
         RETURNING id`,
        [id, cleanDomain, options.reason.trim(), options.actorUserId ?? null],
      );
      const finalId = res.rows[0]?.id ?? id;
      await this.db.writeAuditLog(tx, {
        actorUserId: options.actorUserId ?? null,
        action: 'compliance.domain_suppressed',
        entityType: 'suppressed_domain',
        entityId: finalId,
        metadata: { domain: cleanDomain, reason: options.reason.trim() },
        ipAddress: options.ipAddress ?? null,
      });
      return { id: finalId, domain: cleanDomain };
    });
  }

  async listSuppressedDomains(user: SessionUser): Promise<{ items: Record<string, unknown>[] }> {
    requireCapability(user, 'compliance.manage');
    const res = await this.db.query<Record<string, unknown>>(
      `SELECT d.id, d.domain, d.reason, d.actor_user_id, u.name AS actor_name, d.created_at
       FROM suppressed_domains d
       LEFT JOIN users u ON u.id = d.actor_user_id
       ORDER BY d.created_at DESC, d.id DESC
       LIMIT 500`,
    );
    return {
      items: res.rows.map((row) => ({
        id: String(row['id']),
        domain: String(row['domain']),
        reason: String(row['reason'] ?? ''),
        createdByUserId: (row['actor_user_id'] as string | null) ?? null,
        createdByName: (row['actor_name'] as string | null) ?? null,
        createdAt: isoString(row['created_at']),
      })),
    };
  }

  async addManualSuppressedDomain(user: SessionUser, rawInput: unknown, ip: string | null) {
    requireCapability(user, 'compliance.manage');
    const input = AddSuppressedDomainInputSchema.parse(rawInput);
    return this.addSuppressedDomain({
      domain: input.domain,
      reason: input.reason,
      actorUserId: user.id,
      ipAddress: ip,
    });
  }

  async removeSuppressedDomain(
    user: SessionUser,
    domainId: string,
    rawInput: unknown,
    ip: string | null,
  ): Promise<{ id: string; domain: string; removed: true }> {
    requireCapability(user, 'privacy.manage');
    const input = RemoveSuppressedDomainInputSchema.parse(rawInput);

    return this.db.transaction(async (tx) => {
      const existing = await tx.query<{ id: string; domain: string; reason: string }>(
        `SELECT id, domain, reason FROM suppressed_domains WHERE id = $1 FOR UPDATE`,
        [domainId],
      );
      const row = existing.rows[0];
      if (!row) {
        throw new NotFoundDomainError('Suppressed domain', domainId);
      }
      await tx.query(`DELETE FROM suppressed_domains WHERE id = $1`, [domainId]);
      await this.db.writeAuditLog(tx, {
        actorUserId: user.id,
        actorEmail: user.email,
        action: 'compliance.domain_unsuppressed',
        entityType: 'suppressed_domain',
        entityId: domainId,
        metadata: {
          domain: row.domain,
          previousReason: row.reason,
          reason: input.reason,
        },
        ipAddress: ip,
      });
      return { id: domainId, domain: row.domain, removed: true };
    });
  }

  // -------------------------------------------------------------------------
  // Consent records on Contacts (PRD 5.3)
  // -------------------------------------------------------------------------

  async recordContactConsent(
    user: SessionUser,
    contactId: string,
    rawInput: unknown,
    ip: string | null,
  ): Promise<Record<string, unknown>> {
    const scope = scopeWhere(user, 'contacts.write', { alias: 'c', startParamIndex: 2 });
    const input = RecordConsentInputSchema.parse(rawInput);

    return this.db.transaction(async (tx) => {
      const contactRes = await tx.query<{
        id: string;
        primary_email: string;
        market: Market;
        company_id: string | null;
      }>(
        `SELECT c.id, c.primary_email, c.market, c.company_id
         FROM contacts c
         WHERE c.id = $1 AND c.deleted_at IS NULL AND ${scope.sql}
         FOR UPDATE`,
        [contactId, ...scope.params],
      );
      const contact = contactRes.rows[0];
      if (!contact) {
        throw new NotFoundDomainError('Contact', contactId);
      }

      const emailSha256 = sha256Hex(contact.primary_email);
      const domain = extractDomainFromEmail(contact.primary_email);
      const [supRes, domRes] = await Promise.all([
        tx.query<{ id: string }>(
          `SELECT id FROM suppressions
           WHERE (email = $1 OR email_sha256 = $2) AND lifted_at IS NULL
           LIMIT 1`,
          [contact.primary_email, emailSha256],
        ),
        domain
          ? tx.query<{ id: string }>(
              `SELECT id FROM suppressed_domains WHERE domain = $1 LIMIT 1`,
              [domain],
            )
          : Promise.resolve({ rows: [] as { id: string }[] }),
      ]);
      if (supRes.rows.length > 0 || domRes.rows.length > 0) {
        throw new DomainError({
          status: 409,
          code: 'SUPPRESSED_ADDRESS',
          title: 'Address is suppressed',
          detail:
            'Suppression always takes precedence over consent. Lift the suppression in Settings first.',
        });
      }

      const defaultMonths =
        input.basis === 'implied_inquiry' ? 6 : input.basis === 'implied_ebr' ? 24 : null;

      const id = `cns_${randomUUID()}`;
      const inserted = await tx.query(
        `INSERT INTO consent_records (
           id, email, contact_id, market, basis, purpose, status, source, proof_text,
           captured_at, expires_at, recorded_by_user_id
         ) VALUES (
           $1, $2, $3, $4, $5, $6, 'active', $7, $8,
           NOW(),
           CASE
             WHEN $9::timestamptz IS NOT NULL THEN $9::timestamptz
             WHEN $10::int IS NOT NULL THEN NOW() + make_interval(months => $10::int)
             ELSE NULL
           END,
           $11
         )
         RETURNING *`,
        [
          id,
          contact.primary_email,
          contact.id,
          contact.market,
          input.basis,
          input.purpose,
          input.source,
          input.proofText ?? null,
          input.expiresAt ?? null,
          defaultMonths,
          user.id,
        ],
      );

      await tx.query(
        `INSERT INTO activities (
           id, entity_type, entity_id, company_id, contact_id,
           activity_type, title, detail, actor_user_id, metadata
         ) VALUES ($1, 'contact', $2, $3, $2, 'consent', $4, $5, $6, $7::jsonb)`,
        [
          `act_${randomUUID()}`,
          contact.id,
          contact.company_id,
          `Recorded ${BASIS_LABEL[input.basis]}`,
          input.proofText ? `${input.source} — ${input.proofText}` : input.source,
          user.id,
          JSON.stringify({ consentId: id, basis: input.basis, purpose: input.purpose }),
        ],
      );

      await this.db.writeAuditLog(tx, {
        actorUserId: user.id,
        actorEmail: user.email,
        action: 'compliance.consent_recorded',
        entityType: 'contact',
        entityId: contact.id,
        metadata: {
          consentId: id,
          basis: input.basis,
          purpose: input.purpose,
          source: input.source,
        },
        ipAddress: ip,
      });

      return inserted.rows[0] ?? { id };
    });
  }

  async withdrawContactConsent(
    user: SessionUser,
    contactId: string,
    rawInput: unknown,
    ip: string | null,
  ): Promise<{ withdrawn: true; suppressed: boolean }> {
    const scope = scopeWhere(user, 'contacts.write', { alias: 'c', startParamIndex: 2 });
    const input = WithdrawConsentInputSchema.parse(rawInput);

    return this.db.transaction(async (tx) => {
      const contactRes = await tx.query<{
        id: string;
        primary_email: string;
        market: Market;
        company_id: string | null;
      }>(
        `SELECT c.id, c.primary_email, c.market, c.company_id
         FROM contacts c
         WHERE c.id = $1 AND c.deleted_at IS NULL AND ${scope.sql}
         FOR UPDATE`,
        [contactId, ...scope.params],
      );
      const contact = contactRes.rows[0];
      if (!contact) {
        throw new NotFoundDomainError('Contact', contactId);
      }

      const revoked = await tx.query<{ id: string; basis: ConsentBasis }>(
        `UPDATE consent_records
         SET status = 'revoked',
             revoked_at = NOW(),
             revoked_reason = $3
         WHERE (contact_id = $1 OR email = $2) AND status = 'active'
         RETURNING id, basis`,
        [contact.id, contact.primary_email, input.reason],
      );

      if (revoked.rowCount === 0) {
        await tx.query(
          `INSERT INTO consent_records (
             id, email, contact_id, market, basis, purpose, status, source,
             proof_text, captured_at, revoked_at, revoked_reason, recorded_by_user_id
           ) VALUES (
             $1, $2, $3, $4, 'legitimate_interest_b2b', 'marketing', 'revoked',
             'manual_withdrawal', $5, NOW(), NOW(), $5, $6
           )`,
          [
            `cns_${randomUUID()}`,
            contact.primary_email,
            contact.id,
            contact.market,
            input.reason,
            user.id,
          ],
        );
      }

      if (input.suppressAddress) {
        await this.addSuppression(
          {
            email: contact.primary_email,
            reason: 'unsubscribe',
            source: 'consent_withdrawn',
            notes: input.reason,
            actorUserId: user.id,
            ipAddress: ip,
          },
          tx,
        );
      } else {
        await tx.query(
          `UPDATE sequence_enrollments
           SET status = 'unsubscribed',
               stop_reason = 'Consent withdrawn',
               next_send_at = NULL,
               stopped_at = NOW()
           WHERE (contact_id = $1 OR email = $2) AND status IN ('active', 'paused')`,
          [contact.id, contact.primary_email],
        );
        await tx.query(
          `UPDATE campaign_recipients
           SET status = 'skipped_compliance', reason_code = 'CONSENT_REVOKED'
           WHERE email = $1 AND status = 'queued'`,
          [contact.primary_email],
        );
      }

      await tx.query(
        `INSERT INTO activities (
           id, entity_type, entity_id, company_id, contact_id,
           activity_type, title, detail, actor_user_id, metadata
         ) VALUES ($1, 'contact', $2, $3, $2, 'consent', 'Withdrew marketing consent', $4, $5, $6::jsonb)`,
        [
          `act_${randomUUID()}`,
          contact.id,
          contact.company_id,
          input.reason,
          user.id,
          JSON.stringify({ suppressed: input.suppressAddress }),
        ],
      );

      await this.db.writeAuditLog(tx, {
        actorUserId: user.id,
        actorEmail: user.email,
        action: 'compliance.consent_withdrawn',
        entityType: 'contact',
        entityId: contact.id,
        metadata: {
          revokedCount: revoked.rowCount,
          suppressAddress: input.suppressAddress,
        },
        ipAddress: ip,
      });

      return { withdrawn: true, suppressed: input.suppressAddress };
    });
  }

  async createUnsubscribeToken(options: {
    email: string;
    contactId?: string | null;
    channel?: string;
    sourceId?: string | null;
  }): Promise<string> {
    const rawToken = `unsub_${randomBytes(24).toString('hex')}`;
    const tokenSha256 = sha256Hex(rawToken);
    const rowId = `utk_${randomUUID()}`;
    const cleanEmail = normalizeEmail(options.email) ?? options.email.trim().toLowerCase();
    await this.db.query(
      `INSERT INTO unsubscribe_tokens (token, token_sha256, email, contact_id, channel, source_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        rowId,
        tokenSha256,
        cleanEmail,
        options.contactId ?? null,
        options.channel ?? 'sequence',
        options.sourceId ?? null,
      ],
    );
    return rawToken;
  }

  /**
   * Read-only lookup for the GET confirmation page. Never changes state, because
   * mail security scanners open links automatically (PRD §8.6).
   */
  async describeUnsubscribeToken(
    token: string,
  ): Promise<{ maskedEmail: string; alreadyUnsubscribed: boolean }> {
    const trimmed = token.trim();
    if (!trimmed) {
      throw new NotFoundDomainError('Unsubscribe link', 'token');
    }
    const tokenSha256 = sha256Hex(trimmed);
    const res = await this.db.query<{ email: string; used_at: string | null }>(
      `SELECT email, used_at
       FROM unsubscribe_tokens
       WHERE token_sha256 = $1 OR (token_sha256 IS NULL AND token = $2)
       LIMIT 1`,
      [tokenSha256, trimmed],
    );
    const row = res.rows[0];
    if (!row) {
      throw new NotFoundDomainError('Unsubscribe link', 'token');
    }
    const isErased = row.email.endsWith('@erased.invalid');
    const [local = '', domain = ''] = row.email.split('@');
    const maskedEmail = isErased
      ? 'this address'
      : `${local.slice(0, 1)}${'*'.repeat(Math.max(1, local.length - 1))}@${domain}`;
    if (isErased || row.used_at !== null) {
      return { maskedEmail, alreadyUnsubscribed: true };
    }
    const sup = await this.db.query<{ id: string }>(
      `SELECT id FROM suppressions
       WHERE (email = $1 OR email_sha256 = $2) AND lifted_at IS NULL
       LIMIT 1`,
      [row.email, sha256Hex(row.email)],
    );
    return { maskedEmail, alreadyUnsubscribed: sup.rows.length > 0 };
  }

  /**
   * PRD §5.5 & §8.6 (A12) — Public one-click RFC 8058 unsubscribe and preference page.
   * Never requires login; stores hashed tokens and suppresses immediately.
   */
  async handleUnsubscribeToken(
    token: string,
    reasonNotes = 'One-click unsubscribe',
  ): Promise<{
    unsubscribed: boolean;
    emailSha256: string;
    stoppedEnrollments: number;
  }> {
    const trimmed = token.trim();
    if (!trimmed) {
      throw new NotFoundDomainError('Unsubscribe link', 'token');
    }
    const tokenSha256 = sha256Hex(trimmed);
    const tokenRow = await this.db.query<{
      token: string;
      email: string;
      contact_id: string | null;
    }>(
      `SELECT token, email, contact_id
       FROM unsubscribe_tokens
       WHERE token_sha256 = $1 OR (token_sha256 IS NULL AND token = $2)
       LIMIT 1`,
      [tokenSha256, trimmed],
    );

    const found = tokenRow.rows[0];
    if (!found) {
      throw new NotFoundDomainError('Unsubscribe link', 'token');
    }

    if (found.email.endsWith('@erased.invalid')) {
      await this.db.query(
        `UPDATE unsubscribe_tokens SET used_at = COALESCE(used_at, NOW()) WHERE token = $1`,
        [found.token],
      );
      return {
        unsubscribed: true,
        emailSha256: sha256Hex(found.email),
        stoppedEnrollments: 0,
      };
    }

    const result = await this.db.transaction(async (tx) => {
      await tx.query(
        `UPDATE unsubscribe_tokens SET used_at = COALESCE(used_at, NOW()) WHERE token = $1`,
        [found.token],
      );
      return this.addSuppression(
        {
          email: found.email,
          reason: 'unsubscribe',
          source: 'public_unsubscribe_link',
          notes: reasonNotes,
          actorUserId: null,
        },
        tx,
      );
    });

    return {
      unsubscribed: true,
      emailSha256: sha256Hex(found.email),
      stoppedEnrollments: result.stoppedEnrollments,
    };
  }

  // -------------------------------------------------------------------------
  // Privacy operations: subject access export (JSON + CSV) & erasure (PRD 4.18, A14)
  // -------------------------------------------------------------------------

  private async loadPrivacyBundle(contactId: string) {
    const contactRes = await this.db.query(`SELECT * FROM contacts WHERE id = $1`, [contactId]);
    const contact = contactRes.rows[0];
    if (!contact) {
      throw new NotFoundDomainError('Contact', contactId);
    }

    const emailsRes = await this.db.query(
      `SELECT * FROM contact_emails WHERE contact_id = $1 ORDER BY is_primary DESC, email`,
      [contactId],
    );
    const allEmails = [
      ...new Set(
        [String(contact['primary_email']), ...emailsRes.rows.map((e) => String(e['email']))]
          .map((e) => normalizeEmail(e) ?? e.trim().toLowerCase())
          .filter(Boolean),
      ),
    ];
    const allHashes = allEmails.map(sha256Hex);

    const [
      companyRes,
      phonesRes,
      leadsRes,
      dealsRes,
      tasksRes,
      notesRes,
      activitiesRes,
      consentRes,
      suppressionRes,
      enrollmentsRes,
      sendsRes,
      inquiriesRes,
    ] = await Promise.all([
      contact['company_id']
        ? this.db.query(
            `SELECT id, name, domain, market, account_status FROM companies WHERE id = $1`,
            [contact['company_id']],
          )
        : Promise.resolve({ rows: [] as Record<string, unknown>[] }),
      this.db.query(`SELECT * FROM contact_phones WHERE contact_id = $1 ORDER BY is_primary DESC`, [
        contactId,
      ]),
      this.db.query(
        `SELECT id, full_name, email, phone_e164, firm_name, title, market, source, status, created_at
         FROM leads
         WHERE contact_id = $1 OR email = ANY($2::text[])
         ORDER BY created_at DESC`,
        [contactId, allEmails],
      ),
      this.db.query(
        `SELECT id, name, stage_name, stage_category, monthly_value_minor, annual_value_minor, currency, won_at, created_at
         FROM deals
         WHERE primary_contact_id = $1 AND deleted_at IS NULL
         ORDER BY created_at DESC`,
        [contactId],
      ),
      this.db.query(
        `SELECT id, title, task_type, status, due_at, completed_at, created_at
         FROM tasks
         WHERE contact_id = $1 AND deleted_at IS NULL
         ORDER BY created_at DESC`,
        [contactId],
      ),
      this.db.query(
        `SELECT id, body, created_at, updated_at
         FROM notes
         WHERE entity_type = 'contact' AND entity_id = $1 AND deleted_at IS NULL
         ORDER BY created_at DESC`,
        [contactId],
      ),
      this.db.query(
        `SELECT id, activity_type, title, detail, occurred_at
         FROM activities
         WHERE contact_id = $1
         ORDER BY occurred_at DESC`,
        [contactId],
      ),
      this.db.query(
        `SELECT id, email, market, basis, purpose, status, source, proof_text, captured_at, expires_at, revoked_at
         FROM consent_records
         WHERE contact_id = $1 OR email = ANY($2::text[])
         ORDER BY created_at DESC`,
        [contactId, allEmails],
      ),
      this.db.query(
        `SELECT id, email, email_sha256, reason, source, notes, lifted_at, lifted_reason, created_at
         FROM suppressions
         WHERE email = ANY($1::text[]) OR email_sha256 = ANY($2::text[])
         ORDER BY created_at DESC`,
        [allEmails, allHashes],
      ),
      this.db.query(
        `SELECT e.id, s.name AS sequence_name, e.status, e.enrolled_at, e.stopped_at, e.stop_reason
         FROM sequence_enrollments e
         JOIN sequences s ON s.id = e.sequence_id
         WHERE e.contact_id = $1
         ORDER BY e.enrolled_at DESC`,
        [contactId],
      ),
      this.db.query(
        `SELECT id, channel, recipient_email, subject, status, compliance_reason_code, sent_at
         FROM message_sends
         WHERE contact_id = $1 OR recipient_email = ANY($2::text[])
         ORDER BY sent_at DESC`,
        [contactId, allEmails],
      ),
      this.db.query(
        `SELECT id, form_type, market, page_url, deduplicated, raw_payload, created_at
         FROM inquiries
         WHERE contact_id = $1 OR email_sha256 = ANY($2::text[])
         ORDER BY created_at DESC`,
        [contactId, allHashes],
      ),
    ]);

    return {
      exportedAt: new Date().toISOString(),
      contact,
      company: companyRes.rows[0] ?? null,
      emails: emailsRes.rows,
      phones: phonesRes.rows,
      leads: leadsRes.rows,
      deals: dealsRes.rows,
      tasks: tasksRes.rows,
      notes: notesRes.rows,
      activities: activitiesRes.rows,
      consents: consentRes.rows,
      suppressions: suppressionRes.rows,
      sequenceEnrollments: enrollmentsRes.rows,
      messageSends: sendsRes.rows,
      inquiries: inquiriesRes.rows,
    };
  }

  /**
   * PRD §4.18 (A14) — Privacy subject access export (JSON).
   */
  async exportContactPrivacyData(
    user: SessionUser,
    contactId: string,
    ip: string | null = null,
  ): Promise<Record<string, unknown>> {
    requireCapability(user, 'privacy.manage');
    const bundle = await this.loadPrivacyBundle(contactId);

    await this.db.transaction(async (tx) => {
      await this.db.writeAuditLog(tx, {
        actorUserId: user.id,
        actorEmail: user.email,
        action: 'privacy.access_export',
        entityType: 'contact',
        entityId: contactId,
        metadata: { format: 'json', exportedAt: bundle.exportedAt },
        ipAddress: ip,
      });
    });

    return bundle;
  }

  /**
   * PRD §4.18 — Privacy subject access export (CSV, UTF-8 BOM + formula-neutralized).
   */
  async exportContactPrivacyCsv(
    user: SessionUser,
    contactId: string,
    ip: string | null = null,
  ): Promise<{ filename: string; csv: string }> {
    requireCapability(user, 'privacy.manage');
    const bundle = await this.loadPrivacyBundle(contactId);

    await this.db.transaction(async (tx) => {
      await this.db.writeAuditLog(tx, {
        actorUserId: user.id,
        actorEmail: user.email,
        action: 'privacy.access_export',
        entityType: 'contact',
        entityId: contactId,
        metadata: { format: 'csv', exportedAt: bundle.exportedAt },
        ipAddress: ip,
      });
    });

    const lines: string[] = [
      csvLine(['Section', 'Record ID', 'Timestamp', 'Field or type', 'Value', 'Details']),
    ];
    const c = bundle.contact;
    const contactFields: [string, unknown][] = [
      ['full_name', c['full_name']],
      ['first_name', c['first_name']],
      ['last_name', c['last_name']],
      ['primary_email', c['primary_email']],
      ['phone_e164', c['phone_e164']],
      ['title', c['title']],
      ['job_function', c['job_function']],
      ['seniority', c['seniority']],
      ['market', c['market']],
      ['timezone', c['timezone']],
      ['do_not_contact', c['do_not_contact']],
      ['company', bundle.company?.['name'] ?? ''],
    ];
    for (const [field, value] of contactFields) {
      lines.push(
        csvLine([
          'contact',
          String(c['id']),
          isoString(c['updated_at']),
          field,
          value === null || value === undefined ? '' : String(value),
          '',
        ]),
      );
    }
    for (const e of bundle.emails) {
      lines.push(
        csvLine([
          'email',
          String(e['id'] ?? ''),
          isoString(e['created_at']),
          e['is_primary'] ? 'primary' : 'secondary',
          String(e['email'] ?? ''),
          String(e['verification_status'] ?? ''),
        ]),
      );
    }
    for (const p of bundle.phones) {
      lines.push(
        csvLine([
          'phone',
          String(p['id'] ?? ''),
          isoString(p['created_at']),
          String(p['phone_label'] ?? 'work'),
          String(p['phone_e164'] ?? ''),
          '',
        ]),
      );
    }
    for (const l of bundle.leads) {
      lines.push(
        csvLine([
          'lead',
          String(l['id']),
          isoString(l['created_at']),
          String(l['status'] ?? ''),
          String(l['email'] ?? ''),
          String(l['source'] ?? ''),
        ]),
      );
    }
    for (const d of bundle.deals) {
      lines.push(
        csvLine([
          'deal',
          String(d['id']),
          isoString(d['created_at']),
          String(d['stage_name'] ?? ''),
          String(d['name'] ?? ''),
          `${String(d['monthly_value_minor'] ?? '0')} ${String(d['currency'] ?? 'USD')}`,
        ]),
      );
    }
    for (const t of bundle.tasks) {
      lines.push(
        csvLine([
          'task',
          String(t['id']),
          isoString(t['due_at']),
          String(t['task_type'] ?? ''),
          String(t['title'] ?? ''),
          String(t['status'] ?? ''),
        ]),
      );
    }
    for (const n of bundle.notes) {
      lines.push(
        csvLine([
          'note',
          String(n['id']),
          isoString(n['created_at']),
          'note',
          String(n['body'] ?? ''),
          '',
        ]),
      );
    }
    for (const a of bundle.activities) {
      lines.push(
        csvLine([
          'activity',
          String(a['id']),
          isoString(a['occurred_at']),
          String(a['activity_type'] ?? ''),
          String(a['title'] ?? ''),
          String(a['detail'] ?? ''),
        ]),
      );
    }
    for (const cr of bundle.consents) {
      lines.push(
        csvLine([
          'consent',
          String(cr['id']),
          isoString(cr['captured_at']),
          String(cr['basis'] ?? ''),
          String(cr['status'] ?? ''),
          String(cr['source'] ?? ''),
        ]),
      );
    }
    for (const s of bundle.suppressions) {
      lines.push(
        csvLine([
          'suppression',
          String(s['id']),
          isoString(s['created_at']),
          String(s['reason'] ?? ''),
          String(s['email'] ?? s['email_sha256'] ?? ''),
          s['lifted_at'] ? `Lifted: ${String(s['lifted_reason'] ?? '')}` : 'Active',
        ]),
      );
    }
    for (const se of bundle.sequenceEnrollments) {
      lines.push(
        csvLine([
          'sequence_enrollment',
          String(se['id']),
          isoString(se['enrolled_at']),
          String(se['sequence_name'] ?? ''),
          String(se['status'] ?? ''),
          String(se['stop_reason'] ?? ''),
        ]),
      );
    }
    for (const m of bundle.messageSends) {
      lines.push(
        csvLine([
          'message_send',
          String(m['id']),
          isoString(m['sent_at']),
          String(m['channel'] ?? ''),
          String(m['subject'] ?? ''),
          String(m['status'] ?? ''),
        ]),
      );
    }
    for (const inq of bundle.inquiries) {
      lines.push(
        csvLine([
          'inquiry',
          String(inq['id']),
          isoString(inq['created_at']),
          String(inq['form_type'] ?? ''),
          String(inq['market'] ?? ''),
          String(inq['page_url'] ?? ''),
        ]),
      );
    }

    const day = bundle.exportedAt.slice(0, 10);
    return {
      filename: `privacy-export-${contactId}-${day}.csv`,
      csv: `${CSV_BOM}${lines.join('')}`,
    };
  }

  /**
   * PRD §4.18 (A14) — Privacy erasure: scrubs personal fields, notes, email bodies and field
   * history, preserves deal financials and anonymized activity rows for reporting, and keeps a
   * permanent SHA-256 suppression entry so the address can never be re-imported or mailed.
   */
  async eraseContactPrivacyData(
    user: SessionUser,
    contactId: string,
    options?: { reason?: string; ipAddress?: string | null },
  ): Promise<{ erased: boolean; contactId: string; emailSha256: string }> {
    requireCapability(user, 'privacy.manage');
    const reason = options?.reason
      ? PrivacyEraseInputSchema.parse({ reason: options.reason }).reason
      : 'Privacy erasure request';
    const ip = options?.ipAddress ?? null;

    return this.db.transaction(async (tx) => {
      const contactRes = await tx.query<{
        id: string;
        primary_email: string;
        deleted_at: string | null;
      }>(`SELECT id, primary_email, deleted_at FROM contacts WHERE id = $1 LIMIT 1 FOR UPDATE`, [
        contactId,
      ]);
      const contact = contactRes.rows[0];
      if (!contact) {
        throw new NotFoundDomainError('Contact', contactId);
      }
      if (contact.primary_email.endsWith('@erased.invalid')) {
        throw new DomainError({
          status: 409,
          code: 'ALREADY_ERASED',
          title: 'Already erased',
          detail: 'Personal data for this contact has already been erased.',
        });
      }

      const secondaryRes = await tx.query<{ email: string }>(
        `SELECT email FROM contact_emails WHERE contact_id = $1`,
        [contactId],
      );
      const addresses = [
        ...new Set(
          [contact.primary_email, ...secondaryRes.rows.map((r) => r.email)]
            .map((e) => normalizeEmail(e) ?? e.trim().toLowerCase())
            .filter(Boolean),
        ),
      ];
      const emailSha256 = sha256Hex(contact.primary_email);
      const redactedEmail = `redacted+${contact.id}@erased.invalid`;

      // 1. Add permanent hashed suppressions (`email = NULL`) for every address on the contact.
      for (const addr of addresses) {
        await this.addSuppression(
          {
            email: addr,
            reason: 'privacy_erasure',
            source: 'privacy_erasure_request',
            actorUserId: user.id,
            ipAddress: ip,
          },
          tx,
        );
      }

      // 2. Anonymize contact personal fields while keeping FK row for deal financials.
      await tx.query(
        `UPDATE contacts
         SET first_name = 'Redacted',
             last_name = 'Contact',
             full_name = 'Redacted Contact',
             title = '',
             job_function = '',
             seniority = '',
             primary_email = $2,
             phone_e164 = NULL,
             apollo_person_id = NULL,
             do_not_contact = TRUE,
             custom_fields = '{}'::jsonb,
             deleted_at = COALESCE(deleted_at, NOW()),
             version = version + 1,
             updated_at = NOW()
         WHERE id = $1`,
        [contactId, redactedEmail],
      );

      await tx.query(`DELETE FROM contact_emails WHERE contact_id = $1`, [contactId]);
      await tx.query(`DELETE FROM contact_phones WHERE contact_id = $1`, [contactId]);
      await tx.query(`DELETE FROM entity_tags WHERE entity_type = 'contact' AND entity_id = $1`, [
        contactId,
      ]);

      // 3. Hard-delete notes about the contact & linked leads, plus field change history holding old PII.
      const linkedLeads = await tx.query<{ id: string }>(
        `SELECT id FROM leads WHERE contact_id = $1 OR email = ANY($2::text[]) FOR UPDATE`,
        [contactId, addresses],
      );
      const leadIds = linkedLeads.rows.map((l) => l.id);

      await tx.query(
        `DELETE FROM record_history
         WHERE entity_type = 'note'
           AND entity_id IN (
             SELECT id FROM notes
             WHERE (entity_type = 'contact' AND entity_id = $1)
                OR (entity_type = 'lead' AND entity_id = ANY($2::text[]))
           )`,
        [contactId, leadIds],
      );
      await tx.query(
        `DELETE FROM notes
         WHERE (entity_type = 'contact' AND entity_id = $1)
            OR (entity_type = 'lead' AND entity_id = ANY($2::text[]))`,
        [contactId, leadIds],
      );
      await tx.query(
        `DELETE FROM record_history
         WHERE (entity_type = 'contact' AND entity_id = $1)
            OR (entity_type = 'lead' AND entity_id = ANY($2::text[]))`,
        [contactId, leadIds],
      );

      // 4. Anonymize linked leads.
      if (leadIds.length > 0) {
        await tx.query(
          `UPDATE leads
           SET first_name = 'Redacted',
               last_name = 'Lead',
               full_name = 'Redacted Lead',
               email = CONCAT('redacted+', id, '@erased.invalid'),
               phone_e164 = NULL,
               title = '',
               deleted_at = COALESCE(deleted_at, NOW()),
               version = version + 1,
               updated_at = NOW()
           WHERE id = ANY($1::text[])`,
          [leadIds],
        );
      }

      // 5. Keep activity rows so activity counts stay accurate for reports (PRD 4.18), scrubbing text.
      await tx.query(
        `UPDATE activities
         SET title = '[Erased per privacy request]',
             detail = '',
             metadata = '{}'::jsonb
         WHERE contact_id = $1 OR lead_id = ANY($2::text[])`,
        [contactId, leadIds],
      );

      await tx.query(
        `UPDATE tasks
         SET title = '[Erased per privacy request]',
             status = CASE WHEN status = 'open' THEN 'cancelled' ELSE status END,
             version = version + 1,
             updated_at = NOW()
         WHERE contact_id = $1 OR lead_id = ANY($2::text[])`,
        [contactId, leadIds],
      );

      // 6. Scrub email subjects, recipients, attachment metadata and message bodies.
      await tx.query(
        `DELETE FROM email_attachments
         WHERE message_id IN (
           SELECT m.id FROM email_messages m
           JOIN email_threads t ON t.id = m.thread_id
           WHERE t.contact_id = $1
         )`,
        [contactId],
      );
      await tx.query(
        `UPDATE email_messages
         SET subject = '[Erased per privacy request]',
             body_preview = '[Erased per privacy request]',
             body_text = '[Erased per privacy request]',
             body_html_sanitized = NULL,
             from_email = 'redacted@erased.invalid',
             to_emails = '[]'::jsonb,
             cc_emails = '[]'::jsonb,
             has_attachments = FALSE
         WHERE thread_id IN (SELECT id FROM email_threads WHERE contact_id = $1)`,
        [contactId],
      );
      await tx.query(
        `UPDATE email_threads
         SET subject = '[Erased per privacy request]',
             snippet = '[Erased per privacy request]'
         WHERE contact_id = $1`,
        [contactId],
      );

      await tx.query(
        `UPDATE consent_records
         SET email = $2,
             status = 'revoked',
             revoked_at = COALESCE(revoked_at, NOW()),
             proof_text = '[Erased per privacy request]'
         WHERE contact_id = $1 OR email = ANY($3::text[])`,
        [contactId, redactedEmail, addresses],
      );

      await tx.query(
        `UPDATE unsubscribe_tokens
         SET email = $2,
             used_at = COALESCE(used_at, NOW())
         WHERE contact_id = $1 OR email = ANY($3::text[])`,
        [contactId, redactedEmail, addresses],
      );

      const addressHashes = addresses.map(sha256Hex);
      await tx.query(
        `UPDATE inquiries
         SET raw_payload = '{}'::jsonb,
             user_agent = NULL,
             page_url = NULL
         WHERE contact_id = $1 OR email_sha256 = ANY($2::text[])`,
        [contactId, addressHashes],
      );

      await tx.query(
        `UPDATE deals
         SET primary_contact_id = NULL,
             version = version + 1,
             updated_at = NOW()
         WHERE primary_contact_id = $1`,
        [contactId],
      );

      await tx.query(
        `UPDATE duplicate_candidates
         SET status = 'dismissed',
             resolved_at = COALESCE(resolved_at, NOW())
         WHERE entity_type = 'contact'
           AND status = 'open'
           AND (left_entity_id = $1 OR right_entity_id = $1)`,
        [contactId],
      );

      await this.db.writeAuditLog(tx, {
        actorUserId: user.id,
        actorEmail: user.email,
        action: 'privacy.erasure',
        entityType: 'contact',
        entityId: contactId,
        metadata: { emailSha256, addressCount: addresses.length, reason },
        ipAddress: ip,
      });

      await this.db.addOutboxEvent(tx, {
        eventType: 'contact.erased',
        aggregateType: 'contact',
        aggregateId: contactId,
        payload: { contactId, emailSha256 },
      });

      return {
        erased: true,
        contactId,
        emailSha256,
      };
    });
  }

  async listConsents(user: SessionUser): Promise<Record<string, unknown>[]> {
    requireCapability(user, 'compliance.manage');
    const res = await this.db.query(
      `SELECT id, email, contact_id, market, basis, purpose, status, source, proof_text, captured_at, expires_at
       FROM consent_records
       ORDER BY created_at DESC
       LIMIT 200`,
    );
    return res.rows;
  }
}

export { registerComplianceRoutes } from './routes.js';
