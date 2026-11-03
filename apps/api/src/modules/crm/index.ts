import { randomUUID } from 'node:crypto';
import {
  ConvertLeadInputSchema,
  CreateCompanyInputSchema,
  CreateContactInputSchema,
  CreateDealInputSchema,
  CreateLeadInputSchema,
  CreateTaskInputSchema,
  MoveDealStageInputSchema,
  UpdateCompanyInputSchema,
  type ConvertLeadInput,
  type CreateCompanyInput,
  type CreateContactInput,
  type CreateDealInput,
  type CreateLeadInput,
  type CreateTaskInput,
  type MoveDealStageInput,
  type SessionUser,
  type UpdateCompanyInput,
} from '@adas/shared';
import { type DatabaseService } from '../../platform/db/index.js';
import {
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

export class CrmService {
  constructor(private readonly db: DatabaseService) {}

  // -------------------------------------------------------------------------
  // Companies (PRD §4.3)
  // -------------------------------------------------------------------------

  async listCompanies(user: SessionUser): Promise<Record<string, unknown>[]> {
    const scope = scopeWhere(user, 'companies.read', { alias: 'c', startParamIndex: 1 });
    const res = await this.db.query(
      `SELECT c.*
       FROM companies c
       WHERE c.deleted_at IS NULL AND ${scope.sql}
       ORDER BY c.updated_at DESC`,
      scope.params,
    );
    return res.rows;
  }

  async getCompany(user: SessionUser, companyId: string): Promise<Record<string, unknown>> {
    const scope = scopeWhere(user, 'companies.read', { alias: 'c', startParamIndex: 2 });
    const res = await this.db.query(
      `SELECT c.*
       FROM companies c
       WHERE c.id = $1 AND c.deleted_at IS NULL AND ${scope.sql}
       LIMIT 1`,
      [companyId, ...scope.params],
    );
    const company = res.rows[0];
    if (!company) {
      throw new NotFoundDomainError('Company', companyId);
    }
    return company;
  }

  /**
   * PRD §4.3 (A3) — Normalizes company domain (strips protocol/www/path/port),
   * blocks free-mail domains from being stored as company domains, and deduplicates
   * against existing active companies by normalized domain.
   */
  async createOrFindCompany(
    user: SessionUser,
    rawInput: CreateCompanyInput,
  ): Promise<{ company: Record<string, unknown>; created: boolean }> {
    requireCapability(user, 'companies.write');
    const input = CreateCompanyInputSchema.parse(rawInput);
    const rawDomain = input.websiteOrDomain ? normalizeDomain(input.websiteOrDomain) : null;
    const domain = rawDomain && !isFreeMailDomain(rawDomain) ? rawDomain : null;

    return this.db.transaction(async (tx) => {
      if (domain) {
        const existing = await tx.query(
          `SELECT * FROM companies WHERE domain = $1 AND deleted_at IS NULL LIMIT 1`,
          [domain],
        );
        if (existing.rows[0]) {
          return { company: existing.rows[0], created: false };
        }
      }

      const id = `cmp_${randomUUID()}`;
      const ownerId = input.ownerUserId ?? user.id;
      const teamId = user.teamId ?? 'team_us';

      const inserted = await tx.query(
        `INSERT INTO companies (
           id, name, domain, website, firm_type, market, state_province, city, timezone,
           staff_band, account_status, owner_user_id, team_id, accounting_software,
           services_needed, estimated_revenue_minor, currency, version
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9,
           $10, $11, $12, $13, $14::jsonb,
           $15::jsonb, $16, $17, 1
         ) RETURNING *`,
        [
          id,
          input.name.trim(),
          domain,
          domain ? `https://${domain}` : null,
          input.firmType,
          input.market,
          input.stateProvince ?? null,
          input.city ?? null,
          input.timezone,
          input.staffBand,
          input.accountStatus,
          ownerId,
          teamId,
          JSON.stringify(input.accountingSoftware),
          JSON.stringify(input.servicesNeeded),
          input.estimatedRevenueMinor,
          input.currency,
        ],
      );

      const company = inserted.rows[0] ?? { id };
      await this.db.addOutboxEvent(tx, {
        eventType: 'company.created',
        aggregateType: 'company',
        aggregateId: id,
        payload: { id, name: input.name, domain, market: input.market },
      });

      return { company, created: true };
    });
  }

  /**
   * PRD §6.5 & §7 (A4) — Optimistic concurrency update (`WHERE id = $1 AND version = $2`).
   * Writes `record_history` for changed fields.
   */
  async updateCompany(
    user: SessionUser,
    companyId: string,
    rawInput: UpdateCompanyInput,
  ): Promise<Record<string, unknown>> {
    const scope = scopeWhere(user, 'companies.write', { startParamIndex: 2 });
    const input = UpdateCompanyInputSchema.parse(rawInput);

    return this.db.transaction(async (tx) => {
      const existingRes = await tx.query<{
        id: string;
        name: string;
        staff_band: string;
        account_status: string;
        version: number;
      }>(
        `SELECT id, name, staff_band, account_status, version
         FROM companies
         WHERE id = $1 AND deleted_at IS NULL AND ${scope.sql}
         LIMIT 1`,
        [companyId, ...scope.params],
      );

      const current = existingRes.rows[0];
      if (!current) {
        throw new NotFoundDomainError('Company', companyId);
      }

      const nextName = input.name?.trim() ?? current.name;
      const nextStaffBand = input.staffBand ?? current.staff_band;
      const nextAccountStatus = input.accountStatus ?? current.account_status;

      const updated = await tx.query(
        `UPDATE companies
         SET name = $3,
             staff_band = $4,
             account_status = $5,
             version = version + 1,
             updated_at = NOW()
         WHERE id = $1 AND version = $2 AND deleted_at IS NULL
         RETURNING *`,
        [companyId, input.version, nextName, nextStaffBand, nextAccountStatus],
      );

      if (updated.rowCount === 0 || !updated.rows[0]) {
        throw new VersionConflictError('Company', companyId);
      }

      if (nextStaffBand !== current.staff_band) {
        await this.db.writeRecordHistory(tx, {
          entityType: 'company',
          entityId: companyId,
          fieldName: 'staff_band',
          oldValue: current.staff_band,
          newValue: nextStaffBand,
          changedByUserId: user.id,
        });
      }

      if (nextName !== current.name) {
        await this.db.writeRecordHistory(tx, {
          entityType: 'company',
          entityId: companyId,
          fieldName: 'name',
          oldValue: current.name,
          newValue: nextName,
          changedByUserId: user.id,
        });
      }

      return updated.rows[0];
    });
  }

  // -------------------------------------------------------------------------
  // Contacts (PRD §4.4)
  // -------------------------------------------------------------------------

  async listContacts(user: SessionUser): Promise<Record<string, unknown>[]> {
    const scope = scopeWhere(user, 'contacts.read', { alias: 'c', startParamIndex: 1 });
    const res = await this.db.query(
      `SELECT c.*, cmp.name AS company_name, cmp.domain AS company_domain
       FROM contacts c
       LEFT JOIN companies cmp ON cmp.id = c.company_id
       WHERE c.deleted_at IS NULL AND ${scope.sql}
       ORDER BY c.updated_at DESC`,
      scope.params,
    );
    return res.rows;
  }

  async createContact(
    user: SessionUser,
    rawInput: CreateContactInput,
  ): Promise<Record<string, unknown>> {
    requireCapability(user, 'contacts.write');
    const input = CreateContactInputSchema.parse(rawInput);
    const cleanEmail = normalizeEmail(input.primaryEmail);
    if (!cleanEmail) {
      throw new ValidationDomainError('Valid primary email is required.', {
        primaryEmail: ['Invalid email address'],
      });
    }

    const phoneE164 = input.phone
      ? normalizePhone(input.phone, input.market === 'CA' ? 'CA' : 'US')
      : null;
    const emailDomain = extractDomainFromEmail(cleanEmail);

    return this.db.transaction(async (tx) => {
      // Auto-link company if email domain is corporate and companyId wasn't passed
      let companyId = input.companyId ?? null;
      if (!companyId && emailDomain && !isFreeMailDomain(emailDomain)) {
        const cmpRes = await tx.query<{ id: string }>(
          `SELECT id FROM companies WHERE domain = $1 AND deleted_at IS NULL LIMIT 1`,
          [emailDomain],
        );
        companyId = cmpRes.rows[0]?.id ?? null;
      }

      const id = `cnt_${randomUUID()}`;
      const fullName = `${input.firstName.trim()} ${input.lastName.trim()}`.trim();
      const ownerId = input.ownerUserId ?? user.id;
      const teamId = user.teamId ?? 'team_us';

      const inserted = await tx.query(
        `INSERT INTO contacts (
           id, company_id, first_name, last_name, full_name, title, job_function, seniority,
           primary_email, phone_e164, market, timezone, owner_user_id, team_id, do_not_contact
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8,
           $9, $10, $11, $12, $13, $14, $15
         ) RETURNING *`,
        [
          id,
          companyId,
          input.firstName.trim(),
          input.lastName.trim(),
          fullName,
          input.title,
          input.jobFunction,
          input.seniority,
          cleanEmail,
          phoneE164,
          input.market,
          input.timezone,
          ownerId,
          teamId,
          input.doNotContact,
        ],
      );

      await tx.query(
        `INSERT INTO contact_emails (id, contact_id, email, is_primary, verification_status)
         VALUES ($1, $2, $3, TRUE, 'unknown')
         ON CONFLICT (email) DO NOTHING`,
        [`ce_${randomUUID()}`, id, cleanEmail],
      );

      for (const sec of input.secondaryEmails) {
        const cleanSec = normalizeEmail(sec);
        if (cleanSec && cleanSec !== cleanEmail) {
          await tx.query(
            `INSERT INTO contact_emails (id, contact_id, email, is_primary, verification_status)
             VALUES ($1, $2, $3, FALSE, 'unknown')
             ON CONFLICT (email) DO NOTHING`,
            [`ce_${randomUUID()}`, id, cleanSec],
          );
        }
      }

      if (phoneE164) {
        await tx.query(
          `INSERT INTO contact_phones (id, contact_id, phone_e164, phone_label, is_primary)
           VALUES ($1, $2, $3, 'work', TRUE)`,
          [`cp_${randomUUID()}`, id, phoneE164],
        );
      }

      return inserted.rows[0] ?? { id };
    });
  }

  // -------------------------------------------------------------------------
  // Leads & Lead Conversion (PRD §4.1 & §4.2)
  // -------------------------------------------------------------------------

  async listLeads(user: SessionUser): Promise<Record<string, unknown>[]> {
    const scope = scopeWhere(user, 'leads.read', { alias: 'l', startParamIndex: 1 });
    const res = await this.db.query(
      `SELECT l.*
       FROM leads l
       WHERE l.deleted_at IS NULL AND ${scope.sql}
       ORDER BY l.updated_at DESC`,
      scope.params,
    );
    return res.rows;
  }

  async createLead(user: SessionUser, rawInput: CreateLeadInput): Promise<Record<string, unknown>> {
    requireCapability(user, 'leads.write');
    const input = CreateLeadInputSchema.parse(rawInput);
    const cleanEmail = normalizeEmail(input.email);
    if (!cleanEmail) {
      throw new ValidationDomainError('Valid lead email is required.');
    }

    const emailDomain = extractDomainFromEmail(cleanEmail);
    const rawWebDomain = input.website ? normalizeDomain(input.website) : emailDomain;
    const corporateDomain = rawWebDomain && !isFreeMailDomain(rawWebDomain) ? rawWebDomain : null;
    const phoneE164 = input.phone
      ? normalizePhone(input.phone, input.market === 'CA' ? 'CA' : 'US')
      : null;

    return this.db.transaction(async (tx) => {
      const id = `lead_${randomUUID()}`;
      const fullName = `${input.firstName.trim()} ${input.lastName.trim()}`.trim();
      const ownerId = input.ownerUserId ?? user.id;
      const teamId = user.teamId ?? (input.market === 'CA' ? 'team_ca' : 'team_us');
      const statusCategory =
        input.status === 'Qualified'
          ? 'qualified'
          : input.status === 'Disqualified' || input.status === 'Converted'
            ? 'closed'
            : 'open';

      const inserted = await tx.query(
        `INSERT INTO leads (
           id, first_name, last_name, full_name, email, phone_e164, firm_name, domain, website,
           title, market, state_province, staff_band, source, status, status_category,
           services_needed, software_stack, owner_user_id, team_id, version
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9,
           $10, $11, $12, $13, $14, $15, $16,
           $17::jsonb, $18::jsonb, $19, $20, 1
         ) RETURNING *`,
        [
          id,
          input.firstName.trim(),
          input.lastName.trim(),
          fullName,
          cleanEmail,
          phoneE164,
          corporateDomain ? (input.firmName ?? corporateDomain) : (input.firmName ?? null),
          corporateDomain,
          corporateDomain ? `https://${corporateDomain}` : null,
          input.title,
          input.market,
          input.stateProvince ?? null,
          input.staffBand,
          input.source,
          input.status,
          statusCategory,
          JSON.stringify(input.servicesNeeded),
          JSON.stringify(input.softwareStack),
          ownerId,
          teamId,
        ],
      );

      await tx.query(
        `INSERT INTO lead_status_history (id, lead_id, from_status, to_status, changed_by_user_id)
         VALUES ($1, $2, NULL, $3, $4)`,
        [`lsh_${randomUUID()}`, id, input.status, user.id],
      );

      await this.db.addOutboxEvent(tx, {
        eventType: 'lead.created',
        aggregateType: 'lead',
        aggregateId: id,
        payload: { id, email: cleanEmail, market: input.market, source: input.source },
      });

      return inserted.rows[0] ?? { id };
    });
  }

  /**
   * PRD §4.2 & §4.5 (A7) — Lead conversion in one database transaction:
   * - Creates or links Company (unless free-mail domain without firm name)
   * - Creates or links Contact
   * - Optionally creates Deal; if `startFreeTrial` is true, places Deal in
   *   `Free Trial (3-Day)` stage and creates Day-1, Day-2, and Day-3 check-in tasks!
   * - Marks Lead `Converted` (`status_category = 'closed'`)
   */
  async convertLead(
    user: SessionUser,
    rawInput: ConvertLeadInput,
  ): Promise<{
    leadId: string;
    companyId: string | null;
    contactId: string;
    dealId: string | null;
    trialTaskIds: string[];
  }> {
    const scope = scopeWhere(user, 'leads.convert', { startParamIndex: 2 });
    const input = ConvertLeadInputSchema.parse(rawInput);

    return this.db.transaction(async (tx) => {
      const leadRes = await tx.query<{
        id: string;
        first_name: string;
        last_name: string;
        full_name: string;
        email: string;
        phone_e164: string | null;
        firm_name: string | null;
        domain: string | null;
        title: string;
        market: 'US' | 'CA' | 'OTHER';
        state_province: string | null;
        staff_band: string;
        owner_user_id: string;
        team_id: string | null;
        company_id: string | null;
        contact_id: string | null;
        status: string;
      }>(`SELECT * FROM leads WHERE id = $1 AND deleted_at IS NULL AND ${scope.sql} LIMIT 1`, [
        input.leadId,
        ...scope.params,
      ]);

      const lead = leadRes.rows[0];
      if (!lead) {
        throw new NotFoundDomainError('Lead', input.leadId);
      }

      // 1. Resolve or create Company
      let companyId = lead.company_id;
      const cleanDomain = lead.domain && !isFreeMailDomain(lead.domain) ? lead.domain : null;
      if (!companyId && cleanDomain) {
        const existingCmp = await tx.query<{ id: string }>(
          `SELECT id FROM companies WHERE domain = $1 AND deleted_at IS NULL LIMIT 1`,
          [cleanDomain],
        );
        companyId = existingCmp.rows[0]?.id ?? null;
      }
      if (!companyId && (cleanDomain || lead.firm_name)) {
        companyId = `cmp_${randomUUID()}`;
        await tx.query(
          `INSERT INTO companies (
             id, name, domain, website, market, state_province, staff_band,
             account_status, owner_user_id, team_id
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'prospect', $8, $9)`,
          [
            companyId,
            lead.firm_name ?? cleanDomain ?? `${lead.full_name} CPA`,
            cleanDomain,
            cleanDomain ? `https://${cleanDomain}` : null,
            lead.market,
            lead.state_province,
            lead.staff_band,
            lead.owner_user_id,
            lead.team_id,
          ],
        );
      }

      // 2. Resolve or create Contact
      let contactId = lead.contact_id;
      if (!contactId) {
        const existingCnt = await tx.query<{ id: string }>(
          `SELECT id FROM contacts WHERE primary_email = $1 AND deleted_at IS NULL LIMIT 1`,
          [lead.email],
        );
        contactId = existingCnt.rows[0]?.id ?? null;
      }
      if (!contactId) {
        contactId = `cnt_${randomUUID()}`;
        await tx.query(
          `INSERT INTO contacts (
             id, company_id, first_name, last_name, full_name, title,
             primary_email, phone_e164, market, owner_user_id, team_id
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            contactId,
            companyId,
            lead.first_name,
            lead.last_name,
            lead.full_name,
            lead.title,
            lead.email,
            lead.phone_e164,
            lead.market,
            lead.owner_user_id,
            lead.team_id,
          ],
        );
        await tx.query(
          `INSERT INTO contact_emails (id, contact_id, email, is_primary, verification_status)
           VALUES ($1, $2, $3, TRUE, 'valid')
           ON CONFLICT (email) DO NOTHING`,
          [`ce_${randomUUID()}`, contactId, lead.email],
        );
      }

      // 3. Create Deal if requested
      let dealId: string | null = null;
      const trialTaskIds: string[] = [];

      if (input.createDeal && companyId) {
        dealId = `deal_${randomUUID()}`;
        const monthlyMinor = BigInt(input.monthlyValueMinor);
        const annualMinor = monthlyMinor * 12n;
        const stageId = input.startFreeTrial ? 'stg_trial' : 'stg_disc';
        const stageName = input.startFreeTrial ? 'Free Trial (3-Day)' : 'Discovery Scheduled';
        const probability = input.startFreeTrial ? 50 : 25;
        const dealName =
          input.dealName ??
          `${lead.firm_name ?? lead.full_name} — ${input.services[0] ?? 'Staffing'} Pod (${input.fteCount} FTE)`;

        await tx.query(
          `INSERT INTO deals (
             id, pipeline_id, stage_id, stage_name, stage_category, company_id, primary_contact_id,
             name, monthly_value_minor, annual_value_minor, currency, fte_count, engagement_model,
             services, probability, trial_started_at, trial_ends_at, trial_candidate_role,
             owner_user_id, team_id
           ) VALUES (
             $1, 'pipeline_new_business', $2, $3, 'open', $4, $5,
             $6, $7, $8, $9, $10, $11,
             $12::jsonb, $13,
             CASE WHEN $14 THEN NOW() ELSE NULL END,
             CASE WHEN $14 THEN NOW() + INTERVAL '3 days' ELSE NULL END,
             CASE WHEN $14 THEN 'Senior Tax & Accounting Specialist' ELSE NULL END,
             $15, $16
           )`,
          [
            dealId,
            stageId,
            stageName,
            companyId,
            contactId,
            dealName,
            monthlyMinor.toString(),
            annualMinor.toString(),
            input.currency,
            input.fteCount,
            input.engagementModel,
            JSON.stringify(input.services),
            probability,
            input.startFreeTrial,
            lead.owner_user_id,
            lead.team_id,
          ],
        );

        if (input.startFreeTrial) {
          for (const dayOffset of [1, 2, 3]) {
            const taskId = `tsk_trial_${randomUUID()}`;
            trialTaskIds.push(taskId);
            await tx.query(
              `INSERT INTO tasks (
                 id, title, task_type, priority, status, due_at,
                 assignee_user_id, team_id, lead_id, company_id, contact_id, deal_id, created_by_user_id
               ) VALUES (
                 $1, $2, 'trial_checkin', 'high', 'open', NOW() + ($3 || ' days')::interval,
                 $4, $5, $6, $7, $8, $9, $10
               )`,
              [
                taskId,
                `Day ${dayOffset} Free Trial check-in: ${dealName}`,
                String(dayOffset),
                lead.owner_user_id,
                lead.team_id,
                lead.id,
                companyId,
                contactId,
                dealId,
                user.id,
              ],
            );
          }
        }
      }

      // 4. Mark Lead Converted
      await tx.query(
        `UPDATE leads
         SET status = 'Converted',
             status_category = 'closed',
             company_id = $2,
             contact_id = $3,
             converted_deal_id = $4,
             converted_at = NOW(),
             version = version + 1,
             updated_at = NOW()
         WHERE id = $1`,
        [lead.id, companyId, contactId, dealId],
      );

      await tx.query(
        `INSERT INTO lead_status_history (id, lead_id, from_status, to_status, changed_by_user_id)
         VALUES ($1, $2, $3, 'Converted', $4)`,
        [`lsh_${randomUUID()}`, lead.id, lead.status, user.id],
      );

      await this.db.addOutboxEvent(tx, {
        eventType: 'lead.converted',
        aggregateType: 'lead',
        aggregateId: lead.id,
        payload: {
          leadId: lead.id,
          companyId,
          contactId,
          dealId,
          startFreeTrial: input.startFreeTrial,
        },
      });

      return {
        leadId: lead.id,
        companyId,
        contactId,
        dealId,
        trialTaskIds,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Deals & Stage Transitions (PRD §4.5)
  // -------------------------------------------------------------------------

  async listDeals(user: SessionUser): Promise<Record<string, unknown>[]> {
    const scope = scopeWhere(user, 'deals.read', { alias: 'd', startParamIndex: 1 });
    const res = await this.db.query(
      `SELECT d.*, cmp.name AS company_name, cmp.market AS company_market
       FROM deals d
       JOIN companies cmp ON cmp.id = d.company_id
       WHERE d.deleted_at IS NULL AND ${scope.sql}
       ORDER BY d.updated_at DESC`,
      scope.params,
    );
    return res.rows;
  }

  async createDeal(user: SessionUser, rawInput: CreateDealInput): Promise<Record<string, unknown>> {
    requireCapability(user, 'deals.write');
    const input = CreateDealInputSchema.parse(rawInput);

    return this.db.transaction(async (tx) => {
      const stageRes = await tx.query<{
        id: string;
        name: string;
        category: string;
        probability: number;
      }>(
        `SELECT id, name, category, probability
         FROM pipeline_stages
         WHERE pipeline_id = $1 AND name = $2
         LIMIT 1`,
        [input.pipelineId, input.stageName],
      );
      const stage = stageRes.rows[0] ?? {
        id: 'stg_new',
        name: 'New Opportunity',
        category: 'open',
        probability: 10,
      };

      const id = `deal_${randomUUID()}`;
      const monthlyMinor = BigInt(input.monthlyValueMinor);
      const annualMinor = input.annualValueMinor
        ? BigInt(input.annualValueMinor)
        : monthlyMinor * 12n;

      const inserted = await tx.query(
        `INSERT INTO deals (
           id, pipeline_id, stage_id, stage_name, stage_category, company_id, primary_contact_id,
           name, monthly_value_minor, annual_value_minor, currency, fte_count, engagement_model,
           services, probability, expected_close_date, owner_user_id, team_id
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           $8, $9, $10, $11, $12, $13,
           $14::jsonb, $15, $16, $17, $18
         ) RETURNING *`,
        [
          id,
          input.pipelineId,
          stage.id,
          stage.name,
          stage.category,
          input.companyId,
          input.primaryContactId ?? null,
          input.name.trim(),
          monthlyMinor.toString(),
          annualMinor.toString(),
          input.currency,
          input.fteCount,
          input.engagementModel,
          JSON.stringify(input.services),
          stage.probability,
          input.expectedCloseDate ?? null,
          input.ownerUserId ?? user.id,
          user.teamId ?? 'team_us',
        ],
      );

      return inserted.rows[0] ?? { id };
    });
  }

  /**
   * PRD §4.5 (A8) — Stage transition with required-field gates:
   * - Moving to `Lost` requires `lostReason` (throws 422 if missing)
   * - Moving to `Free Trial (3-Day)` requires `trialCandidateRole` and creates 3-day check-in tasks
   * - Moving to `Won` sets `won_at = NOW()`, stops active prospecting sequences on the deal's contact,
   *   and emits `deal.won` outbox event.
   */
  async moveDealStage(
    user: SessionUser,
    dealId: string,
    rawInput: MoveDealStageInput,
  ): Promise<Record<string, unknown>> {
    const scope = scopeWhere(user, 'deals.write', { startParamIndex: 2 });
    const input = MoveDealStageInputSchema.parse(rawInput);

    if (input.stageName === 'Lost' && (!input.lostReason || !input.lostReason.trim())) {
      throw new ValidationDomainError('Moving a deal to Lost requires a lostReason.', {
        lostReason: ['Lost reason is required when marking a deal Lost.'],
      });
    }

    if (
      input.stageName === 'Free Trial (3-Day)' &&
      (!input.trialCandidateRole || !input.trialCandidateRole.trim())
    ) {
      throw new ValidationDomainError(
        'Moving a deal to Free Trial (3-Day) requires trialCandidateRole.',
        {
          trialCandidateRole: [
            'Trial candidate role is required when starting a 3-day free trial.',
          ],
        },
      );
    }

    return this.db.transaction(async (tx) => {
      const existingRes = await tx.query<{
        id: string;
        name: string;
        pipeline_id: string;
        stage_name: string;
        company_id: string;
        primary_contact_id: string | null;
        owner_user_id: string;
        team_id: string | null;
        version: number;
      }>(
        `SELECT id, name, pipeline_id, stage_name, company_id, primary_contact_id, owner_user_id, team_id, version
         FROM deals
         WHERE id = $1 AND deleted_at IS NULL AND ${scope.sql}
         LIMIT 1`,
        [dealId, ...scope.params],
      );

      const deal = existingRes.rows[0];
      if (!deal) {
        throw new NotFoundDomainError('Deal', dealId);
      }

      const stageRes = await tx.query<{
        id: string;
        name: string;
        category: string;
        probability: number;
      }>(
        `SELECT id, name, category, probability
         FROM pipeline_stages
         WHERE pipeline_id = $1 AND name = $2
         LIMIT 1`,
        [deal.pipeline_id, input.stageName],
      );
      const stage = stageRes.rows[0];
      if (!stage) {
        throw new ValidationDomainError(`Unknown stage '${input.stageName}'.`);
      }

      const updated = await tx.query(
        `UPDATE deals
         SET stage_id = $3,
             stage_name = $4,
             stage_category = $5,
             probability = $6,
             lost_reason = COALESCE($7, lost_reason),
             lost_notes = COALESCE($8, lost_notes),
             trial_candidate_role = COALESCE($9, trial_candidate_role),
             contract_start_date = COALESCE($10, contract_start_date),
             won_at = CASE WHEN $5 = 'won' THEN NOW() ELSE won_at END,
             lost_at = CASE WHEN $5 = 'lost' THEN NOW() ELSE lost_at END,
             trial_started_at = CASE WHEN $4 = 'Free Trial (3-Day)' THEN COALESCE(trial_started_at, NOW()) ELSE trial_started_at END,
             trial_ends_at = CASE WHEN $4 = 'Free Trial (3-Day)' THEN COALESCE(trial_ends_at, NOW() + INTERVAL '3 days') ELSE trial_ends_at END,
             version = version + 1,
             updated_at = NOW()
         WHERE id = $1 AND version = $2 AND deleted_at IS NULL
         RETURNING *`,
        [
          dealId,
          input.version,
          stage.id,
          stage.name,
          stage.category,
          stage.probability,
          input.lostReason ?? null,
          input.lostNotes ?? null,
          input.trialCandidateRole ?? null,
          input.contractStartDate ?? null,
        ],
      );

      if (updated.rowCount === 0 || !updated.rows[0]) {
        throw new VersionConflictError('Deal', dealId);
      }

      await tx.query(
        `INSERT INTO deal_stage_history (id, deal_id, from_stage, to_stage, changed_by_user_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [`dsh_${randomUUID()}`, dealId, deal.stage_name, stage.name, user.id],
      );

      if (stage.name === 'Free Trial (3-Day)' && deal.stage_name !== 'Free Trial (3-Day)') {
        for (const dayOffset of [1, 2, 3]) {
          await tx.query(
            `INSERT INTO tasks (
               id, title, task_type, priority, status, due_at,
               assignee_user_id, team_id, company_id, contact_id, deal_id, created_by_user_id
             ) VALUES (
               $1, $2, 'trial_checkin', 'high', 'open', NOW() + ($3 || ' days')::interval,
               $4, $5, $6, $7, $8, $9
             )`,
            [
              `tsk_trial_${randomUUID()}`,
              `Day ${dayOffset} Free Trial check-in: ${deal.name}`,
              String(dayOffset),
              deal.owner_user_id,
              deal.team_id,
              deal.company_id,
              deal.primary_contact_id,
              dealId,
              user.id,
            ],
          );
        }
      }

      if (stage.category === 'won') {
        await tx.query(
          `UPDATE companies SET account_status = 'client', updated_at = NOW() WHERE id = $1`,
          [deal.company_id],
        );
        if (deal.primary_contact_id) {
          await tx.query(
            `UPDATE sequence_enrollments
             SET status = 'stopped_deal_won',
                 stop_reason = 'Deal marked Won',
                 next_send_at = NULL,
                 stopped_at = NOW()
             WHERE contact_id = $1 AND status IN ('active', 'paused')`,
            [deal.primary_contact_id],
          );
        }
        await this.db.addOutboxEvent(tx, {
          eventType: 'deal.won',
          aggregateType: 'deal',
          aggregateId: dealId,
          payload: {
            dealId,
            companyId: deal.company_id,
            contactId: deal.primary_contact_id,
            name: deal.name,
          },
        });
      }

      return updated.rows[0];
    });
  }

  // -------------------------------------------------------------------------
  // Tasks (PRD §4.6)
  // -------------------------------------------------------------------------

  async listTasks(user: SessionUser): Promise<Record<string, unknown>[]> {
    const scope = scopeWhere(user, 'tasks.read', {
      alias: 't',
      ownerColumn: 'assignee_user_id',
      startParamIndex: 1,
    });
    const res = await this.db.query(
      `SELECT t.*
       FROM tasks t
       WHERE t.deleted_at IS NULL AND ${scope.sql}
       ORDER BY t.due_at ASC`,
      scope.params,
    );
    return res.rows;
  }

  async createTask(user: SessionUser, rawInput: CreateTaskInput): Promise<Record<string, unknown>> {
    requireCapability(user, 'tasks.write');
    const input = CreateTaskInputSchema.parse(rawInput);
    const id = `tsk_${randomUUID()}`;

    const res = await this.db.query(
      `INSERT INTO tasks (
         id, title, task_type, priority, status, due_at,
         assignee_user_id, team_id, lead_id, company_id, contact_id, deal_id, created_by_user_id
       ) VALUES ($1, $2, $3, $4, 'open', $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        id,
        input.title.trim(),
        input.taskType,
        input.priority,
        input.dueAt,
        input.assigneeUserId ?? user.id,
        user.teamId ?? 'team_us',
        input.leadId ?? null,
        input.companyId ?? null,
        input.contactId ?? null,
        input.dealId ?? null,
        user.id,
      ],
    );
    return res.rows[0] ?? { id };
  }

  async completeTask(user: SessionUser, taskId: string): Promise<Record<string, unknown>> {
    const scope = scopeWhere(user, 'tasks.write', {
      ownerColumn: 'assignee_user_id',
      startParamIndex: 2,
    });
    const res = await this.db.query(
      `UPDATE tasks
       SET status = 'completed', completed_at = NOW(), version = version + 1, updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL AND ${scope.sql}
       RETURNING *`,
      [taskId, ...scope.params],
    );
    if (!res.rows[0]) {
      throw new NotFoundDomainError('Task', taskId);
    }
    return res.rows[0];
  }
}
