import { randomUUID } from 'node:crypto';
import { WebsiteInquiryPayloadSchema, type Market, type WebsiteInquiryPayload } from '@adas/shared';
import { addBusinessDays } from '../../platform/calendar/index.js';
import { type DatabaseService } from '../../platform/db/index.js';
import {
  extractDomainFromEmail,
  isFreeMailDomain,
  normalizeDomain,
  normalizeEmail,
  normalizePhone,
} from '../../platform/normalize/index.js';

export interface WebsiteInquiryResult {
  accepted: boolean;
  deduplicated: boolean;
  honeypotDropped: boolean;
  leadId: string | null;
  companyId: string | null;
  contactId: string | null;
  slaTaskId: string | null;
  assignedUserId: string | null;
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
 * The live website forms never send `formType`. When it is missing, the payload came from
 * adasglobuspro.com, so infer the form and treat the contact form's `website` field as the
 * hidden honeypot it is there (PRD §4.10).
 */
function readWebsiteShape(raw: Record<string, unknown>): {
  fromWebsite: boolean;
  formType: 'trial' | 'contact';
} {
  const fromWebsite = raw['formType'] === undefined;
  const looksLikeContact = 'location' in raw || 'interests' in raw;
  return { fromWebsite, formType: looksLikeContact && !('need' in raw) ? 'contact' : 'trial' };
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

export class WebsiteIntakeService {
  private roundRobinIndex = 0;

  constructor(private readonly db: DatabaseService) {}

  /**
   * PRD §4.10 (A1 & A2) — Public website inquiry intake endpoint handler.
   */
  async handlePublicInquiry(rawPayload: WebsiteInquiryPayload): Promise<WebsiteInquiryResult> {
    const raw = (rawPayload ?? {}) as unknown as Record<string, unknown>;
    const shape = readWebsiteShape(raw);
    const payload = WebsiteInquiryPayloadSchema.parse(
      shape.fromWebsite ? { ...raw, formType: shape.formType } : raw,
    );
    // On the website's contact form, `website` is the honeypot, not the firm's site.
    const websiteHoneypot = shape.fromWebsite ? (payload.website ?? '').trim() : '';
    if (shape.fromWebsite) {
      payload.website = null;
    }

    // 1. Honeypot check: silently accept and drop spam bots
    if (
      websiteHoneypot !== '' ||
      (payload.company_website_hp && payload.company_website_hp.trim() !== '') ||
      (payload._gotcha && payload._gotcha.trim() !== '')
    ) {
      return {
        accepted: true,
        deduplicated: false,
        honeypotDropped: true,
        leadId: null,
        companyId: null,
        contactId: null,
        slaTaskId: null,
        assignedUserId: null,
      };
    }

    const cleanEmail = normalizeEmail(payload.email);
    if (!cleanEmail) {
      throw new Error('Invalid email in inquiry payload');
    }

    const market: Market = marketFrom(payload.country, payload.location);
    const location = payload.location?.trim() || null;
    const isSpecificRegion =
      location !== null && !/^(multiple|both|outside)/i.test(location) && location !== '';
    const stateProvince = payload.stateProvince ?? (isSpecificRegion ? location : null);
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

    const firmName = payload.firm?.trim() || payload.company?.trim() || null;
    const phoneE164 = payload.phone
      ? normalizePhone(payload.phone, market === 'CA' ? 'CA' : 'US')
      : null;

    // Services come from `services` (API callers), the trial form's `need`, or the contact
    // form's `interests`. Nothing is invented when the visitor didn't say.
    const needList = payload.need && !/^not sure/i.test(payload.need) ? [payload.need.trim()] : [];
    const servicesList = [
      ...new Set([...toList(payload.services), ...needList, ...toList(payload.interests)]),
    ];
    const softwareList = toList(payload.software);

    return this.db.transaction(async (tx) => {
      // 2. Check repeat submission within 24 hours for an open lead (PRD §4.10 A1)
      const recentLeadRes = await tx.query<{
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
      );

      const recentLead = recentLeadRes.rows[0];
      if (recentLead) {
        await tx.query(
          `UPDATE leads
           SET updated_at = NOW(),
               version = version + 1
           WHERE id = $1`,
          [recentLead.id],
        );

        await tx.query(
          `INSERT INTO activities (id, entity_type, entity_id, company_id, contact_id, lead_id, activity_type, title, detail)
           VALUES ($1, 'lead', $2, $3, $4, $2, 'website_inquiry_repeat', 'Repeat website form submission merged', $5)`,
          [
            `act_${randomUUID()}`,
            recentLead.id,
            recentLead.company_id,
            recentLead.contact_id,
            payload.message ?? `Repeat ${payload.formType} form submission within 24h.`,
          ],
        );

        return {
          accepted: true,
          deduplicated: true,
          honeypotDropped: false,
          leadId: recentLead.id,
          companyId: recentLead.company_id,
          contactId: recentLead.contact_id,
          slaTaskId: null,
          assignedUserId: recentLead.owner_user_id,
        };
      }

      // 3. Round-robin assign within market team (PRD §15 Q13)
      const teamId = market === 'CA' ? 'team_ca' : 'team_us';
      const repsRes = await tx.query<{ id: string }>(
        `SELECT id FROM users WHERE team_id = $1 AND status = 'active' ORDER BY id ASC`,
        [teamId],
      );
      const reps = repsRes.rows;
      const assignedUserId =
        reps.length > 0
          ? (reps[this.roundRobinIndex++ % reps.length]?.id ?? 'usr_mgr_1')
          : 'usr_mgr_1';

      // 4. Create or link Company ONLY if corporate domain is present (PRD §4.3 & §4.10 A2)
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
               id, name, domain, website, firm_type, market, state_province, staff_band,
               account_status, owner_user_id, team_id, accounting_software, services_needed
             ) VALUES (
               $1, $2, $3, $4, 'CPA firm', $5, $6, $7,
               'prospect', $8, $9, $10::jsonb, $11::jsonb
             )`,
            [
              companyId,
              firmName ?? corporateDomain,
              corporateDomain,
              `https://${corporateDomain}`,
              market,
              stateProvince,
              payload.staffSize ?? '11–20',
              assignedUserId,
              teamId,
              JSON.stringify(softwareList),
              JSON.stringify(servicesList),
            ],
          );
        }
      }

      // 5. Create or link Contact
      let contactId: string | null = null;
      const existingCnt = await tx.query<{ id: string }>(
        `SELECT id FROM contacts WHERE primary_email = $1 AND deleted_at IS NULL LIMIT 1`,
        [cleanEmail],
      );
      if (existingCnt.rows[0]) {
        contactId = existingCnt.rows[0].id;
      } else {
        contactId = `cnt_${randomUUID()}`;
        await tx.query(
          `INSERT INTO contacts (
             id, company_id, first_name, last_name, full_name, title,
             primary_email, phone_e164, market, owner_user_id, team_id, email_verification_status
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'unknown')`,
          [
            contactId,
            companyId,
            firstName,
            lastName,
            `${firstName} ${lastName}`.trim(),
            payload.role ?? 'Partner',
            cleanEmail,
            phoneE164,
            market,
            assignedUserId,
            teamId,
          ],
        );
        await tx.query(
          `INSERT INTO contact_emails (id, contact_id, email, is_primary, verification_status)
           VALUES ($1, $2, $3, TRUE, 'unknown')
           ON CONFLICT (email) DO NOTHING`,
          [`ce_${randomUUID()}`, contactId, cleanEmail],
        );
      }

      // 6. Create Lead
      const leadId = `lead_${randomUUID()}`;
      const sourceLabel = `Website: ${payload.formType} form`;
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
          `${firstName} ${lastName}`.trim(),
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

      // 6b. Keep what the visitor wrote on the lead's timeline, so the owner can reply to it.
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
          `Website ${payload.formType} form submitted`,
          inquiryDetail || 'No details given on the form.',
        ],
      );

      // 7. Record consent evidence. An inquiry is implied consent, not express consent
      // (PRD §5.3). CASL limits it to 6 months; the U.S. has no expiry.
      const consentBasis = 'implied_inquiry';
      await tx.query(
        `INSERT INTO consent_records (
           id, email, contact_id, market, basis, status, source, proof_text, captured_at, expires_at
         ) VALUES (
           $1, $2, $3, $4, $5, 'active', $6, $7, NOW(),
           CASE WHEN $4 = 'CA' THEN NOW() + INTERVAL '6 months' ELSE NULL END
         )`,
        [
          `cns_${randomUUID()}`,
          cleanEmail,
          contactId,
          market,
          consentBasis,
          sourceLabel,
          `Submitted ${payload.formType} form on ${payload.pageUrl ?? 'adasglobuspro.com'}`,
        ],
      );

      // 8. "Reply to website inquiry" task, due one business day later in the prospect's
      // market calendar: the website promises a reply within one business day (PRD §4.10).
      const prospectZone = market === 'CA' ? 'America/Toronto' : 'America/New_York';
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
          `Reply to website inquiry: ${firstName} ${lastName} (${firmName ?? cleanEmail})`,
          assignedUserId,
          teamId,
          leadId,
          companyId,
          contactId,
          slaDueAt.toISOString(),
        ],
      );

      // 9. Outbox event
      await this.db.addOutboxEvent(tx, {
        eventType: 'lead.created',
        aggregateType: 'lead',
        aggregateId: leadId,
        payload: {
          leadId,
          companyId,
          contactId,
          slaTaskId,
          market,
          formType: payload.formType,
        },
      });

      return {
        accepted: true,
        deduplicated: false,
        honeypotDropped: false,
        leadId,
        companyId,
        contactId,
        slaTaskId,
        assignedUserId,
      };
    });
  }
}
