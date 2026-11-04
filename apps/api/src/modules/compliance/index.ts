import { randomUUID } from 'node:crypto';
import {
  CheckSendableInputSchema,
  type CheckSendableInput,
  type CheckSendableResult,
  type ConsentBasis,
  type Market,
  type MessageChannel,
  type SessionUser,
  type SuppressionReason,
} from '@adas/shared';
import { isWithinSendWindow } from '../../platform/calendar/index.js';
import { type DatabaseService, sha256Hex, type DbTx } from '../../platform/db/index.js';
import { NotFoundDomainError } from '../../platform/errors/index.js';
import { extractDomainFromEmail, normalizeEmail } from '../../platform/normalize/index.js';
import { requireCapability } from '../../platform/scope/index.js';

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

  if (!normalizedEmail || input.emailVerificationStatus === 'invalid') {
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

  if (input.channel === 'sequence' || input.channel === 'campaign') {
    if (input.sendsInLast7Days >= input.maxSendsPer7Days) {
      return reject(
        'FREQUENCY_CAP',
        `Recipient has already received ${input.sendsInLast7Days} outreach messages in the last 7 days (cap: ${input.maxSendsPer7Days}).`,
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
        'Current time is outside the recipient local business-day send window (08:30–17:00).',
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

export class ComplianceService {
  constructor(private readonly db: DatabaseService) {}

  async evaluateRecipientSendability(options: {
    email: string;
    channel: MessageChannel;
    senderUserId?: string;
    bypassSendWindow?: boolean;
    now?: Date;
  }): Promise<CheckSendableResult> {
    const now = options.now ?? new Date();
    const cleanEmail = normalizeEmail(options.email) ?? options.email.trim().toLowerCase();
    const emailHash = sha256Hex(cleanEmail);
    const domain = extractDomainFromEmail(cleanEmail);

    const [supEmailRes, supDomainRes, contactRes, consentRes, freqRes, senderCapRes] =
      await Promise.all([
        this.db.query<{ id: string }>(
          `SELECT id FROM suppressions WHERE email = $1 OR email_sha256 = $2 LIMIT 1`,
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
             AND sent_at >= NOW() - INTERVAL '7 days'`,
          [cleanEmail],
        ),
        options.senderUserId
          ? this.db.query<{ cnt: number; cap: number }>(
              `SELECT
                 (SELECT COUNT(*)::int FROM message_sends WHERE sender_user_id = $1 AND sent_at >= CURRENT_DATE) AS cnt,
                 COALESCE((SELECT daily_send_cap FROM users WHERE id = $1), 50) AS cap`,
              [options.senderUserId],
            )
          : Promise.resolve({ rows: [{ cnt: 0, cap: 50 }], rowCount: 1 }),
      ]);

    const contact = contactRes.rows[0];
    const consentRow = consentRes.rows[0];
    const market: Market = contact?.market ?? 'US';
    const timezone = contact?.timezone ?? 'America/New_York';
    const withinWindow = isWithinSendWindow(now, timezone, market);

    return checkSendable({
      email: cleanEmail,
      channel: options.channel,
      market,
      contactDoNotContact: contact?.do_not_contact ?? false,
      companyAccountStatus: contact?.account_status ?? 'prospect',
      emailVerificationStatus: contact?.email_verification_status ?? 'unknown',
      hardBounced: Boolean(contact?.hard_bounced_at),
      suppressedEmail: supEmailRes.rows.length > 0,
      suppressedDomain: supDomainRes.rows.length > 0,
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
      mailboxSendsToday: senderCapRes.rows[0]?.cnt ?? 0,
      mailboxDailyCap: senderCapRes.rows[0]?.cap ?? 50,
      withinSendWindow: withinWindow,
      bypassSendWindow: options.bypassSendWindow ?? true,
      nowIso: now.toISOString(),
    });
  }

  async addSuppression(
    options: {
      email: string;
      reason: SuppressionReason;
      source: string;
      notes?: string;
      actorUserId?: string | null;
    },
    existingTx?: DbTx,
  ): Promise<{ id: string; email: string; stoppedEnrollments: number }> {
    const cleanEmail = normalizeEmail(options.email);
    if (!cleanEmail) {
      throw new Error('Invalid email for suppression');
    }
    const emailSha256 = sha256Hex(cleanEmail);

    const runInTx = async (tx: DbTx) => {
      const id = `sup_${randomUUID()}`;
      const upserted = await tx.query<{ id: string }>(
        `INSERT INTO suppressions (id, email, email_sha256, reason, source, notes, actor_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (email_sha256) DO UPDATE
           SET reason = EXCLUDED.reason,
               source = EXCLUDED.source
         RETURNING id`,
        [
          id,
          cleanEmail,
          emailSha256,
          options.reason,
          options.source,
          options.notes ?? null,
          options.actorUserId ?? null,
        ],
      );
      const suppressionId = upserted.rows[0]?.id ?? id;

      await tx.query(
        `UPDATE contacts
         SET do_not_contact = TRUE,
             hard_bounced_at = CASE WHEN $2 = 'hard_bounce' THEN NOW() ELSE hard_bounced_at END,
             updated_at = NOW()
         WHERE primary_email = $1`,
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
        email: cleanEmail,
        stoppedEnrollments: stopped.rowCount,
      };
    };

    if (existingTx) {
      return runInTx(existingTx);
    }
    return this.db.transaction(runInTx);
  }

  async addSuppressedDomain(options: {
    domain: string;
    reason: string;
    actorUserId?: string | null;
  }): Promise<{ id: string; domain: string }> {
    const cleanDomain = options.domain
      .trim()
      .toLowerCase()
      .replace(/^www\./, '');
    return this.db.transaction(async (tx) => {
      const id = `sdom_${randomUUID()}`;
      const res = await tx.query<{ id: string }>(
        `INSERT INTO suppressed_domains (id, domain, reason, actor_user_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (domain) DO UPDATE SET reason = EXCLUDED.reason
         RETURNING id`,
        [id, cleanDomain, options.reason, options.actorUserId ?? null],
      );
      const finalId = res.rows[0]?.id ?? id;
      await this.db.writeAuditLog(tx, {
        actorUserId: options.actorUserId ?? null,
        action: 'compliance.domain_suppressed',
        entityType: 'suppressed_domain',
        entityId: finalId,
        metadata: { domain: cleanDomain, reason: options.reason },
      });
      return { id: finalId, domain: cleanDomain };
    });
  }

  async createUnsubscribeToken(options: {
    email: string;
    contactId?: string | null;
    channel?: string;
    sourceId?: string | null;
  }): Promise<string> {
    const token = `unsub_${randomUUID().replace(/-/g, '')}`;
    const cleanEmail = normalizeEmail(options.email) ?? options.email.trim().toLowerCase();
    await this.db.query(
      `INSERT INTO unsubscribe_tokens (token, email, contact_id, channel, source_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        token,
        cleanEmail,
        options.contactId ?? null,
        options.channel ?? 'sequence',
        options.sourceId ?? null,
      ],
    );
    return token;
  }

  /**
   * Read-only lookup for the GET confirmation page. Never changes state, because
   * mail security scanners open links automatically (PRD §8.6).
   */
  async describeUnsubscribeToken(
    token: string,
  ): Promise<{ maskedEmail: string; alreadyUnsubscribed: boolean }> {
    const res = await this.db.query<{ email: string; used_at: string | null }>(
      `SELECT email, used_at FROM unsubscribe_tokens WHERE token = $1 LIMIT 1`,
      [token],
    );
    const row = res.rows[0];
    if (!row) {
      throw new NotFoundDomainError('Unsubscribe link', 'token');
    }
    const [local = '', domain = ''] = row.email.split('@');
    const maskedEmail = `${local.slice(0, 1)}${'*'.repeat(Math.max(1, local.length - 1))}@${domain}`;
    return { maskedEmail, alreadyUnsubscribed: row.used_at !== null };
  }

  /**
   * PRD §5.4 (A17) — Public one-click RFC 8058 unsubscribe and preference center.
   * Never requires login.
   */
  async handleUnsubscribeToken(
    token: string,
    reasonNotes = 'One-click unsubscribe',
  ): Promise<{
    unsubscribed: boolean;
    emailSha256: string;
    stoppedEnrollments: number;
  }> {
    const tokenRow = await this.db.query<{
      token: string;
      email: string;
      contact_id: string | null;
    }>(`SELECT token, email, contact_id FROM unsubscribe_tokens WHERE token = $1 LIMIT 1`, [token]);

    const found = tokenRow.rows[0];
    if (!found) {
      throw new NotFoundDomainError('Unsubscribe link', 'token');
    }

    const result = await this.db.transaction(async (tx) => {
      await tx.query(`UPDATE unsubscribe_tokens SET used_at = NOW() WHERE token = $1`, [token]);
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

  /**
   * PRD §5.5 (A14) — Privacy subject access export.
   */
  async exportContactPrivacyData(
    user: SessionUser,
    contactId: string,
  ): Promise<Record<string, unknown>> {
    requireCapability(user, 'compliance.manage');
    const [contactRes, emailsRes, phonesRes, consentRes, activitiesRes, sendsRes] =
      await Promise.all([
        this.db.query(`SELECT * FROM contacts WHERE id = $1`, [contactId]),
        this.db.query(`SELECT * FROM contact_emails WHERE contact_id = $1`, [contactId]),
        this.db.query(`SELECT * FROM contact_phones WHERE contact_id = $1`, [contactId]),
        this.db.query(`SELECT * FROM consent_records WHERE contact_id = $1`, [contactId]),
        this.db.query(`SELECT * FROM activities WHERE contact_id = $1`, [contactId]),
        this.db.query(`SELECT * FROM message_sends WHERE contact_id = $1`, [contactId]),
      ]);

    const contact = contactRes.rows[0];
    if (!contact) {
      throw new Error(`Contact ${contactId} not found`);
    }

    await this.db.transaction(async (tx) => {
      await this.db.writeAuditLog(tx, {
        actorUserId: user.id,
        actorEmail: user.email,
        action: 'privacy.access_export',
        entityType: 'contact',
        entityId: contactId,
        metadata: { exportedAt: new Date().toISOString() },
      });
    });

    return {
      exportedAt: new Date().toISOString(),
      contact,
      emails: emailsRes.rows,
      phones: phonesRes.rows,
      consents: consentRes.rows,
      activities: activitiesRes.rows,
      messageSends: sendsRes.rows,
    };
  }

  /**
   * PRD §5.5 (A14) — Privacy erasure (anonymizes PII, preserves deal financials,
   * retains SHA-256 suppression hash so the address can never be re-imported or mailed).
   */
  async eraseContactPrivacyData(
    user: SessionUser,
    contactId: string,
  ): Promise<{ erased: boolean; contactId: string; emailSha256: string }> {
    requireCapability(user, 'compliance.manage');

    return this.db.transaction(async (tx) => {
      const contactRes = await tx.query<{ id: string; primary_email: string }>(
        `SELECT id, primary_email FROM contacts WHERE id = $1 LIMIT 1`,
        [contactId],
      );
      const contact = contactRes.rows[0];
      if (!contact) {
        throw new Error(`Contact ${contactId} not found`);
      }

      const emailSha256 = sha256Hex(contact.primary_email);
      const redactedEmail = `redacted+${contact.id}@erased.invalid`;

      // 1. Add suppression first, then scrub cleartext email from suppressions while keeping email_sha256
      await this.addSuppression(
        {
          email: contact.primary_email,
          reason: 'privacy_erasure',
          source: 'privacy_erasure_request',
          notes: 'PII erased; SHA-256 retained to block future re-import',
          actorUserId: user.id,
        },
        tx,
      );
      await tx.query(`UPDATE suppressions SET email = NULL WHERE email_sha256 = $1`, [emailSha256]);

      // 2. Anonymize contact & leads while keeping deal financial rows intact
      await tx.query(
        `UPDATE contacts
         SET first_name = 'Redacted',
             last_name = 'Contact',
             full_name = 'Redacted Contact',
             primary_email = $2,
             phone_e164 = NULL,
             do_not_contact = TRUE,
             custom_fields = '{}'::jsonb,
             deleted_at = NOW(),
             updated_at = NOW()
         WHERE id = $1`,
        [contactId, redactedEmail],
      );

      await tx.query(`DELETE FROM contact_emails WHERE contact_id = $1`, [contactId]);
      await tx.query(`DELETE FROM contact_phones WHERE contact_id = $1`, [contactId]);

      await tx.query(
        `UPDATE leads
         SET first_name = 'Redacted',
             last_name = 'Lead',
             full_name = 'Redacted Lead',
             email = $2,
             phone_e164 = NULL,
             deleted_at = NOW()
         WHERE contact_id = $1 OR email = $3`,
        [contactId, redactedEmail, contact.primary_email],
      );

      await tx.query(
        `UPDATE email_messages
         SET body_preview = '[Erased per privacy request]',
             body_text = '[Erased per privacy request]',
             from_email = 'redacted@erased.invalid'
         WHERE thread_id IN (SELECT id FROM email_threads WHERE contact_id = $1)`,
        [contactId],
      );

      await this.db.writeAuditLog(tx, {
        actorUserId: user.id,
        actorEmail: user.email,
        action: 'privacy.erasure',
        entityType: 'contact',
        entityId: contactId,
        metadata: { emailSha256 },
      });

      return {
        erased: true,
        contactId,
        emailSha256,
      };
    });
  }

  async listSuppressions(): Promise<Record<string, unknown>[]> {
    const res = await this.db.query(
      `SELECT id, email, email_sha256, reason, source, notes, created_at
       FROM suppressions
       ORDER BY created_at DESC`,
    );
    return res.rows;
  }

  async listConsents(): Promise<Record<string, unknown>[]> {
    const res = await this.db.query(
      `SELECT id, email, contact_id, market, basis, status, source, proof_text, captured_at, expires_at
       FROM consent_records
       ORDER BY created_at DESC`,
    );
    return res.rows;
  }
}
