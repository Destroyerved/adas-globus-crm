import { randomUUID } from 'node:crypto';
import {
  InquiryListQuerySchema,
  MarketSchema,
  UpdateRoutingRuleInputSchema,
  WebsiteInquiryPayloadSchema,
  type InquiryFormType,
  type InquirySummaryView,
  type Market,
  type RoutingRuleView,
  type SessionUser,
  type UserRoleName,
  type WebsiteInquiryPayload,
} from '@adas/shared';
import { addBusinessDays } from '../../platform/calendar/index.js';
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
import {
  ROLE_CAPABILITY_MATRIX,
  requireCapability,
  type CapabilityScopeValue,
} from '../../platform/scope/index.js';
import { addNotification } from '../notifications/index.js';

export interface WebsiteInquiryResult {
  status: 'received';
  accepted: boolean;
  deduplicated: boolean;
  honeypotDropped: boolean;
  inquiryId: string | null;
  leadId: string | null;
  companyId: string | null;
  contactId: string | null;
  slaTaskId: string | null;
  assignedUserId: string | null;
}

export interface InquiryRequestMeta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

const CA_PROVINCES = new Set(
  [
    'alberta',
    'british columbia',
    'manitoba',
    'new brunswick',
    'newfoundland and labrador',
    'northwest territories',
    'nova scotia',
    'nunavut',
    'ontario',
    'prince edward island',
    'quebec',
    'québec',
    'saskatchewan',
    'yukon',
    'multiple provinces',
  ].map((p) => p.toLowerCase()),
);

function toList(value: string | string[] | null | undefined): string[] {
  if (Array.isArray(value)) return value.map((v) => v.trim()).filter(Boolean);
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * The live website forms never send `formType`. When it is missing (and `form` is not set),
 * the payload came from adasglobuspro.com, so infer the form and treat the contact form's
 * `website` field as the hidden honeypot it is there (PRD §4.10).
 */
function readWebsiteShape(raw: Record<string, unknown>): {
  fromWebsite: boolean;
  formType: InquiryFormType;
} {
  const explicitForm = raw['form'];
  if (explicitForm === 'trial' || explicitForm === 'contact' || explicitForm === 'consultation') {
    return { fromWebsite: raw['formType'] === undefined, formType: explicitForm };
  }
  const fromWebsite = raw['formType'] === undefined;
  if (!fromWebsite) {
    const ft = raw['formType'];
    return {
      fromWebsite: false,
      formType: ft === 'contact' || ft === 'consultation' ? ft : 'trial',
    };
  }
  const looksLikeContact = 'location' in raw || 'interests' in raw;
  return {
    fromWebsite: true,
    formType: looksLikeContact && !('need' in raw) ? 'contact' : 'trial',
  };
}

function marketFrom(
  country: string | null | undefined,
  location: string | null | undefined,
): Market {
  const c = country?.trim().toUpperCase();
  if (c === 'CA' || c === 'CANADA') return 'CA';
  if (c === 'US' || c === 'USA' || c === 'UNITED STATES') return 'US';
  const loc = location?.trim().toLowerCase();
  if (loc && CA_PROVINCES.has(loc)) return 'CA';
  if (loc === 'outside the u.s. and canada') return 'OTHER';
  return 'US';
}

function canUserWriteLeads(
  roleName: string,
  overrideScope: CapabilityScopeValue | null | undefined,
): boolean {
  const base = ROLE_CAPABILITY_MATRIX[roleName as UserRoleName]?.['leads.write'] ?? 'none';
  const effective = overrideScope ?? base;
  return effective !== 'none';
}

function isoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
    return value;
  }
  return new Date().toISOString();
}

function parseCursor(cursor?: string): [string | null, string | null] {
  if (!cursor) return [null, null];
  const sep = cursor.lastIndexOf('|');
  if (sep <= 0 || sep >= cursor.length - 1) {
    throw new ValidationDomainError('The page cursor is not valid. Reload the list.');
  }
  const at = cursor.slice(0, sep);
  const id = cursor.slice(sep + 1);
  if (Number.isNaN(Date.parse(at))) {
    throw new ValidationDomainError('The page cursor is not valid. Reload the list.');
  }
  return [at, id];
}

function sanitizeRawPayload(raw: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (key === 'company_website_hp' || key === '_gotcha') continue;
    if (typeof val === 'string') {
      copy[key] = val.slice(0, 4000);
    } else if (Array.isArray(val)) {
      copy[key] = val.slice(0, 40).map((item) => String(item).slice(0, 200));
    } else if (typeof val === 'boolean' || typeof val === 'number' || val === null) {
      copy[key] = val;
    }
  }
  return copy;
}

export class WebsiteIntakeService {
  private readonly rateLimitPer10Min: number;
  private readonly ipHashPepper: string;

  constructor(
    private readonly db: DatabaseService,
    options: { rateLimitPer10Min?: number; ipHashPepper?: string } = {},
  ) {
    this.rateLimitPer10Min = options.rateLimitPer10Min ?? 5;
    this.ipHashPepper = options.ipHashPepper ?? 'adas-public-intake-ip-v1';
  }

  private hashIp(ipAddress: string | null | undefined): string | null {
    const trimmed = ipAddress?.trim();
    if (!trimmed) return null;
    return sha256Hex(`${this.ipHashPepper}:${trimmed}`);
  }

  private async enforcePublicRateLimit(ipSha256: string | null): Promise<void> {
    if (!ipSha256) return;
    const recent = await this.db.query<{ cnt: number }>(
      `SELECT COUNT(*)::int AS cnt
       FROM public_rate_events
       WHERE endpoint = 'public_inquiries'
         AND ip_sha256 = $1
         AND created_at >= NOW() - INTERVAL '10 minutes'`,
      [ipSha256],
    );
    if ((recent.rows[0]?.cnt ?? 0) >= this.rateLimitPer10Min) {
      throw new DomainError({
        status: 429,
        code: 'RATE_LIMITED',
        title: 'Too many requests',
        detail: 'Too many submissions from this network. Please wait a few minutes and try again.',
      });
    }
    await this.db.query(
      `INSERT INTO public_rate_events (id, endpoint, ip_sha256)
       VALUES ($1, 'public_inquiries', $2)`,
      [`pre_${randomUUID()}`, ipSha256],
    );
  }

  /**
   * Resolves the owner and team for an inbound lead in `market` using the durable
   * `routing_rules` table (`FOR UPDATE` inside the caller's transaction — PRD 4.10, 4.17, Q13).
   */
  private async resolveOwnerForMarket(
    tx: DbTx,
    market: Market,
  ): Promise<{ userId: string; teamId: string | null }> {
    const ruleRes = await tx.query<{
      market: Market;
      mode: 'round_robin' | 'named_owner';
      team_id: string | null;
      owner_user_id: string | null;
      last_assigned_user_id: string | null;
    }>(
      `SELECT market, mode, team_id, owner_user_id, last_assigned_user_id
       FROM routing_rules
       WHERE market = $1
       FOR UPDATE`,
      [market],
    );
    const rule = ruleRes.rows[0];

    if (rule?.mode === 'named_owner' && rule.owner_user_id) {
      const ownerRes = await tx.query<{
        id: string;
        team_id: string | null;
        role_name: string;
        override_scope: CapabilityScopeValue | null;
      }>(
        `SELECT u.id, u.team_id, r.name AS role_name, rc.scope AS override_scope
         FROM users u
         JOIN roles r ON r.id = u.role_id
         LEFT JOIN role_capabilities rc
           ON rc.role_id = u.role_id AND rc.capability = 'leads.write'
         WHERE u.id = $1 AND u.status = 'active'
         LIMIT 1`,
        [rule.owner_user_id],
      );
      const named = ownerRes.rows[0];
      if (named && canUserWriteLeads(named.role_name, named.override_scope)) {
        return { userId: named.id, teamId: named.team_id };
      }
    }

    const fallbackTeamId = market === 'CA' ? 'team_ca' : 'team_us';
    const targetTeamId = rule?.team_id ?? fallbackTeamId;
    const teamMembersRes = await tx.query<{
      id: string;
      team_id: string | null;
      role_name: string;
      override_scope: CapabilityScopeValue | null;
    }>(
      `SELECT u.id, u.team_id, r.name AS role_name, rc.scope AS override_scope
       FROM users u
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN role_capabilities rc
         ON rc.role_id = u.role_id AND rc.capability = 'leads.write'
       WHERE u.team_id = $1 AND u.status = 'active'
       ORDER BY u.id ASC`,
      [targetTeamId],
    );
    const eligible = teamMembersRes.rows.filter((u) =>
      canUserWriteLeads(u.role_name, u.override_scope),
    );
    if (eligible.length > 0) {
      const lastIdx = rule?.last_assigned_user_id
        ? eligible.findIndex((u) => u.id === rule.last_assigned_user_id)
        : -1;
      const chosen = eligible[(lastIdx + 1) % eligible.length] ?? eligible[0];
      if (chosen) {
        if (rule) {
          await tx.query(`UPDATE routing_rules SET last_assigned_user_id = $2 WHERE market = $1`, [
            market,
            chosen.id,
          ]);
        }
        return { userId: chosen.id, teamId: chosen.team_id };
      }
    }

    // Fallback if the configured team currently has no active writers: pick any active writer.
    const anyWriterRes = await tx.query<{
      id: string;
      team_id: string | null;
      role_name: string;
      override_scope: CapabilityScopeValue | null;
    }>(
      `SELECT u.id, u.team_id, r.name AS role_name, rc.scope AS override_scope
       FROM users u
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN role_capabilities rc
         ON rc.role_id = u.role_id AND rc.capability = 'leads.write'
       WHERE u.status = 'active'
       ORDER BY (r.name = 'Sales Manager') DESC, (r.name = 'Admin') DESC, u.id ASC`,
    );
    const fallbackWriter = anyWriterRes.rows.find((u) =>
      canUserWriteLeads(u.role_name, u.override_scope),
    );
    if (!fallbackWriter) {
      throw new DomainError({
        status: 503,
        code: 'NO_ACTIVE_OWNER',
        title: 'Service unavailable',
        detail: 'No active CRM user is available to receive inquiries.',
      });
    }
    return { userId: fallbackWriter.id, teamId: fallbackWriter.team_id };
  }

  /**
   * PRD §4.10 (A13) — Public website inquiry intake handler.
   */
  async handlePublicInquiry(
    rawPayload: WebsiteInquiryPayload,
    meta: InquiryRequestMeta = {},
  ): Promise<WebsiteInquiryResult> {
    const ipSha256 = this.hashIp(meta.ipAddress);
    await this.enforcePublicRateLimit(ipSha256);

    const raw = (rawPayload ?? {}) as unknown as Record<string, unknown>;
    const shape = readWebsiteShape(raw);
    const parsed = WebsiteInquiryPayloadSchema.safeParse(
      shape.fromWebsite ? { ...raw, formType: shape.formType } : raw,
    );
    if (!parsed.success) {
      const fieldErrors: Record<string, string[]> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? 'payload');
        fieldErrors[key] = [...(fieldErrors[key] ?? []), issue.message];
      }
      throw new ValidationDomainError('Check the inquiry fields.', fieldErrors);
    }
    const payload = parsed.data;
    const formType: InquiryFormType = payload.form ?? payload.formType;

    // On the website's contact form, `website` is the honeypot, not the firm's site.
    const websiteHoneypot = shape.fromWebsite ? (payload.website ?? '').trim() : '';
    if (shape.fromWebsite) {
      payload.website = null;
    }

    // 1. Honeypot check: silently accept and drop spam bots (PRD §4.10)
    if (
      websiteHoneypot !== '' ||
      (payload.company_website_hp && payload.company_website_hp.trim() !== '') ||
      (payload._gotcha && payload._gotcha.trim() !== '')
    ) {
      return {
        status: 'received',
        accepted: true,
        deduplicated: false,
        honeypotDropped: true,
        inquiryId: null,
        leadId: null,
        companyId: null,
        contactId: null,
        slaTaskId: null,
        assignedUserId: null,
      };
    }

    const cleanEmail = normalizeEmail(payload.email);
    if (!cleanEmail) {
      throw new ValidationDomainError('Enter a valid email address.', {
        email: ['Enter a valid email address.'],
      });
    }
    const emailSha256 = sha256Hex(cleanEmail);
    const market: Market = marketFrom(payload.country, payload.location);
    const prospectZone = market === 'CA' ? 'America/Toronto' : 'America/New_York';
    const location = payload.location?.trim() || null;
    const isSpecificRegion =
      location !== null && !/^(multiple|both|outside)/i.test(location) && location !== '';
    const stateProvince = payload.stateProvince?.trim() || (isSpecificRegion ? location : null);
    const emailDomain = extractDomainFromEmail(cleanEmail);
    const webDomain = payload.website ? normalizeDomain(payload.website) : emailDomain;
    const isFreeMail = webDomain ? isFreeMailDomain(webDomain) : true;
    const corporateDomain = webDomain && !isFreeMail ? webDomain : null;

    const fullNameRaw =
      payload.name?.trim() ||
      `${payload.firstName?.trim() ?? ''} ${payload.lastName?.trim() ?? ''}`.trim() ||
      cleanEmail.split('@')[0] ||
      'Website Visitor';
    const nameParts = fullNameRaw.split(/\s+/);
    const firstName = payload.firstName?.trim() || nameParts[0] || 'Visitor';
    const lastName =
      payload.lastName?.trim() || (nameParts.length > 1 ? nameParts.slice(1).join(' ') : 'Partner');
    const fullName = `${firstName} ${lastName}`.trim();

    const firmName = payload.firm?.trim() || payload.company?.trim() || null;
    const phoneE164 = payload.phone
      ? normalizePhone(payload.phone, market === 'CA' ? 'CA' : 'US')
      : null;

    const needList = payload.need && !/^not sure/i.test(payload.need) ? [payload.need.trim()] : [];
    const servicesList = [
      ...new Set([...toList(payload.services), ...needList, ...toList(payload.interests)]),
    ];
    const softwareList = toList(payload.software);

    const utcDay = new Date().toISOString().slice(0, 10);
    const dedupKey = sha256Hex(`${cleanEmail}:${formType}:${utcDay}`);
    const userAgent = meta.userAgent ? meta.userAgent.trim().slice(0, 500) : null;
    const pageUrl = payload.pageUrl ? payload.pageUrl.trim().slice(0, 500) : null;
    const storedRaw = sanitizeRawPayload(raw);

    return this.db.transaction(async (tx) => {
      // 2. Suppression & privacy erasure check (PRD §4.18, §5.6: suppression always wins)
      const supRes = await tx.query<{ reason: string }>(
        `SELECT reason
         FROM suppressions
         WHERE (email = $1 OR email_sha256 = $2) AND lifted_at IS NULL
         LIMIT 1`,
        [cleanEmail, emailSha256],
      );
      if (supRes.rows[0]?.reason === 'privacy_erasure') {
        return {
          status: 'received',
          accepted: true,
          deduplicated: false,
          honeypotDropped: false,
          inquiryId: null,
          leadId: null,
          companyId: null,
          contactId: null,
          slaTaskId: null,
          assignedUserId: null,
        };
      }
      const isSuppressed = supRes.rows.length > 0;

      // 3. Idempotency check on (email, form, day) OR an open/qualified lead in the last 24h (PRD §4.10)
      const [sameDayInqRes, recentLeadRes] = await Promise.all([
        tx.query<{
          lead_id: string | null;
          company_id: string | null;
          contact_id: string | null;
          assigned_user_id: string | null;
        }>(
          `SELECT lead_id, company_id, contact_id, assigned_user_id
           FROM inquiries
           WHERE dedup_key = $1
           ORDER BY created_at DESC
           LIMIT 1`,
          [dedupKey],
        ),
        tx.query<{
          id: string;
          company_id: string | null;
          contact_id: string | null;
          owner_user_id: string;
        }>(
          `SELECT id, company_id, contact_id, owner_user_id
           FROM leads
           WHERE email = $1
             AND status_category IN ('open', 'qualified')
             AND deleted_at IS NULL
             AND created_at >= NOW() - INTERVAL '24 hours'
           ORDER BY created_at DESC
           LIMIT 1`,
          [cleanEmail],
        ),
      ]);

      const recentLead = recentLeadRes.rows[0];
      const sameDayInq = sameDayInqRes.rows[0];
      if (recentLead || sameDayInq) {
        const targetLeadId = recentLead?.id ?? sameDayInq?.lead_id ?? null;
        const targetCompanyId = recentLead?.company_id ?? sameDayInq?.company_id ?? null;
        const targetContactId = recentLead?.contact_id ?? sameDayInq?.contact_id ?? null;
        const targetOwnerId = recentLead?.owner_user_id ?? sameDayInq?.assigned_user_id ?? null;

        const inquiryId = `inq_${randomUUID()}`;
        await tx.query(
          `INSERT INTO inquiries (
             id, dedup_key, form_type, market, email_sha256, raw_payload,
             ip_sha256, user_agent, page_url, deduplicated,
             lead_id, contact_id, company_id, assigned_user_id
           ) VALUES (
             $1, $2, $3, $4, $5, $6::jsonb,
             $7, $8, $9, TRUE,
             $10, $11, $12, $13
           )`,
          [
            inquiryId,
            dedupKey,
            formType,
            market,
            emailSha256,
            JSON.stringify(storedRaw),
            ipSha256,
            userAgent,
            pageUrl,
            targetLeadId,
            targetContactId,
            targetCompanyId,
            targetOwnerId,
          ],
        );

        if (targetLeadId) {
          await tx.query(
            `UPDATE leads
             SET updated_at = NOW(),
                 version = version + 1
             WHERE id = $1 AND deleted_at IS NULL`,
            [targetLeadId],
          );

          await tx.query(
            `INSERT INTO activities (id, entity_type, entity_id, company_id, contact_id, lead_id, activity_type, title, detail)
             VALUES ($1, 'lead', $2, $3, $4, $2, 'website_inquiry_repeat', 'Repeat website form submission merged', $5)`,
            [
              `act_${randomUUID()}`,
              targetLeadId,
              targetCompanyId,
              targetContactId,
              payload.message ?? `Repeat ${formType} form submission within 24h.`,
            ],
          );
        }

        return {
          status: 'received',
          accepted: true,
          deduplicated: true,
          honeypotDropped: false,
          inquiryId,
          leadId: targetLeadId,
          companyId: targetCompanyId,
          contactId: targetContactId,
          slaTaskId: null,
          assignedUserId: targetOwnerId,
        };
      }

      // 4. Assign owner by durable market routing rule (PRD §4.10, §4.17, §15 Q13)
      const { userId: assignedUserId, teamId } = await this.resolveOwnerForMarket(tx, market);
      const sourceLabel = `Website: ${formType} form`;

      // 5. Match or create Company: by corporate domain, or by firm name (with domain = NULL) when
      // free-mail and a firm name was provided (PRD §4.3, §4.10 step 2, A4).
      let companyId: string | null = null;
      if (corporateDomain) {
        const existingCmp = await tx.query<{ id: string }>(
          `SELECT id FROM companies WHERE domain = $1 AND deleted_at IS NULL LIMIT 1`,
          [corporateDomain],
        );
        if (existingCmp.rows[0]) {
          companyId = existingCmp.rows[0].id;
        } else {
          companyId = `cmp_${randomUUID()}`;
          await tx.query(
            `INSERT INTO companies (
               id, name, domain, website, firm_type, market, state_province, timezone, staff_band,
               account_status, owner_user_id, team_id, accounting_software, services_needed, source
             ) VALUES (
               $1, $2, $3, $4, 'CPA firm', $5, $6, $7, $8,
               'prospect', $9, $10, $11::jsonb, $12::jsonb, $13
             )`,
            [
              companyId,
              firmName ?? corporateDomain,
              corporateDomain,
              `https://${corporateDomain}`,
              market,
              stateProvince,
              prospectZone,
              payload.staffSize ?? '11–20',
              assignedUserId,
              teamId,
              JSON.stringify(softwareList),
              JSON.stringify(servicesList),
              sourceLabel,
            ],
          );
        }
      } else if (firmName) {
        const existingByName = await tx.query<{ id: string }>(
          `SELECT id FROM companies
           WHERE domain IS NULL AND market = $1 AND LOWER(name) = LOWER($2) AND deleted_at IS NULL
           ORDER BY created_at ASC
           LIMIT 1`,
          [market, firmName],
        );
        if (existingByName.rows[0]) {
          companyId = existingByName.rows[0].id;
        } else {
          companyId = `cmp_${randomUUID()}`;
          await tx.query(
            `INSERT INTO companies (
               id, name, domain, website, firm_type, market, state_province, timezone, staff_band,
               account_status, owner_user_id, team_id, accounting_software, services_needed, source
             ) VALUES (
               $1, $2, NULL, NULL, 'CPA firm', $3, $4, $5, $6,
               'prospect', $7, $8, $9::jsonb, $10::jsonb, $11
             )`,
            [
              companyId,
              firmName,
              market,
              stateProvince,
              prospectZone,
              payload.staffSize ?? '11–20',
              assignedUserId,
              teamId,
              JSON.stringify(softwareList),
              JSON.stringify(servicesList),
              sourceLabel,
            ],
          );
        }
      }

      // 6. Match or create Contact (checking both primary and secondary addresses)
      let contactId: string | null = null;
      const existingCnt = await tx.query<{ id: string; company_id: string | null }>(
        `SELECT c.id, c.company_id
         FROM contacts c
         LEFT JOIN contact_emails ce ON ce.contact_id = c.id
         WHERE (c.primary_email = $1 OR ce.email = $1) AND c.deleted_at IS NULL
         ORDER BY (c.primary_email = $1) DESC
         LIMIT 1`,
        [cleanEmail],
      );
      if (existingCnt.rows[0]) {
        contactId = existingCnt.rows[0].id;
        if (!existingCnt.rows[0].company_id && companyId) {
          await tx.query(
            `UPDATE contacts SET company_id = $2, version = version + 1, updated_at = NOW()
             WHERE id = $1 AND company_id IS NULL`,
            [contactId, companyId],
          );
        }
      } else {
        contactId = `cnt_${randomUUID()}`;
        await tx.query(
          `INSERT INTO contacts (
             id, company_id, first_name, last_name, full_name, title,
             primary_email, phone_e164, market, timezone, owner_user_id, team_id,
             do_not_contact, email_verification_status, source
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'unknown', $14)`,
          [
            contactId,
            companyId,
            firstName,
            lastName,
            fullName,
            payload.role ?? 'Partner',
            cleanEmail,
            phoneE164,
            market,
            prospectZone,
            assignedUserId,
            teamId,
            isSuppressed,
            sourceLabel,
          ],
        );
        await tx.query(
          `INSERT INTO contact_emails (id, contact_id, email, is_primary, verification_status)
           VALUES ($1, $2, $3, TRUE, 'unknown')
           ON CONFLICT (email) DO NOTHING`,
          [`ce_${randomUUID()}`, contactId, cleanEmail],
        );
        if (phoneE164) {
          await tx.query(
            `INSERT INTO contact_phones (id, contact_id, phone_e164, phone_label, is_primary)
             VALUES ($1, $2, $3, 'work', TRUE)`,
            [`cp_${randomUUID()}`, contactId, phoneE164],
          );
        }
      }

      // 7. Create Lead + initial status history
      const leadId = `lead_${randomUUID()}`;
      await tx.query(
        `INSERT INTO leads (
           id, first_name, last_name, full_name, email, phone_e164, firm_name, domain, website,
           title, market, state_province, staff_band, source, status, status_category,
           services_needed, software_stack, owner_user_id, team_id, company_id, contact_id,
           utm_source, utm_medium, utm_campaign
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9,
           $10, $11, $12, $13, $14, 'New', 'open',
           $15::jsonb, $16::jsonb, $17, $18, $19, $20,
           $21, $22, $23
         )`,
        [
          leadId,
          firstName,
          lastName,
          fullName,
          cleanEmail,
          phoneE164,
          firmName,
          corporateDomain,
          corporateDomain ? `https://${corporateDomain}` : null,
          payload.role ?? 'Partner',
          market,
          stateProvince,
          payload.staffSize ?? '11–20',
          sourceLabel,
          JSON.stringify(servicesList),
          JSON.stringify(softwareList),
          assignedUserId,
          teamId,
          companyId,
          contactId,
          payload.utmSource ?? null,
          payload.utmMedium ?? null,
          payload.utmCampaign ?? null,
        ],
      );
      await tx.query(
        `INSERT INTO lead_status_history (id, lead_id, from_status, to_status, reason)
         VALUES ($1, $2, NULL, 'New', $3)`,
        [`lsh_${randomUUID()}`, leadId, sourceLabel],
      );

      // 8. Store raw submission in `inquiries` (PRD §4.10 step 1)
      const inquiryId = `inq_${randomUUID()}`;
      await tx.query(
        `INSERT INTO inquiries (
           id, dedup_key, form_type, market, email_sha256, raw_payload,
           ip_sha256, user_agent, page_url, deduplicated,
           lead_id, contact_id, company_id, assigned_user_id
         ) VALUES (
           $1, $2, $3, $4, $5, $6::jsonb,
           $7, $8, $9, FALSE,
           $10, $11, $12, $13
         )`,
        [
          inquiryId,
          dedupKey,
          formType,
          market,
          emailSha256,
          JSON.stringify(storedRaw),
          ipSha256,
          userAgent,
          pageUrl,
          leadId,
          contactId,
          companyId,
          assignedUserId,
        ],
      );

      // 9. Keep what the visitor wrote on the lead's timeline
      const inquiryDetail = [
        payload.need ? `Need: ${payload.need}` : null,
        toList(payload.interests).length
          ? `Interested in: ${toList(payload.interests).join(', ')}`
          : null,
        softwareList.length ? `Software: ${softwareList.join(', ')}` : null,
        location ? `Location: ${location}` : null,
        payload.message ? `Message: ${payload.message}` : null,
      ]
        .filter(Boolean)
        .join('\n');
      await tx.query(
        `INSERT INTO activities (id, entity_type, entity_id, company_id, contact_id, lead_id, activity_type, title, detail)
         VALUES ($1, 'lead', $2, $3, $4, $2, 'website_inquiry', $5, $6)`,
        [
          `act_${randomUUID()}`,
          leadId,
          companyId,
          contactId,
          `Website ${formType} form submitted`,
          inquiryDetail || 'No details given on the form.',
        ],
      );

      // 10. Record consent evidence linked to `inquiries.id` (PRD §4.10 step 6 & §5.3).
      // Suppressed addresses stay suppressed (PRD §5.6).
      let consentId: string | null = null;
      if (!isSuppressed) {
        consentId = `cns_${randomUUID()}`;
        await tx.query(
          `INSERT INTO consent_records (
             id, email, contact_id, inquiry_id, market, basis, purpose, status, source, proof_text, captured_at, expires_at
           ) VALUES (
             $1, $2, $3, $4, $5, 'implied_inquiry', 'marketing', 'active', $6, $7, NOW(),
             CASE WHEN $5 = 'CA' THEN NOW() + INTERVAL '6 months' ELSE NULL END
           )`,
          [
            consentId,
            cleanEmail,
            contactId,
            inquiryId,
            market,
            sourceLabel,
            `Submitted ${formType} form on ${pageUrl ?? 'adasglobuspro.com'}`,
          ],
        );
      }

      // 11. "Reply to website inquiry" task, due one business day later in the prospect's
      // market calendar (PRD §4.10 step 5).
      const slaDueAt = addBusinessDays(new Date(), 1, prospectZone, market === 'CA' ? 'CA' : 'US');
      const slaTaskId = `tsk_sla_${randomUUID()}`;
      await tx.query(
        `INSERT INTO tasks (
           id, title, task_type, priority, status,
           due_at, sla_deadline_at, sla_breached,
           assignee_user_id, team_id, lead_id, company_id, contact_id
         ) VALUES (
           $1, $2, 'sla_first_response', 'urgent', 'open',
           $8, $8, FALSE,
           $3, $4, $5, $6, $7
         )`,
        [
          slaTaskId,
          `Reply to website inquiry: ${fullName}${firmName ? ` (${firmName})` : ''}`,
          assignedUserId,
          teamId,
          leadId,
          companyId,
          contactId,
          slaDueAt.toISOString(),
        ],
      );

      await tx.query(
        `UPDATE inquiries SET consent_record_id = $2, sla_task_id = $3 WHERE id = $1`,
        [inquiryId, consentId, slaTaskId],
      );

      // 12. Notify the assigned owner in-app (PRD §4.10 step 7)
      await addNotification(tx, {
        userId: assignedUserId,
        kind: 'assignment',
        title: `New website inquiry (${market})`,
        body: `${firmName ?? 'Individual CPA inquiry'} · ${formType} form. Reply within one business day.`,
        entityType: 'lead',
        entityId: leadId,
        dedupeKey: `inquiry:${leadId}`,
      });

      // 13. Outbox event
      await this.db.addOutboxEvent(tx, {
        eventType: 'lead.created',
        aggregateType: 'lead',
        aggregateId: leadId,
        payload: {
          inquiryId,
          leadId,
          companyId,
          contactId,
          slaTaskId,
          market,
          formType,
        },
      });

      return {
        status: 'received',
        accepted: true,
        deduplicated: false,
        honeypotDropped: false,
        inquiryId,
        leadId,
        companyId,
        contactId,
        slaTaskId,
        assignedUserId,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Admin Market Routing Rules & Recent Inquiries (PRD 4.17, 15 Q13)
  // -------------------------------------------------------------------------

  async listRoutingRules(actor: SessionUser): Promise<{ items: RoutingRuleView[] }> {
    requireCapability(actor, 'settings.manage');
    const [rulesRes, membersRes] = await Promise.all([
      this.db.query<{
        market: Market;
        mode: 'round_robin' | 'named_owner';
        team_id: string | null;
        team_name: string | null;
        owner_user_id: string | null;
        owner_name: string | null;
        last_assigned_user_id: string | null;
        last_assigned_name: string | null;
        version: number;
        updated_by_name: string | null;
        updated_at: string;
      }>(
        `SELECT rr.market, rr.mode, rr.team_id, t.name AS team_name,
                rr.owner_user_id, u_own.name AS owner_name,
                rr.last_assigned_user_id, u_last.name AS last_assigned_name,
                rr.version, u_upd.name AS updated_by_name, rr.updated_at
         FROM routing_rules rr
         LEFT JOIN teams t ON t.id = rr.team_id
         LEFT JOIN users u_own ON u_own.id = rr.owner_user_id
         LEFT JOIN users u_last ON u_last.id = rr.last_assigned_user_id
         LEFT JOIN users u_upd ON u_upd.id = rr.updated_by_user_id`,
      ),
      this.db.query<{
        team_id: string | null;
        role_name: string;
        override_scope: CapabilityScopeValue | null;
      }>(
        `SELECT u.team_id, r.name AS role_name, rc.scope AS override_scope
         FROM users u
         JOIN roles r ON r.id = u.role_id
         LEFT JOIN role_capabilities rc
           ON rc.role_id = u.role_id AND rc.capability = 'leads.write'
         WHERE u.status = 'active' AND u.team_id IS NOT NULL`,
      ),
    ]);

    const eligibleByTeam = new Map<string, number>();
    for (const m of membersRes.rows) {
      if (m.team_id && canUserWriteLeads(m.role_name, m.override_scope)) {
        eligibleByTeam.set(m.team_id, (eligibleByTeam.get(m.team_id) ?? 0) + 1);
      }
    }

    const byMarket = new Map(rulesRes.rows.map((r) => [r.market, r]));
    const ordered: Market[] = ['US', 'CA', 'OTHER'];
    return {
      items: ordered.map((m) => {
        const row = byMarket.get(m);
        const teamId = row?.team_id ?? null;
        return {
          market: m,
          mode: row?.mode ?? 'round_robin',
          teamId,
          teamName: row?.team_name ?? null,
          eligibleMemberCount: teamId ? (eligibleByTeam.get(teamId) ?? 0) : 0,
          ownerUserId: row?.owner_user_id ?? null,
          ownerName: row?.owner_name ?? null,
          lastAssignedUserId: row?.last_assigned_user_id ?? null,
          lastAssignedName: row?.last_assigned_name ?? null,
          version: row?.version ?? 1,
          updatedByName: row?.updated_by_name ?? null,
          updatedAt: isoString(row?.updated_at),
        };
      }),
    };
  }

  async updateRoutingRule(
    actor: SessionUser,
    rawMarket: string,
    rawInput: unknown,
    ip: string | null,
  ): Promise<RoutingRuleView> {
    requireCapability(actor, 'settings.manage');
    const marketParsed = MarketSchema.safeParse(rawMarket.toUpperCase());
    if (!marketParsed.success) {
      throw new NotFoundDomainError('Routing rule', rawMarket);
    }
    const market = marketParsed.data;
    const input = UpdateRoutingRuleInputSchema.parse(rawInput);

    await this.db.transaction(async (tx) => {
      const currentRes = await tx.query<{
        market: Market;
        mode: string;
        team_id: string | null;
        owner_user_id: string | null;
        version: number;
      }>(
        `SELECT market, mode, team_id, owner_user_id, version FROM routing_rules WHERE market = $1 FOR UPDATE`,
        [market],
      );
      const current = currentRes.rows[0];
      if (!current) {
        throw new NotFoundDomainError('Routing rule', market);
      }
      if (current.version !== input.version) {
        throw new VersionConflictError('Routing rule', market);
      }

      const nextTeamId = input.mode === 'round_robin' ? (input.teamId ?? null) : null;
      const nextOwnerId = input.mode === 'named_owner' ? (input.ownerUserId ?? null) : null;

      if (input.mode === 'round_robin') {
        const teamRes = await tx.query<{ id: string }>(`SELECT id FROM teams WHERE id = $1`, [
          nextTeamId,
        ]);
        if (teamRes.rows.length === 0) {
          throw new ValidationDomainError('Choose an existing team.', {
            teamId: ['Choose an existing team.'],
          });
        }
        const membersRes = await tx.query<{
          id: string;
          role_name: string;
          override_scope: CapabilityScopeValue | null;
        }>(
          `SELECT u.id, r.name AS role_name, rc.scope AS override_scope
           FROM users u
           JOIN roles r ON r.id = u.role_id
           LEFT JOIN role_capabilities rc
             ON rc.role_id = u.role_id AND rc.capability = 'leads.write'
           WHERE u.team_id = $1 AND u.status = 'active'`,
          [nextTeamId],
        );
        const eligibleCount = membersRes.rows.filter((m) =>
          canUserWriteLeads(m.role_name, m.override_scope),
        ).length;
        if (eligibleCount === 0) {
          throw new ValidationDomainError(
            'That team has no active members who can edit leads. Add an active member first, or choose a named owner.',
            {
              teamId: [
                'That team has no active members who can edit leads. Add an active member first.',
              ],
            },
          );
        }
      } else {
        const ownerRes = await tx.query<{
          id: string;
          status: string;
          role_name: string;
          override_scope: CapabilityScopeValue | null;
        }>(
          `SELECT u.id, u.status, r.name AS role_name, rc.scope AS override_scope
           FROM users u
           JOIN roles r ON r.id = u.role_id
           LEFT JOIN role_capabilities rc
             ON rc.role_id = u.role_id AND rc.capability = 'leads.write'
           WHERE u.id = $1`,
          [nextOwnerId],
        );
        const owner = ownerRes.rows[0];
        if (!owner || owner.status !== 'active') {
          throw new ValidationDomainError('Choose an active person.', {
            ownerUserId: ['Choose an active person.'],
          });
        }
        if (!canUserWriteLeads(owner.role_name, owner.override_scope)) {
          throw new ValidationDomainError('That person’s role cannot edit leads.', {
            ownerUserId: ['Choose someone whose role can edit leads.'],
          });
        }
      }

      await tx.query(
        `UPDATE routing_rules
         SET mode = $2,
             team_id = $3,
             owner_user_id = $4,
             last_assigned_user_id = CASE WHEN $3 IS DISTINCT FROM team_id THEN NULL ELSE last_assigned_user_id END,
             version = version + 1,
             updated_by_user_id = $5,
             updated_at = NOW()
         WHERE market = $1`,
        [market, input.mode, nextTeamId, nextOwnerId, actor.id],
      );

      await this.db.writeAuditLog(tx, {
        actorUserId: actor.id,
        actorEmail: actor.email,
        action: 'routing_rule.updated',
        entityType: 'routing_rule',
        entityId: market,
        metadata: {
          market,
          before: {
            mode: current.mode,
            teamId: current.team_id,
            ownerUserId: current.owner_user_id,
          },
          after: {
            mode: input.mode,
            teamId: nextTeamId,
            ownerUserId: nextOwnerId,
          },
        },
        ipAddress: ip,
      });
    });

    const all = await this.listRoutingRules(actor);
    const updated = all.items.find((r) => r.market === market);
    if (!updated) throw new NotFoundDomainError('Routing rule', market);
    return updated;
  }

  async listRecentInquiries(
    actor: SessionUser,
    rawQuery: Record<string, unknown> = {},
  ): Promise<{ items: InquirySummaryView[]; nextCursor: string | null; total: number }> {
    requireCapability(actor, 'settings.manage');
    const query = InquiryListQuerySchema.parse(rawQuery);
    const [cursorAt, cursorId] = parseCursor(query.cursor);
    const conditions: string[] = ['1 = 1'];
    const params: unknown[] = [];
    const addParam = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };

    if (query.market) {
      conditions.push(`i.market = ${addParam(query.market)}`);
    }
    if (query.formType) {
      conditions.push(`i.form_type = ${addParam(query.formType)}`);
    }

    const filterWhere = conditions.join(' AND ');
    const filterParams = [...params];

    if (cursorAt) {
      const pAt = addParam(cursorAt);
      const pId = addParam(cursorId);
      conditions.push(`(i.created_at, i.id) < (${pAt}::timestamptz, ${pId}::text)`);
    }

    const [res, countRes] = await Promise.all([
      this.db.query<Record<string, unknown> & { id: string; cursor_at: string }>(
        `SELECT i.id, i.form_type, i.market, i.deduplicated, i.page_url,
                i.lead_id, l.full_name AS lead_name, l.firm_name, l.deleted_at AS lead_deleted_at,
                i.contact_id, i.company_id,
                i.sla_task_id, t.status AS sla_task_status,
                i.assigned_user_id, u.name AS assigned_user_name,
                i.created_at, i.created_at::text AS cursor_at
         FROM inquiries i
         LEFT JOIN leads l ON l.id = i.lead_id
         LEFT JOIN tasks t ON t.id = i.sla_task_id
         LEFT JOIN users u ON u.id = i.assigned_user_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY i.created_at DESC, i.id DESC
         LIMIT ${query.limit + 1}`,
        params,
      ),
      this.db.query<{ total: number }>(
        `SELECT COUNT(*)::int AS total FROM inquiries i WHERE ${filterWhere}`,
        filterParams,
      ),
    ]);

    const hasMore = res.rows.length > query.limit;
    const rows = hasMore ? res.rows.slice(0, query.limit) : res.rows;
    const last = rows[rows.length - 1];

    return {
      items: rows.map((row) => {
        const leadAlive = row['lead_id'] && !row['lead_deleted_at'];
        return {
          id: String(row['id']),
          formType: String(row['form_type']) as InquiryFormType,
          market: String(row['market']) as Market,
          deduplicated: Boolean(row['deduplicated']),
          pageUrl: (row['page_url'] as string | null) ?? null,
          leadId: leadAlive ? String(row['lead_id']) : null,
          leadName: leadAlive ? ((row['lead_name'] as string | null) ?? null) : null,
          firmName: leadAlive ? ((row['firm_name'] as string | null) ?? null) : null,
          contactId: (row['contact_id'] as string | null) ?? null,
          companyId: (row['company_id'] as string | null) ?? null,
          slaTaskId: (row['sla_task_id'] as string | null) ?? null,
          slaTaskStatus: (row['sla_task_status'] as string | null) ?? null,
          assignedUserId: (row['assigned_user_id'] as string | null) ?? null,
          assignedUserName: (row['assigned_user_name'] as string | null) ?? null,
          createdAt: isoString(row['created_at']),
        };
      }),
      nextCursor: hasMore && last ? `${last.cursor_at}|${last.id}` : null,
      total: Number(countRes.rows[0]?.total ?? 0),
    };
  }
}

export { registerIntakeRoutes } from './routes.js';
