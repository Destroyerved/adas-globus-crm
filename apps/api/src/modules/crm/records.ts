import { randomUUID } from 'node:crypto';
import {
  AddContactEmailInputSchema,
  AddContactPhoneInputSchema,
  AddDealContactInputSchema,
  CompleteTaskInputSchema,
  RecordEntityTypeSchema,
  SetPrimaryContactEmailInputSchema,
  SetPrimaryContactPhoneInputSchema,
  UpdateCompanyInputSchema,
  UpdateContactInputSchema,
  UpdateDealContactInputSchema,
  UpdateDealInputSchema,
  UpdateLeadInputSchema,
  UpdateTaskInputSchema,
  type DealContactView,
  type LeadSystemStatus,
  type Market,
  type RecurrenceRule,
  type SessionUser,
} from '@adas/shared';
import { nextRecurringDueAt } from '../../platform/calendar/index.js';
import { sha256Hex, type DatabaseService, type DbTx } from '../../platform/db/index.js';
import {
  DomainError,
  NotFoundDomainError,
  ValidationDomainError,
  VersionConflictError,
} from '../../platform/errors/index.js';
import {
  extractDomainFromEmail,
  isFreeMailDomain,
  normalizeDomain,
  normalizeEmail,
  normalizePhone,
} from '../../platform/normalize/index.js';
import { requireCapability, scopeWhere } from '../../platform/scope/index.js';
import { addNotification } from '../notifications/index.js';
import {
  RECORD_TABLES,
  insertActivity,
  referenceList,
  requireRecord,
  resolveAssignee,
  writeChanges,
} from './access.js';
import { LeadScoringService } from './scoring.js';

/**
 * Editing records (PRD 3.1, 3.2, 4.3-4.7, 6.7): optimistic concurrency on `version`,
 * record history for every changed field, status and stage history, outbox events,
 * assignment notifications and soft delete.
 */

type Row = Record<string, unknown>;

export function leadStatusCategory(status: LeadSystemStatus): 'open' | 'qualified' | 'closed' {
  if (status === 'Qualified') return 'qualified';
  if (status === 'Disqualified' || status === 'Converted') return 'closed';
  return 'open';
}

const LEAD_TRACKED = [
  'first_name',
  'last_name',
  'email',
  'phone_e164',
  'firm_name',
  'domain',
  'title',
  'market',
  'state_province',
  'staff_band',
  'source',
  'status',
  'disqualification_reason',
  'owner_user_id',
  'services_needed',
  'software_stack',
] as const;

const CONTACT_TRACKED = [
  'first_name',
  'last_name',
  'title',
  'job_function',
  'seniority',
  'primary_email',
  'phone_e164',
  'market',
  'timezone',
  'company_id',
  'owner_user_id',
  'do_not_contact',
] as const;

const COMPANY_TRACKED = [
  'name',
  'domain',
  'firm_type',
  'market',
  'state_province',
  'city',
  'timezone',
  'staff_band',
  'account_status',
  'owner_user_id',
  'accounting_software',
  'services_needed',
] as const;

const DEAL_TRACKED = [
  'name',
  'primary_contact_id',
  'monthly_value_minor',
  'one_time_value_minor',
  'term_months',
  'currency',
  'fte_count',
  'engagement_model',
  'services',
  'probability',
  'expected_close_date',
  'owner_user_id',
  'trial_candidate_role',
] as const;

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export class CrmRecordService {
  private readonly scoring: LeadScoringService;

  constructor(private readonly db: DatabaseService) {
    this.scoring = new LeadScoringService(db);
  }

  // -------------------------------------------------------------------------
  // Leads (PRD 3.2, 4.5)
  // -------------------------------------------------------------------------

  async updateLead(user: SessionUser, leadId: string, raw: unknown): Promise<Row> {
    const input = UpdateLeadInputSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      const cur = await requireRecord<Row>(tx, user, 'lead', leadId, 'write', { forUpdate: true });
      if (cur['version'] !== input.version) throw new VersionConflictError('Lead', leadId);

      const market = input.market ?? (cur['market'] as string);
      let email = cur['email'] as string;
      if (input.email !== undefined) {
        const clean = normalizeEmail(input.email);
        if (!clean) {
          throw new ValidationDomainError('Enter a valid email address.', {
            email: ['Enter a valid email address.'],
          });
        }
        if (clean !== cur['email']) {
          const erased = await tx.query<{ id: string }>(
            `SELECT id FROM suppressions
             WHERE email_sha256 = $1 AND reason = 'privacy_erasure' AND lifted_at IS NULL
             LIMIT 1`,
            [sha256Hex(clean)],
          );
          if (erased.rows.length > 0) {
            throw new DomainError({
              status: 409,
              code: 'PRIVACY_ERASED_ADDRESS',
              title: 'Address cannot be used',
              detail:
                'This email address was removed under a privacy erasure request and cannot be re-added.',
              fieldErrors: {
                email: ['Removed under a privacy erasure request.'],
              },
            });
          }
        }
        email = clean;
      }

      // Status (PRD 3.2): Converted only via Convert; Disqualified needs a listed reason.
      let status = cur['status'] as LeadSystemStatus;
      let dqReason = (cur['disqualification_reason'] as string | null) ?? null;
      const statusChanged = input.status !== undefined && input.status !== cur['status'];
      if (statusChanged && input.status) {
        if (input.status === 'Converted') {
          throw new ValidationDomainError('Use Convert to turn a lead into a deal.', {
            status: ['Use Convert instead.'],
          });
        }
        if (cur['status'] === 'Converted') {
          throw new DomainError({
            status: 409,
            code: 'LEAD_ALREADY_CONVERTED',
            title: 'Lead already converted',
            detail: "A converted lead can't change status. Work on its deal instead.",
          });
        }
        if (input.status === 'Disqualified') {
          const reasons = await referenceList(tx, 'disqualify_reasons');
          const reason = input.disqualificationReason?.trim() ?? '';
          if (!reason || (reasons.length > 0 && !reasons.includes(reason))) {
            throw new ValidationDomainError('Choose why this lead is disqualified.', {
              disqualificationReason: ['Choose a reason from the list.'],
            });
          }
          dqReason = reason;
        } else {
          dqReason = null;
        }
        status = input.status;
      }
      const statusCategory = leadStatusCategory(status);

      // PRD 3.1: one open lead per person.
      if (
        statusCategory !== 'closed' &&
        (email !== cur['email'] ||
          leadStatusCategory(cur['status'] as LeadSystemStatus) === 'closed')
      ) {
        const other = await tx.query<{ full_name: string }>(
          `SELECT full_name FROM leads
           WHERE email = $1 AND id <> $2 AND status_category IN ('open', 'qualified') AND deleted_at IS NULL
           LIMIT 1`,
          [email, leadId],
        );
        if (other.rows[0]) {
          throw new DomainError({
            status: 409,
            code: 'DUPLICATE_OPEN_LEAD',
            title: 'Lead already exists',
            detail: `There's already an open lead for this email (${other.rows[0].full_name}).`,
            fieldErrors: { email: ['This email already has an open lead.'] },
          });
        }
      }

      // Owner (PRD 4.5): needs leads.assign; the new owner's team goes with the lead.
      let ownerId = cur['owner_user_id'] as string;
      let teamId = (cur['team_id'] as string | null) ?? null;
      let newOwnerName: string | null = null;
      if (input.ownerUserId && input.ownerUserId !== ownerId) {
        const target = await resolveAssignee(tx, user, input.ownerUserId, 'leads.assign');
        ownerId = target.id;
        teamId = target.team_id;
        newOwnerName = target.name;
      }

      let domain = (cur['domain'] as string | null) ?? null;
      let website = (cur['website'] as string | null) ?? null;
      if (input.website !== undefined || input.email !== undefined) {
        const fromSite = input.website ? normalizeDomain(input.website) : null;
        const candidate = fromSite ?? extractDomainFromEmail(email);
        domain = candidate && !isFreeMailDomain(candidate) ? candidate : null;
        website = domain ? `https://${domain}` : null;
      }

      const firstName = input.firstName ?? (cur['first_name'] as string);
      const lastName = input.lastName ?? (cur['last_name'] as string);
      const phone =
        input.phone === undefined
          ? (cur['phone_e164'] as string | null)
          : input.phone
            ? normalizePhone(input.phone, market === 'CA' ? 'CA' : 'US')
            : null;

      const updated = await tx.query<Row>(
        `UPDATE leads SET
           first_name = $3, last_name = $4, full_name = $5, email = $6, phone_e164 = $7,
           firm_name = $8, domain = $9, website = $10, title = $11, market = $12,
           state_province = $13, staff_band = $14, source = $15, status = $16,
           status_category = $17, disqualification_reason = $18, owner_user_id = $19,
           team_id = $20, services_needed = $21::jsonb, software_stack = $22::jsonb,
           version = version + 1, updated_at = NOW()
         WHERE id = $1 AND version = $2 AND deleted_at IS NULL
         RETURNING *`,
        [
          leadId,
          input.version,
          firstName,
          lastName,
          `${firstName} ${lastName}`.trim(),
          email,
          phone,
          input.firmName === undefined ? cur['firm_name'] : input.firmName || null,
          domain,
          website,
          input.title ?? cur['title'],
          market,
          input.stateProvince === undefined ? cur['state_province'] : input.stateProvince || null,
          input.staffBand ?? cur['staff_band'],
          input.source ?? cur['source'],
          status,
          statusCategory,
          dqReason,
          ownerId,
          teamId,
          JSON.stringify(input.servicesNeeded ?? cur['services_needed'] ?? []),
          JSON.stringify(input.softwareStack ?? cur['software_stack'] ?? []),
        ],
      );
      const next = updated.rows[0];
      if (!next) throw new VersionConflictError('Lead', leadId);

      await writeChanges(this.db, tx, 'lead', leadId, cur, next, LEAD_TRACKED, user.id);

      if (statusChanged) {
        await tx.query(
          `INSERT INTO lead_status_history (id, lead_id, from_status, to_status, changed_by_user_id, reason)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            `lsh_${randomUUID()}`,
            leadId,
            cur['status'],
            status,
            user.id,
            [dqReason, input.statusNote].filter(Boolean).join(' · ') || null,
          ],
        );
        await this.db.addOutboxEvent(tx, {
          eventType: 'lead.status_changed',
          aggregateType: 'lead',
          aggregateId: leadId,
          payload: { leadId, from: cur['status'], to: status },
        });
        if (statusCategory === 'qualified') {
          await this.db.addOutboxEvent(tx, {
            eventType: 'lead.qualified',
            aggregateType: 'lead',
            aggregateId: leadId,
            payload: { leadId },
          });
        }
      }

      if (newOwnerName) {
        await this.recordAssignment(tx, user, 'lead', leadId, next, ownerId, newOwnerName);
      }
      await this.scoring.evaluateLead(tx, leadId);
      const scored = await tx.query<Row>(`SELECT * FROM leads WHERE id = $1`, [leadId]);
      return scored.rows[0] ?? next;
    });
  }

  // -------------------------------------------------------------------------
  // Contacts (PRD 4.4)
  // -------------------------------------------------------------------------

  async updateContact(user: SessionUser, contactId: string, raw: unknown): Promise<Row> {
    const input = UpdateContactInputSchema.parse(raw);
    if (input.timezone !== undefined && !isValidTimeZone(input.timezone)) {
      throw new ValidationDomainError('Choose a valid time zone.', {
        timezone: ['Use an IANA time zone such as America/Toronto.'],
      });
    }
    return this.db.transaction(async (tx) => {
      const cur = await requireRecord<Row>(tx, user, 'contact', contactId, 'write', {
        forUpdate: true,
      });
      if (cur['version'] !== input.version) throw new VersionConflictError('Contact', contactId);
      const market = input.market ?? (cur['market'] as string);

      let email = cur['primary_email'] as string;
      if (input.primaryEmail !== undefined) {
        const clean = normalizeEmail(input.primaryEmail);
        if (!clean) {
          throw new ValidationDomainError('Enter a valid email address.', {
            primaryEmail: ['Enter a valid email address.'],
          });
        }
        if (clean !== email) {
          const erased = await tx.query<{ id: string }>(
            `SELECT id FROM suppressions
             WHERE email_sha256 = $1 AND reason = 'privacy_erasure'
             LIMIT 1`,
            [sha256Hex(clean)],
          );
          if (erased.rows[0]) {
            throw new DomainError({
              status: 409,
              code: 'PRIVACY_ERASED',
              title: 'Address permanently suppressed',
              detail:
                'This email address was erased after a privacy request and cannot be used again.',
              fieldErrors: {
                primaryEmail: ['This email address was erased after a privacy request.'],
              },
            });
          }
          // PRD 3.1: an email address belongs to one contact only.
          const owner = await tx.query<{ full_name: string; contact_id: string }>(
            `SELECT c.full_name, ce.contact_id FROM contact_emails ce
             JOIN contacts c ON c.id = ce.contact_id
             WHERE ce.email = $1 AND ce.contact_id <> $2
             UNION ALL
             SELECT full_name, id FROM contacts
             WHERE primary_email = $1 AND id <> $2 AND deleted_at IS NULL
             LIMIT 1`,
            [clean, contactId],
          );
          if (owner.rows[0]) {
            throw new DomainError({
              status: 409,
              code: 'EMAIL_BELONGS_TO_OTHER_CONTACT',
              title: 'Email already in use',
              detail: `This email already belongs to ${owner.rows[0].full_name}. Open their record or use a different email.`,
              fieldErrors: { primaryEmail: ['This email belongs to another contact.'] },
            });
          }
          await tx.query(
            `UPDATE contact_emails SET is_primary = FALSE WHERE contact_id = $1 AND is_primary`,
            [contactId],
          );
          await tx.query(
            `INSERT INTO contact_emails (id, contact_id, email, is_primary, verification_status)
             VALUES ($1, $2, $3, TRUE, 'unknown')
             ON CONFLICT (email) DO UPDATE SET is_primary = TRUE`,
            [`ce_${randomUUID()}`, contactId, clean],
          );
        }
        email = clean;
      }

      let companyId = (cur['company_id'] as string | null) ?? null;
      if (input.companyId !== undefined && input.companyId !== companyId) {
        if (input.companyId) {
          await requireRecord(tx, user, 'company', input.companyId, 'read');
        }
        companyId = input.companyId;
      }

      let ownerId = cur['owner_user_id'] as string;
      let teamId = (cur['team_id'] as string | null) ?? null;
      let newOwnerName: string | null = null;
      if (input.ownerUserId && input.ownerUserId !== ownerId) {
        const target = await resolveAssignee(tx, user, input.ownerUserId, 'contacts.write');
        ownerId = target.id;
        teamId = target.team_id;
        newOwnerName = target.name;
      }

      const firstName = input.firstName ?? (cur['first_name'] as string);
      const lastName = input.lastName ?? (cur['last_name'] as string);
      const phone =
        input.phone === undefined
          ? (cur['phone_e164'] as string | null)
          : input.phone
            ? normalizePhone(input.phone, market === 'CA' ? 'CA' : 'US')
            : null;
      const doNotContact = input.doNotContact ?? (cur['do_not_contact'] as boolean);

      const updated = await tx.query<Row>(
        `UPDATE contacts SET
           first_name = $3, last_name = $4, full_name = $5, title = $6, job_function = $7,
           seniority = $8, primary_email = $9, phone_e164 = $10, market = $11, timezone = $12,
           company_id = $13, owner_user_id = $14, team_id = $15, do_not_contact = $16,
           version = version + 1, updated_at = NOW()
         WHERE id = $1 AND version = $2 AND deleted_at IS NULL
         RETURNING *`,
        [
          contactId,
          input.version,
          firstName,
          lastName,
          `${firstName} ${lastName}`.trim(),
          input.title ?? cur['title'],
          input.jobFunction ?? cur['job_function'],
          input.seniority ?? cur['seniority'],
          email,
          phone,
          market,
          input.timezone ?? cur['timezone'],
          companyId,
          ownerId,
          teamId,
          doNotContact,
        ],
      );
      const next = updated.rows[0];
      if (!next) throw new VersionConflictError('Contact', contactId);
      await writeChanges(this.db, tx, 'contact', contactId, cur, next, CONTACT_TRACKED, user.id);

      if (doNotContact && !cur['do_not_contact']) {
        // Do-not-contact stops every automated sequence at once (PRD 5, AGENTS.md 10).
        await tx.query(
          `UPDATE sequence_enrollments
           SET status = 'stopped_suppressed', stop_reason = 'Marked do not contact',
               next_send_at = NULL, stopped_at = NOW()
           WHERE contact_id = $1 AND status IN ('active', 'paused')`,
          [contactId],
        );
      }
      await this.db.addOutboxEvent(tx, {
        eventType: 'contact.updated',
        aggregateType: 'contact',
        aggregateId: contactId,
        payload: { contactId },
      });
      if (newOwnerName) {
        await this.recordAssignment(tx, user, 'contact', contactId, next, ownerId, newOwnerName);
      }
      await this.scoring.evaluateContact(tx, contactId);
      const scored = await tx.query<Row>(`SELECT * FROM contacts WHERE id = $1`, [contactId]);
      return scored.rows[0] ?? next;
    });
  }

  async addContactEmail(
    user: SessionUser,
    contactId: string,
    raw: unknown,
  ): Promise<{ emails: Row[] }> {
    const input = AddContactEmailInputSchema.parse(raw);
    const clean = normalizeEmail(input.email);
    if (!clean) {
      throw new ValidationDomainError('Enter a valid email address.', {
        email: ['Enter a valid email address.'],
      });
    }

    return this.db.transaction(async (tx) => {
      const cur = await requireRecord<Row>(tx, user, 'contact', contactId, 'write', {
        forUpdate: true,
      });
      const erased = await tx.query<{ id: string }>(
        `SELECT id FROM suppressions WHERE email_sha256 = $1 AND reason = 'privacy_erasure' LIMIT 1`,
        [sha256Hex(clean)],
      );
      if (erased.rows[0]) {
        throw new DomainError({
          status: 409,
          code: 'PRIVACY_ERASED',
          title: 'Address permanently suppressed',
          detail: 'This email address was erased after a privacy request and cannot be used again.',
          fieldErrors: { email: ['This email address was erased after a privacy request.'] },
        });
      }

      const owner = await tx.query<{ full_name: string }>(
        `SELECT c.full_name FROM contact_emails ce
         JOIN contacts c ON c.id = ce.contact_id
         WHERE ce.email = $1 AND ce.contact_id <> $2
         UNION ALL
         SELECT full_name FROM contacts
         WHERE primary_email = $1 AND id <> $2 AND deleted_at IS NULL
         LIMIT 1`,
        [clean, contactId],
      );
      if (owner.rows[0]) {
        throw new DomainError({
          status: 409,
          code: 'EMAIL_BELONGS_TO_OTHER_CONTACT',
          title: 'Email already in use',
          detail: `This email already belongs to ${owner.rows[0].full_name}.`,
          fieldErrors: { email: ['This email belongs to another contact.'] },
        });
      }

      // Ensure existing primary_email is present in contact_emails
      const primary = String(cur['primary_email']);
      await tx.query(
        `INSERT INTO contact_emails (id, contact_id, email, is_primary, verification_status)
         VALUES ($1, $2, $3, TRUE, $4)
         ON CONFLICT (email) DO NOTHING`,
        [`ce_${randomUUID()}`, contactId, primary, cur['email_verification_status'] ?? 'unknown'],
      );

      if (input.makePrimary && clean !== primary) {
        await tx.query(`UPDATE contact_emails SET is_primary = FALSE WHERE contact_id = $1`, [
          contactId,
        ]);
        await tx.query(
          `INSERT INTO contact_emails (id, contact_id, email, is_primary, verification_status)
           VALUES ($1, $2, $3, TRUE, 'unknown')
           ON CONFLICT (email) DO UPDATE SET is_primary = TRUE`,
          [`ce_${randomUUID()}`, contactId, clean],
        );
        await tx.query(
          `UPDATE contacts SET primary_email = $2, version = version + 1, updated_at = NOW() WHERE id = $1`,
          [contactId, clean],
        );
        await this.db.writeRecordHistory(tx, {
          entityType: 'contact',
          entityId: contactId,
          fieldName: 'primary_email',
          oldValue: primary,
          newValue: clean,
          changedByUserId: user.id,
        });
      } else {
        await tx.query(
          `INSERT INTO contact_emails (id, contact_id, email, is_primary, verification_status)
           VALUES ($1, $2, $3, FALSE, 'unknown')
           ON CONFLICT (email) DO NOTHING`,
          [`ce_${randomUUID()}`, contactId, clean],
        );
      }

      const emails = await tx.query<Row>(
        `SELECT email, is_primary, verification_status FROM contact_emails
         WHERE contact_id = $1 ORDER BY is_primary DESC, email ASC`,
        [contactId],
      );
      return { emails: emails.rows };
    });
  }

  async setPrimaryContactEmail(
    user: SessionUser,
    contactId: string,
    raw: unknown,
  ): Promise<{ emails: Row[] }> {
    const input = SetPrimaryContactEmailInputSchema.parse(raw);
    const clean = normalizeEmail(input.email);
    if (!clean) {
      throw new ValidationDomainError('Enter a valid email address.', {
        email: ['Enter a valid email address.'],
      });
    }

    return this.db.transaction(async (tx) => {
      const cur = await requireRecord<Row>(tx, user, 'contact', contactId, 'write', {
        forUpdate: true,
      });
      const existing = await tx.query<{ id: string }>(
        `SELECT id FROM contact_emails WHERE contact_id = $1 AND email = $2`,
        [contactId, clean],
      );
      if (!existing.rows[0]) {
        throw new NotFoundDomainError('Contact email', clean);
      }
      const oldPrimary = String(cur['primary_email']);
      if (clean !== oldPrimary) {
        await tx.query(`UPDATE contact_emails SET is_primary = FALSE WHERE contact_id = $1`, [
          contactId,
        ]);
        await tx.query(
          `UPDATE contact_emails SET is_primary = TRUE WHERE contact_id = $1 AND email = $2`,
          [contactId, clean],
        );
        await tx.query(
          `UPDATE contacts SET primary_email = $2, version = version + 1, updated_at = NOW() WHERE id = $1`,
          [contactId, clean],
        );
        await this.db.writeRecordHistory(tx, {
          entityType: 'contact',
          entityId: contactId,
          fieldName: 'primary_email',
          oldValue: oldPrimary,
          newValue: clean,
          changedByUserId: user.id,
        });
      }
      const emails = await tx.query<Row>(
        `SELECT email, is_primary, verification_status FROM contact_emails
         WHERE contact_id = $1 ORDER BY is_primary DESC, email ASC`,
        [contactId],
      );
      return { emails: emails.rows };
    });
  }

  async removeContactEmail(
    user: SessionUser,
    contactId: string,
    rawEmail: string,
  ): Promise<{ emails: Row[] }> {
    const clean = normalizeEmail(rawEmail);
    if (!clean) {
      throw new ValidationDomainError('Enter a valid email address.', {
        email: ['Enter a valid email address.'],
      });
    }
    return this.db.transaction(async (tx) => {
      const cur = await requireRecord<Row>(tx, user, 'contact', contactId, 'write', {
        forUpdate: true,
      });
      if (clean === String(cur['primary_email'])) {
        throw new ValidationDomainError(
          'Make another email primary before removing this address.',
          { email: ['Cannot remove the primary email address.'] },
        );
      }
      await tx.query(`DELETE FROM contact_emails WHERE contact_id = $1 AND email = $2`, [
        contactId,
        clean,
      ]);
      const emails = await tx.query<Row>(
        `SELECT email, is_primary, verification_status FROM contact_emails
         WHERE contact_id = $1 ORDER BY is_primary DESC, email ASC`,
        [contactId],
      );
      return { emails: emails.rows };
    });
  }

  async addContactPhone(
    user: SessionUser,
    contactId: string,
    raw: unknown,
  ): Promise<{ phones: Row[] }> {
    const input = AddContactPhoneInputSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      const cur = await requireRecord<Row>(tx, user, 'contact', contactId, 'write', {
        forUpdate: true,
      });
      const region = cur['market'] === 'CA' ? 'CA' : 'US';
      const e164 = normalizePhone(input.phone, region);
      if (!e164) {
        throw new ValidationDomainError('Enter a valid phone number.', {
          phone: ['Enter a valid phone number with area or country code.'],
        });
      }

      const oldPrimary = (cur['phone_e164'] as string | null) ?? null;
      if (oldPrimary) {
        await tx.query(
          `INSERT INTO contact_phones (id, contact_id, phone_e164, phone_label, is_primary)
           SELECT $1, $2, $3, 'work', TRUE
           WHERE NOT EXISTS (
             SELECT 1 FROM contact_phones WHERE contact_id = $2 AND phone_e164 = $3
           )`,
          [`cp_${randomUUID()}`, contactId, oldPrimary],
        );
      }

      const makePrimary = input.makePrimary || !oldPrimary;
      if (makePrimary) {
        await tx.query(`UPDATE contact_phones SET is_primary = FALSE WHERE contact_id = $1`, [
          contactId,
        ]);
      }

      const existing = await tx.query<{ id: string }>(
        `SELECT id FROM contact_phones WHERE contact_id = $1 AND phone_e164 = $2`,
        [contactId, e164],
      );
      if (existing.rows[0]) {
        await tx.query(
          `UPDATE contact_phones SET phone_label = $2, is_primary = $3 WHERE id = $1`,
          [existing.rows[0].id, input.label, makePrimary],
        );
      } else {
        await tx.query(
          `INSERT INTO contact_phones (id, contact_id, phone_e164, phone_label, is_primary)
           VALUES ($1, $2, $3, $4, $5)`,
          [`cp_${randomUUID()}`, contactId, e164, input.label, makePrimary],
        );
      }

      if (makePrimary && e164 !== oldPrimary) {
        await tx.query(
          `UPDATE contacts SET phone_e164 = $2, version = version + 1, updated_at = NOW() WHERE id = $1`,
          [contactId, e164],
        );
        await this.db.writeRecordHistory(tx, {
          entityType: 'contact',
          entityId: contactId,
          fieldName: 'phone_e164',
          oldValue: oldPrimary,
          newValue: e164,
          changedByUserId: user.id,
        });
      }

      const phones = await tx.query<Row>(
        `SELECT phone_e164, phone_label, is_primary FROM contact_phones
         WHERE contact_id = $1 ORDER BY is_primary DESC, created_at ASC`,
        [contactId],
      );
      return { phones: phones.rows };
    });
  }

  async setPrimaryContactPhone(
    user: SessionUser,
    contactId: string,
    raw: unknown,
  ): Promise<{ phones: Row[] }> {
    const input = SetPrimaryContactPhoneInputSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      const cur = await requireRecord<Row>(tx, user, 'contact', contactId, 'write', {
        forUpdate: true,
      });
      const existing = await tx.query<{ id: string }>(
        `SELECT id FROM contact_phones WHERE contact_id = $1 AND phone_e164 = $2`,
        [contactId, input.phoneE164],
      );
      if (!existing.rows[0]) {
        throw new NotFoundDomainError('Contact phone', input.phoneE164);
      }
      const oldPrimary = (cur['phone_e164'] as string | null) ?? null;
      await tx.query(`UPDATE contact_phones SET is_primary = FALSE WHERE contact_id = $1`, [
        contactId,
      ]);
      await tx.query(
        `UPDATE contact_phones SET is_primary = TRUE WHERE contact_id = $1 AND phone_e164 = $2`,
        [contactId, input.phoneE164],
      );
      if (input.phoneE164 !== oldPrimary) {
        await tx.query(
          `UPDATE contacts SET phone_e164 = $2, version = version + 1, updated_at = NOW() WHERE id = $1`,
          [contactId, input.phoneE164],
        );
        await this.db.writeRecordHistory(tx, {
          entityType: 'contact',
          entityId: contactId,
          fieldName: 'phone_e164',
          oldValue: oldPrimary,
          newValue: input.phoneE164,
          changedByUserId: user.id,
        });
      }
      const phones = await tx.query<Row>(
        `SELECT phone_e164, phone_label, is_primary FROM contact_phones
         WHERE contact_id = $1 ORDER BY is_primary DESC, created_at ASC`,
        [contactId],
      );
      return { phones: phones.rows };
    });
  }

  async removeContactPhone(
    user: SessionUser,
    contactId: string,
    phoneE164: string,
  ): Promise<{ phones: Row[] }> {
    return this.db.transaction(async (tx) => {
      const cur = await requireRecord<Row>(tx, user, 'contact', contactId, 'write', {
        forUpdate: true,
      });
      await tx.query(`DELETE FROM contact_phones WHERE contact_id = $1 AND phone_e164 = $2`, [
        contactId,
        phoneE164,
      ]);

      const remaining = await tx.query<{ id: string; phone_e164: string; is_primary: boolean }>(
        `SELECT id, phone_e164, is_primary FROM contact_phones
         WHERE contact_id = $1 ORDER BY is_primary DESC, created_at ASC`,
        [contactId],
      );
      const nextPrimary = remaining.rows[0] ?? null;
      if (nextPrimary && !nextPrimary.is_primary) {
        await tx.query(`UPDATE contact_phones SET is_primary = TRUE WHERE id = $1`, [
          nextPrimary.id,
        ]);
      }
      const nextPhoneVal = nextPrimary?.phone_e164 ?? null;
      const oldPrimary = (cur['phone_e164'] as string | null) ?? null;
      if (nextPhoneVal !== oldPrimary) {
        await tx.query(
          `UPDATE contacts SET phone_e164 = $2, version = version + 1, updated_at = NOW() WHERE id = $1`,
          [contactId, nextPhoneVal],
        );
        await this.db.writeRecordHistory(tx, {
          entityType: 'contact',
          entityId: contactId,
          fieldName: 'phone_e164',
          oldValue: oldPrimary,
          newValue: nextPhoneVal,
          changedByUserId: user.id,
        });
      }

      const phones = await tx.query<Row>(
        `SELECT phone_e164, phone_label, is_primary FROM contact_phones
         WHERE contact_id = $1 ORDER BY is_primary DESC, created_at ASC`,
        [contactId],
      );
      return { phones: phones.rows };
    });
  }

  // -------------------------------------------------------------------------
  // Companies (PRD 4.3)
  // -------------------------------------------------------------------------

  async updateCompany(user: SessionUser, companyId: string, raw: unknown): Promise<Row> {
    const input = UpdateCompanyInputSchema.parse(raw);
    if (input.timezone !== undefined && !isValidTimeZone(input.timezone)) {
      throw new ValidationDomainError('Choose a valid time zone.', {
        timezone: ['Use an IANA time zone such as America/Chicago.'],
      });
    }
    return this.db.transaction(async (tx) => {
      const cur = await requireRecord<Row>(tx, user, 'company', companyId, 'write', {
        forUpdate: true,
      });
      if (cur['version'] !== input.version) throw new VersionConflictError('Company', companyId);

      let domain = (cur['domain'] as string | null) ?? null;
      if (input.websiteOrDomain !== undefined) {
        const candidate = input.websiteOrDomain ? normalizeDomain(input.websiteOrDomain) : null;
        if (candidate && isFreeMailDomain(candidate)) {
          throw new ValidationDomainError("Free email domains can't be a company domain.", {
            websiteOrDomain: ['Use the firm’s own website.'],
          });
        }
        domain = candidate;
        if (domain && domain !== cur['domain']) {
          const other = await tx.query<{ name: string }>(
            `SELECT name FROM companies WHERE domain = $1 AND id <> $2 AND deleted_at IS NULL LIMIT 1`,
            [domain, companyId],
          );
          if (other.rows[0]) {
            throw new DomainError({
              status: 409,
              code: 'DUPLICATE_COMPANY_DOMAIN',
              title: 'Domain already in use',
              detail: `${domain} already belongs to ${other.rows[0].name}. Merge the two companies instead.`,
              fieldErrors: { websiteOrDomain: ['Another company has this domain.'] },
            });
          }
        }
      }

      let ownerId = cur['owner_user_id'] as string;
      let teamId = (cur['team_id'] as string | null) ?? null;
      let newOwnerName: string | null = null;
      if (input.ownerUserId && input.ownerUserId !== ownerId) {
        const target = await resolveAssignee(tx, user, input.ownerUserId, 'companies.write');
        ownerId = target.id;
        teamId = target.team_id;
        newOwnerName = target.name;
      }
      const accountStatus = input.accountStatus ?? (cur['account_status'] as string);

      const updated = await tx.query<Row>(
        `UPDATE companies SET
           name = $3, domain = $4, website = $5, firm_type = $6, market = $7, state_province = $8,
           city = $9, timezone = $10, staff_band = $11, account_status = $12, owner_user_id = $13,
           team_id = $14, accounting_software = $15::jsonb, services_needed = $16::jsonb,
           version = version + 1, updated_at = NOW()
         WHERE id = $1 AND version = $2 AND deleted_at IS NULL
         RETURNING *`,
        [
          companyId,
          input.version,
          input.name?.trim() ?? cur['name'],
          domain,
          domain ? `https://${domain}` : null,
          input.firmType ?? cur['firm_type'],
          input.market ?? cur['market'],
          input.stateProvince === undefined ? cur['state_province'] : input.stateProvince || null,
          input.city === undefined ? cur['city'] : input.city || null,
          input.timezone ?? cur['timezone'],
          input.staffBand ?? cur['staff_band'],
          accountStatus,
          ownerId,
          teamId,
          JSON.stringify(input.accountingSoftware ?? cur['accounting_software'] ?? []),
          JSON.stringify(input.servicesNeeded ?? cur['services_needed'] ?? []),
        ],
      );
      const next = updated.rows[0];
      if (!next) throw new VersionConflictError('Company', companyId);
      await writeChanges(this.db, tx, 'company', companyId, cur, next, COMPANY_TRACKED, user.id);

      // PRD 4.3: "Do not contact" suppresses the whole domain for automated mail.
      if (
        accountStatus === 'do_not_contact' &&
        cur['account_status'] !== 'do_not_contact' &&
        domain
      ) {
        await tx.query(
          `INSERT INTO suppressed_domains (id, domain, reason, actor_user_id)
           VALUES ($1, $2, 'Company marked do not contact', $3)
           ON CONFLICT (domain) DO NOTHING`,
          [`sdm_${randomUUID()}`, domain, user.id],
        );
      }
      await this.db.addOutboxEvent(tx, {
        eventType: 'company.updated',
        aggregateType: 'company',
        aggregateId: companyId,
        payload: { companyId },
      });
      if (newOwnerName) {
        await this.recordAssignment(tx, user, 'company', companyId, next, ownerId, newOwnerName);
      }
      return next;
    });
  }

  // -------------------------------------------------------------------------
  // Deals (PRD 4.6)
  // -------------------------------------------------------------------------

  async updateDeal(user: SessionUser, dealId: string, raw: unknown): Promise<Row> {
    const input = UpdateDealInputSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      const cur = await requireRecord<Row>(tx, user, 'deal', dealId, 'write', { forUpdate: true });
      if (cur['version'] !== input.version) throw new VersionConflictError('Deal', dealId);

      if (input.primaryContactId) {
        const contact = await requireRecord<Row>(
          tx,
          user,
          'contact',
          input.primaryContactId,
          'read',
        );
        if (contact['company_id'] && contact['company_id'] !== cur['company_id']) {
          throw new ValidationDomainError("The primary contact must work at the deal's company.", {
            primaryContactId: ['Pick a contact at this company.'],
          });
        }
      }

      let ownerId = cur['owner_user_id'] as string;
      let teamId = (cur['team_id'] as string | null) ?? null;
      let newOwnerName: string | null = null;
      if (input.ownerUserId && input.ownerUserId !== ownerId) {
        const target = await resolveAssignee(tx, user, input.ownerUserId, 'deals.write');
        ownerId = target.id;
        teamId = target.team_id;
        newOwnerName = target.name;
      }

      // Probability: a number overrides the stage default; null goes back to the default.
      let probability = cur['probability'] as number;
      let override = cur['probability_override'] as boolean;
      if (input.probability === null) {
        const stage = await tx.query<{ probability: number }>(
          `SELECT probability FROM pipeline_stages WHERE id = $1`,
          [cur['stage_id']],
        );
        probability = stage.rows[0]?.probability ?? probability;
        override = false;
      } else if (input.probability !== undefined) {
        probability = input.probability;
        override = true;
      }

      const monthly = input.monthlyValueMinor ?? String(cur['monthly_value_minor']);
      const updated = await tx.query<Row>(
        `UPDATE deals SET
           name = $3, primary_contact_id = $4, monthly_value_minor = $5,
           annual_value_minor = $5::bigint * 12, one_time_value_minor = $6, term_months = $7,
           currency = $8, fte_count = $9, engagement_model = $10, services = $11::jsonb,
           probability = $12, probability_override = $13, expected_close_date = $14,
           owner_user_id = $15, team_id = $16, trial_candidate_role = $17,
           version = version + 1, updated_at = NOW(), last_activity_at = NOW()
         WHERE id = $1 AND version = $2 AND deleted_at IS NULL
         RETURNING *`,
        [
          dealId,
          input.version,
          input.name ?? cur['name'],
          input.primaryContactId === undefined ? cur['primary_contact_id'] : input.primaryContactId,
          monthly,
          input.oneTimeValueMinor ?? String(cur['one_time_value_minor'] ?? '0'),
          input.termMonths ?? cur['term_months'],
          input.currency ?? cur['currency'],
          input.fteCount ?? cur['fte_count'],
          input.engagementModel ?? cur['engagement_model'],
          JSON.stringify(input.services ?? cur['services'] ?? []),
          probability,
          override,
          input.expectedCloseDate === undefined
            ? cur['expected_close_date']
            : input.expectedCloseDate,
          ownerId,
          teamId,
          input.trialCandidateRole === undefined
            ? cur['trial_candidate_role']
            : input.trialCandidateRole || null,
        ],
      );
      const next = updated.rows[0];
      if (!next) throw new VersionConflictError('Deal', dealId);
      await writeChanges(this.db, tx, 'deal', dealId, cur, next, DEAL_TRACKED, user.id);
      await this.db.addOutboxEvent(tx, {
        eventType: 'deal.updated',
        aggregateType: 'deal',
        aggregateId: dealId,
        payload: { dealId },
      });
      if (newOwnerName) {
        await this.recordAssignment(tx, user, 'deal', dealId, next, ownerId, newOwnerName);
      }
      return next;
    });
  }

  private async queryDealContacts(
    q: Pick<DbTx, 'query'>,
    dealId: string,
  ): Promise<DealContactView[]> {
    const res = await q.query<{
      id: string;
      deal_id: string;
      contact_id: string;
      full_name: string;
      title: string | null;
      primary_email: string;
      role: string;
      created_at: Date | string;
    }>(
      `SELECT dc.id, dc.deal_id, dc.contact_id, c.full_name, c.title, c.primary_email, dc.role, dc.created_at
       FROM deal_contacts dc
       JOIN contacts c ON c.id = dc.contact_id
       WHERE dc.deal_id = $1 AND c.deleted_at IS NULL
       ORDER BY dc.created_at ASC`,
      [dealId],
    );
    return res.rows.map((r) => ({
      id: r.id,
      dealId: r.deal_id,
      contactId: r.contact_id,
      fullName: r.full_name,
      title: r.title,
      primaryEmail: r.primary_email,
      role: r.role,
      createdAt:
        r.created_at instanceof Date
          ? r.created_at.toISOString()
          : new Date(String(r.created_at)).toISOString(),
    }));
  }

  async addDealContact(
    user: SessionUser,
    dealId: string,
    raw: unknown,
  ): Promise<{ dealContacts: DealContactView[] }> {
    const input = AddDealContactInputSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requireRecord(tx, user, 'deal', dealId, 'write', { forUpdate: true });
      const contact = await requireRecord<Row>(tx, user, 'contact', input.contactId, 'read');
      const allowedRoles = await referenceList(tx, 'deal_contact_roles');
      if (allowedRoles.length > 0 && !allowedRoles.includes(input.role)) {
        throw new ValidationDomainError('Choose a role from the list.', {
          role: [`Choose one of: ${allowedRoles.join(', ')}.`],
        });
      }

      await tx.query(
        `INSERT INTO deal_contacts (id, deal_id, contact_id, role, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (deal_id, contact_id)
         DO UPDATE SET role = EXCLUDED.role`,
        [`dc_${randomUUID()}`, dealId, input.contactId, input.role, user.id],
      );
      await this.db.writeRecordHistory(tx, {
        entityType: 'deal',
        entityId: dealId,
        fieldName: 'deal_contacts',
        oldValue: null,
        newValue: { contactId: input.contactId, name: contact['full_name'], role: input.role },
        changedByUserId: user.id,
      });
      await this.db.addOutboxEvent(tx, {
        eventType: 'deal.updated',
        aggregateType: 'deal',
        aggregateId: dealId,
        payload: { dealId, addedContactId: input.contactId, role: input.role },
      });
      return { dealContacts: await this.queryDealContacts(tx, dealId) };
    });
  }

  async updateDealContact(
    user: SessionUser,
    dealId: string,
    contactId: string,
    raw: unknown,
  ): Promise<{ dealContacts: DealContactView[] }> {
    const input = UpdateDealContactInputSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await requireRecord(tx, user, 'deal', dealId, 'write', { forUpdate: true });
      const allowedRoles = await referenceList(tx, 'deal_contact_roles');
      if (allowedRoles.length > 0 && !allowedRoles.includes(input.role)) {
        throw new ValidationDomainError('Choose a role from the list.', {
          role: [`Choose one of: ${allowedRoles.join(', ')}.`],
        });
      }
      const res = await tx.query(
        `UPDATE deal_contacts SET role = $3 WHERE deal_id = $1 AND contact_id = $2 RETURNING id`,
        [dealId, contactId, input.role],
      );
      if (res.rowCount === 0) {
        throw new NotFoundDomainError('Deal contact', `${dealId}:${contactId}`);
      }
      await this.db.writeRecordHistory(tx, {
        entityType: 'deal',
        entityId: dealId,
        fieldName: 'deal_contacts',
        oldValue: { contactId },
        newValue: { contactId, role: input.role },
        changedByUserId: user.id,
      });
      return { dealContacts: await this.queryDealContacts(tx, dealId) };
    });
  }

  async removeDealContact(
    user: SessionUser,
    dealId: string,
    contactId: string,
  ): Promise<{ dealContacts: DealContactView[] }> {
    return this.db.transaction(async (tx) => {
      await requireRecord(tx, user, 'deal', dealId, 'write', { forUpdate: true });
      const res = await tx.query(
        `DELETE FROM deal_contacts WHERE deal_id = $1 AND contact_id = $2 RETURNING role`,
        [dealId, contactId],
      );
      if (res.rowCount === 0) {
        throw new NotFoundDomainError('Deal contact', `${dealId}:${contactId}`);
      }
      await this.db.writeRecordHistory(tx, {
        entityType: 'deal',
        entityId: dealId,
        fieldName: 'deal_contacts',
        oldValue: { contactId, role: res.rows[0]?.role ?? null },
        newValue: null,
        changedByUserId: user.id,
      });
      return { dealContacts: await this.queryDealContacts(tx, dealId) };
    });
  }

  // -------------------------------------------------------------------------
  // Tasks (PRD 4.7)
  // -------------------------------------------------------------------------

  private async requireTask(
    q: Parameters<typeof requireRecord>[0],
    user: SessionUser,
    taskId: string,
    mode: 'read' | 'write',
  ): Promise<Row> {
    const scope = scopeWhere(user, mode === 'read' ? 'tasks.read' : 'tasks.write', {
      ownerColumn: 'assignee_user_id',
      startParamIndex: 2,
    });
    const res = await q.query<Row>(
      `SELECT * FROM tasks WHERE id = $1 AND deleted_at IS NULL AND ${scope.sql} FOR UPDATE`,
      [taskId, ...scope.params],
    );
    const task = res.rows[0];
    if (!task) throw new NotFoundDomainError('Task', taskId);
    return task;
  }

  async updateTask(user: SessionUser, taskId: string, raw: unknown): Promise<Row> {
    const input = UpdateTaskInputSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      const cur = await this.requireTask(tx, user, taskId, 'write');
      if (cur['version'] !== input.version) throw new VersionConflictError('Task', taskId);
      if (cur['status'] === 'completed' && input.status === undefined) {
        throw new ValidationDomainError('Reopen the task before editing it.');
      }

      let assignee = cur['assignee_user_id'] as string;
      let teamId = (cur['team_id'] as string | null) ?? null;
      let newAssigneeName: string | null = null;
      if (input.assigneeUserId && input.assigneeUserId !== assignee) {
        const target = await resolveAssignee(tx, user, input.assigneeUserId, 'tasks.write');
        assignee = target.id;
        teamId = target.team_id;
        newAssigneeName = target.name;
      }
      const dueChanged = input.dueAt !== undefined;
      const reminderChanged = input.reminderAt !== undefined;

      const updated = await tx.query<Row>(
        `UPDATE tasks SET
           title = $3, task_type = $4, priority = $5, due_at = $6, reminder_at = $7,
           assignee_user_id = $8, team_id = $9, status = $10, recurrence_rule = $13,
           completed_at = CASE WHEN $10 = 'open' THEN NULL ELSE completed_at END,
           completed_by_user_id = CASE WHEN $10 = 'open' THEN NULL ELSE completed_by_user_id END,
           reminder_sent_at = CASE WHEN $11 THEN NULL ELSE reminder_sent_at END,
           overdue_notified_at = CASE WHEN $12 THEN NULL ELSE overdue_notified_at END,
           version = version + 1, updated_at = NOW()
         WHERE id = $1 AND version = $2 AND deleted_at IS NULL
         RETURNING *`,
        [
          taskId,
          input.version,
          input.title ?? cur['title'],
          input.taskType ?? cur['task_type'],
          input.priority ?? cur['priority'],
          input.dueAt ?? cur['due_at'],
          input.reminderAt === undefined ? cur['reminder_at'] : input.reminderAt,
          assignee,
          teamId,
          input.status ?? cur['status'],
          reminderChanged || dueChanged,
          dueChanged,
          input.recurrenceRule === undefined ? cur['recurrence_rule'] : input.recurrenceRule,
        ],
      );
      const next = updated.rows[0];
      if (!next) throw new VersionConflictError('Task', taskId);
      await writeChanges(
        this.db,
        tx,
        'task',
        taskId,
        cur,
        next,
        [
          'title',
          'task_type',
          'priority',
          'due_at',
          'reminder_at',
          'recurrence_rule',
          'assignee_user_id',
          'status',
        ],
        user.id,
      );
      if (newAssigneeName && assignee !== user.id) {
        await addNotification(tx, {
          userId: assignee,
          kind: 'assignment',
          title: 'Task assigned to you',
          body: `${user.name} assigned you "${String(next['title'])}".`,
          entityType: 'task',
          entityId: taskId,
        });
      }
      return next;
    });
  }

  /**
   * Completing a task logs an activity (with the outcome note as its body) and, if the task carries
   * a recurrence rule, spawns the next open occurrence idempotently (PRD 3.1, 4.7).
   */
  async completeTask(user: SessionUser, taskId: string, raw: unknown): Promise<Row> {
    const input = CompleteTaskInputSchema.parse(raw ?? {});
    return this.db.transaction(async (tx) => {
      const cur = await this.requireTask(tx, user, taskId, 'write');
      if (cur['status'] === 'completed') {
        const existingChild = await tx.query<{ id: string }>(
          `SELECT id FROM tasks WHERE parent_task_id = $1 AND deleted_at IS NULL LIMIT 1`,
          [taskId],
        );
        return { ...cur, next_task_id: existingChild.rows[0]?.id ?? null };
      }
      const res = await tx.query<Row>(
        `UPDATE tasks SET status = 'completed', completed_at = NOW(), completed_by_user_id = $2,
           outcome = $3, version = version + 1, updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [taskId, user.id, input.outcome ?? null],
      );
      const done = res.rows[0] ?? cur;
      const links = {
        leadId: (cur['lead_id'] as string | null) ?? null,
        contactId: (cur['contact_id'] as string | null) ?? null,
        companyId: (cur['company_id'] as string | null) ?? null,
        dealId: (cur['deal_id'] as string | null) ?? null,
      };
      if (links.leadId || links.contactId || links.companyId || links.dealId) {
        const primary = links.dealId
          ? ['deal', links.dealId]
          : links.contactId
            ? ['contact', links.contactId]
            : links.leadId
              ? ['lead', links.leadId]
              : ['company', links.companyId as string];
        await insertActivity(tx, {
          entityType: primary[0] as string,
          entityId: primary[1] as string,
          activityType: 'task_completed',
          title: `Completed: ${String(cur['title'])}`,
          detail: input.outcome ?? '',
          actorUserId: user.id,
          links,
          metadata: { taskId, taskType: cur['task_type'] },
        });
        if (links.dealId) {
          await tx.query(`UPDATE deals SET last_activity_at = NOW() WHERE id = $1`, [links.dealId]);
        }
      }

      let nextTaskId: string | null = null;
      const recurrence = (cur['recurrence_rule'] as RecurrenceRule | null) ?? null;
      if (recurrence) {
        const existingChild = await tx.query<{ id: string }>(
          `SELECT id FROM tasks WHERE parent_task_id = $1 AND deleted_at IS NULL LIMIT 1`,
          [taskId],
        );
        if (existingChild.rows[0]) {
          nextTaskId = existingChild.rows[0].id;
        } else {
          const assigneeMeta = await tx.query<{ timezone: string; market_focus: Market }>(
            `SELECT timezone, market_focus FROM users WHERE id = $1`,
            [cur['assignee_user_id']],
          );
          const assigneeTz = assigneeMeta.rows[0]?.timezone ?? user.timezone ?? 'UTC';
          const assigneeMarket = assigneeMeta.rows[0]?.market_focus ?? 'US';
          const prevDue =
            cur['due_at'] instanceof Date ? cur['due_at'] : new Date(String(cur['due_at']));
          const nextDue = nextRecurringDueAt(prevDue, recurrence, assigneeTz, assigneeMarket);

          let nextReminder: string | null = null;
          if (cur['reminder_at']) {
            const prevRem =
              cur['reminder_at'] instanceof Date
                ? cur['reminder_at']
                : new Date(String(cur['reminder_at']));
            const leadOffsetMs = prevDue.getTime() - prevRem.getTime();
            nextReminder = new Date(nextDue.getTime() - leadOffsetMs).toISOString();
          }

          nextTaskId = `tsk_${randomUUID()}`;
          await tx.query(
            `INSERT INTO tasks (
               id, title, task_type, priority, status, due_at, reminder_at,
               recurrence_rule, parent_task_id,
               assignee_user_id, team_id, lead_id, company_id, contact_id, deal_id, created_by_user_id
             ) VALUES (
               $1, $2, $3, $4, 'open', $5, $6,
               $7, $8,
               $9, $10, $11, $12, $13, $14, $15
             )`,
            [
              nextTaskId,
              cur['title'],
              cur['task_type'],
              cur['priority'],
              nextDue.toISOString(),
              nextReminder,
              recurrence,
              taskId,
              cur['assignee_user_id'],
              cur['team_id'] ?? null,
              links.leadId,
              links.companyId,
              links.contactId,
              links.dealId,
              user.id,
            ],
          );
          await this.db.addOutboxEvent(tx, {
            eventType: 'task.created',
            aggregateType: 'task',
            aggregateId: nextTaskId,
            payload: { taskId: nextTaskId, parentTaskId: taskId, recurrenceRule: recurrence },
          });
        }
      }

      await this.db.addOutboxEvent(tx, {
        eventType: 'task.completed',
        aggregateType: 'task',
        aggregateId: taskId,
        payload: { taskId, nextTaskId },
      });
      return { ...done, next_task_id: nextTaskId };
    });
  }

  // -------------------------------------------------------------------------
  // Soft delete (PRD 4.5 bulk delete, 7.6): needs records.delete within scope.
  // -------------------------------------------------------------------------

  async softDelete(
    user: SessionUser,
    rawEntityType: string,
    id: string,
    ipAddress: string | null,
  ): Promise<{ id: string; deleted: true }> {
    const entityType = RecordEntityTypeSchema.parse(rawEntityType);
    requireCapability(user, 'records.delete');
    return this.db.transaction(async (tx) => {
      const scope = scopeWhere(user, 'records.delete', { startParamIndex: 2 });
      const table = RECORD_TABLES[entityType].table;
      const res = await tx.query(
        `UPDATE ${table} SET deleted_at = NOW(), version = version + 1, updated_at = NOW()
         WHERE id = $1 AND deleted_at IS NULL AND ${scope.sql}
         RETURNING id`,
        [id, ...scope.params],
      );
      if (res.rowCount === 0) throw new NotFoundDomainError(RECORD_TABLES[entityType].label, id);
      if (entityType === 'deal' || entityType === 'contact' || entityType === 'lead') {
        await tx.query(
          `UPDATE tasks SET status = 'cancelled', updated_at = NOW()
           WHERE ${entityType}_id = $1 AND status = 'open'`,
          [id],
        );
      }
      await this.db.writeAuditLog(tx, {
        actorUserId: user.id,
        actorEmail: user.email,
        action: 'record.deleted',
        entityType,
        entityId: id,
        ipAddress,
      });
      return { id, deleted: true as const };
    });
  }

  // -------------------------------------------------------------------------

  private async recordAssignment(
    tx: Parameters<typeof insertActivity>[0],
    user: SessionUser,
    entityType: 'lead' | 'contact' | 'company' | 'deal',
    id: string,
    row: Row,
    ownerId: string,
    ownerName: string,
  ): Promise<void> {
    const label =
      (row['full_name'] as string | undefined) ?? (row['name'] as string | undefined) ?? id;
    await insertActivity(tx, {
      entityType,
      entityId: id,
      activityType: 'assignment',
      title: `Assigned to ${ownerName}`,
      detail: `${user.name} assigned this ${entityType} to ${ownerName}.`,
      actorUserId: user.id,
      links: {
        leadId: entityType === 'lead' ? id : null,
        contactId: entityType === 'contact' ? id : null,
        companyId: entityType === 'company' ? id : ((row['company_id'] as string | null) ?? null),
        dealId: entityType === 'deal' ? id : null,
      },
    });
    await this.db.addOutboxEvent(tx, {
      eventType: `${entityType}.assigned`,
      aggregateType: entityType,
      aggregateId: id,
      payload: { id, ownerUserId: ownerId, assignedBy: user.id },
    });
    if (ownerId !== user.id) {
      await addNotification(tx, {
        userId: ownerId,
        kind: 'assignment',
        title: `New ${entityType} assigned to you`,
        body: `${user.name} assigned you ${label}.`,
        entityType,
        entityId: id,
      });
    }
  }
}
