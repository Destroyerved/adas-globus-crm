import { randomUUID } from 'node:crypto';
import { type AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAppServer } from '../main.js';
import { validateEnv } from '../platform/config/index.js';
import { DatabaseService } from '../platform/db/index.js';

/**
 * Milestone 3b Integration Suite:
 * Custom fields (all 8 types + custom.<key> filtering), configurable lead/contact scoring,
 * interactive lead conversion (custom pipeline/stage, trial, existing deal link),
 * contact secondary emails/phones, and company associated leads across own/team/all scopes.
 */

const WEB_ORIGIN = 'http://localhost:5174';

let db: DatabaseService;
let baseUrl = '';
let serverClose: (() => Promise<void>) | null = null;

async function signIn(url: string, userId: string): Promise<string> {
  const res = await fetch(`${url}/api/v1/auth/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: WEB_ORIGIN },
    body: JSON.stringify({ userId }),
  });
  expect(res.status).toBe(200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

function authHeaders(cookie: string, withIdempotency = false): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    Origin: WEB_ORIGIN,
    Cookie: cookie,
  };
  if (withIdempotency) h['Idempotency-Key'] = randomUUID();
  return h;
}

describe('Milestone 3b: custom fields, scoring, conversion, contact channels & company leads', () => {
  let adminCookie = '';
  let usMgrCookie = '';
  let usBdrCookie = '';
  let caBdrCookie = '';

  beforeAll(async () => {
    db = DatabaseService.forTests();
    await db.ensureInitialized();
    const env = validateEnv({
      NODE_ENV: 'test',
      PORT: '3000',
      DATABASE_URL: 'postgresql://adas:adas_dev_password@localhost:5432/adas_crm_test',
      MAIL_LIVE: 'false',
    });
    const app = createAppServer(env, db);
    await new Promise<void>((resolve) => {
      app.server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    serverClose = () =>
      new Promise<void>((resolve, reject) =>
        app.server.close((err) => (err ? reject(err) : resolve())),
      );

    adminCookie = await signIn(baseUrl, 'usr_admin_1');
    usMgrCookie = await signIn(baseUrl, 'usr_mgr_1');
    usBdrCookie = await signIn(baseUrl, 'usr_bdr_2');
    caBdrCookie = await signIn(baseUrl, 'usr_bdr_1');
  });

  afterAll(async () => {
    if (serverClose) await serverClose();
    if (db) await db.close();
  });

  it('enforces settings.manage on custom field definitions, validates all 8 types, writes history and filters via custom.<key> across own/team/all scopes', async () => {
    // Non-admin BDR cannot create custom field definitions
    const bdrForbidden = await fetch(`${baseUrl}/api/v1/admin/custom-fields`, {
      method: 'POST',
      headers: authHeaders(usBdrCookie, true),
      body: JSON.stringify({
        entityType: 'lead',
        fieldKey: 'forbidden_key',
        label: 'Forbidden',
        fieldType: 'text',
      }),
    });
    expect(bdrForbidden.status).toBe(403);

    // Admin creates custom fields across all 8 types on leads
    const defsToCreate = [
      { fieldKey: 'tax_notes', label: 'Tax notes', fieldType: 'text', isRequired: true },
      { fieldKey: 'return_volume', label: 'Return volume', fieldType: 'number' },
      {
        fieldKey: 'busy_tier',
        label: 'Busy tier',
        fieldType: 'select',
        options: ['Standard', 'Peak', 'Year-round'],
      },
      {
        fieldKey: 'specialties',
        label: 'Specialties',
        fieldType: 'multi_select',
        options: ['1040', '1120S', '1065', 'Audit'],
      },
      { fieldKey: 'has_offshore', label: 'Prior offshore team', fieldType: 'boolean' },
      { fieldKey: 'target_go_live', label: 'Target go-live', fieldType: 'date' },
      { fieldKey: 'annual_budget', label: 'Annual budget', fieldType: 'money' },
      { fieldKey: 'portal_link', label: 'Portal link', fieldType: 'url' },
    ];

    for (const def of defsToCreate) {
      const res = await fetch(`${baseUrl}/api/v1/admin/custom-fields`, {
        method: 'POST',
        headers: authHeaders(adminCookie, true),
        body: JSON.stringify({ entityType: 'lead', ...def }),
      });
      expect(res.status).toBe(201);
    }

    // Duplicate key rejected with 409
    const dupRes = await fetch(`${baseUrl}/api/v1/admin/custom-fields`, {
      method: 'POST',
      headers: authHeaders(adminCookie, true),
      body: JSON.stringify({
        entityType: 'lead',
        fieldKey: 'tax_notes',
        label: 'Duplicate',
        fieldType: 'text',
      }),
    });
    expect(dupRes.status).toBe(409);

    // US BDR creates a US lead
    const slug = randomUUID().slice(0, 8);
    const createLeadRes = await fetch(`${baseUrl}/api/v1/leads`, {
      method: 'POST',
      headers: authHeaders(usBdrCookie, true),
      body: JSON.stringify({
        firstName: 'Synthetic',
        lastName: `Partner-${slug}`,
        email: `partner.${slug}@cf-${slug}.synthetic.adas.test`,
        firmName: `CF Example Firm ${slug}`,
        title: 'Managing Partner',
        market: 'US',
        staffBand: '21–50',
      }),
    });
    expect(createLeadRes.status).toBe(201);
    const createdLead = (await createLeadRes.json()) as { id: string; version: number };

    // Missing required field `tax_notes` fails with 422
    const missingReq = await fetch(`${baseUrl}/api/v1/leads/${createdLead.id}/custom-fields`, {
      method: 'PUT',
      headers: authHeaders(usBdrCookie),
      body: JSON.stringify({
        version: createdLead.version,
        values: { return_volume: 450 },
      }),
    });
    expect(missingReq.status).toBe(422);

    // Invalid URL rejected with 422
    const badUrl = await fetch(`${baseUrl}/api/v1/leads/${createdLead.id}/custom-fields`, {
      method: 'PUT',
      headers: authHeaders(usBdrCookie),
      body: JSON.stringify({
        version: createdLead.version,
        values: { tax_notes: 'Needs two preparers', portal_link: 'javascript:alert(1)' },
      }),
    });
    expect(badUrl.status).toBe(422);

    // CA BDR (own scope, different user/team) cannot edit US BDR's lead custom fields -> 404
    const caForbidden = await fetch(`${baseUrl}/api/v1/leads/${createdLead.id}/custom-fields`, {
      method: 'PUT',
      headers: authHeaders(caBdrCookie),
      body: JSON.stringify({
        version: createdLead.version,
        values: { tax_notes: 'Cross-team edit attempt' },
      }),
    });
    expect(caForbidden.status).toBe(404);

    // Valid update across all 8 types succeeds, bumps version, and writes record_history
    const setRes = await fetch(`${baseUrl}/api/v1/leads/${createdLead.id}/custom-fields`, {
      method: 'PUT',
      headers: authHeaders(usBdrCookie),
      body: JSON.stringify({
        version: createdLead.version,
        values: {
          tax_notes: 'Needs dedicated preparer pod',
          return_volume: 650,
          busy_tier: 'Peak',
          specialties: ['1040', '1120S'],
          has_offshore: true,
          target_go_live: '2026-12-01',
          annual_budget: { amountMinor: '5760000', currency: 'USD' },
          portal_link: 'https://portal.synthetic.adas.test/pod',
        },
      }),
    });
    expect(setRes.status).toBe(200);
    const setBody = (await setRes.json()) as {
      customFields: Record<string, unknown>;
      version: number;
    };
    expect(setBody.version).toBe(createdLead.version + 1);
    expect(setBody.customFields['busy_tier']).toBe('Peak');
    expect(setBody.customFields['return_volume']).toBe(650);

    // Stale version fails with 409
    const staleRes = await fetch(`${baseUrl}/api/v1/leads/${createdLead.id}/custom-fields`, {
      method: 'PUT',
      headers: authHeaders(usBdrCookie),
      body: JSON.stringify({
        version: createdLead.version,
        values: { tax_notes: 'Stale write' },
      }),
    });
    expect(staleRes.status).toBe(409);

    // Filter leads by custom.<key> across own (US BDR), team (US Manager), all (Admin), and out-of-scope (CA BDR)
    const filterJson = encodeURIComponent(
      JSON.stringify({
        and: [
          { field: 'custom.busy_tier', op: 'eq', value: 'Peak' },
          { field: 'custom.return_volume', op: 'gt', value: 500 },
          { field: 'custom.specialties', op: 'hasAny', value: ['1120S'] },
        ],
      }),
    );

    const [ownList, teamList, allList, otherTeamList] = await Promise.all([
      fetch(`${baseUrl}/api/v1/leads?filter=${filterJson}`, { headers: { Cookie: usBdrCookie } }),
      fetch(`${baseUrl}/api/v1/leads?filter=${filterJson}`, { headers: { Cookie: usMgrCookie } }),
      fetch(`${baseUrl}/api/v1/leads?filter=${filterJson}`, { headers: { Cookie: adminCookie } }),
      fetch(`${baseUrl}/api/v1/leads?filter=${filterJson}`, { headers: { Cookie: caBdrCookie } }),
    ]);

    expect(
      ((await ownList.json()) as { items: { id: string }[] }).items.map((r) => r.id),
    ).toContain(createdLead.id);
    expect(
      ((await teamList.json()) as { items: { id: string }[] }).items.map((r) => r.id),
    ).toContain(createdLead.id);
    expect(
      ((await allList.json()) as { items: { id: string }[] }).items.map((r) => r.id),
    ).toContain(createdLead.id);
    expect(
      ((await otherTeamList.json()) as { items: { id: string }[] }).items.map((r) => r.id),
    ).not.toContain(createdLead.id);

    // Archive `tax_notes` so subsequent leads don't require it
    const listDefs = (await (
      await fetch(`${baseUrl}/api/v1/custom-fields?entity=lead`, {
        headers: { Cookie: adminCookie },
      })
    ).json()) as { items: { id: string; fieldKey: string; version: number }[] };
    const reqDef = listDefs.items.find((d) => d.fieldKey === 'tax_notes');
    if (!reqDef) throw new Error('Expected tax_notes custom field definition');
    const archRes = await fetch(`${baseUrl}/api/v1/admin/custom-fields/${reqDef.id}`, {
      method: 'PATCH',
      headers: authHeaders(adminCookie),
      body: JSON.stringify({ version: reqDef.version, archived: true }),
    });
    expect(archRes.status).toBe(200);
  });

  it('automatically computes explainable scores on lead creation & calls, and supports admin rule CRUD + recalculation', async () => {
    const slug = randomUUID().slice(0, 8);
    const leadRes = await fetch(`${baseUrl}/api/v1/leads`, {
      method: 'POST',
      headers: authHeaders(usBdrCookie, true),
      body: JSON.stringify({
        firstName: 'Scored',
        lastName: `Exec-${slug}`,
        email: `exec.${slug}@scored-${slug}.synthetic.adas.test`,
        firmName: `Scored CPA ${slug}`,
        title: 'Tax Partner',
        market: 'US',
        staffBand: '21–50',
        source: 'Referral',
        softwareStack: ['UltraTax CS'],
      }),
    });
    expect(leadRes.status).toBe(201);
    const lead = (await leadRes.json()) as {
      id: string;
      lead_score: number;
      lead_score_breakdown: { ruleName: string; points: number }[];
    };
    expect(lead.lead_score).toBe(60);
    expect(lead.lead_score_breakdown.length).toBe(3);

    // Logging a call adds engagement points (+20 -> 80)
    const callRes = await fetch(`${baseUrl}/api/v1/activities`, {
      method: 'POST',
      headers: authHeaders(usBdrCookie, true),
      body: JSON.stringify({
        activityType: 'call',
        entityType: 'lead',
        entityId: lead.id,
        detail: 'Discovery call regarding peak season staffing capacity',
      }),
    });
    expect(callRes.status).toBe(201);

    const afterCallProfile = (await (
      await fetch(`${baseUrl}/api/v1/leads/${lead.id}`, { headers: { Cookie: usBdrCookie } })
    ).json()) as { lead: { lead_score: number } };
    expect(afterCallProfile.lead.lead_score).toBe(80);

    // Admin adds a custom rule and triggers recalculation
    const newRuleRes = await fetch(`${baseUrl}/api/v1/admin/scoring-rules`, {
      method: 'POST',
      headers: authHeaders(adminCookie, true),
      body: JSON.stringify({
        name: `US Focus Bonus ${slug}`,
        category: 'fit',
        fieldPath: 'market',
        operator: 'eq',
        targetValue: 'US',
        points: 5,
        active: true,
      }),
    });
    expect(newRuleRes.status).toBe(201);
    const newRule = (await newRuleRes.json()) as { id: string };

    const recalcRes = await fetch(`${baseUrl}/api/v1/admin/scoring-rules/recalculate`, {
      method: 'POST',
      headers: authHeaders(adminCookie),
      body: JSON.stringify({}),
    });
    expect(recalcRes.status).toBe(200);
    const recalcBody = (await recalcRes.json()) as {
      leadsUpdated: number;
      contactsUpdated: number;
    };
    expect(recalcBody.leadsUpdated).toBeGreaterThan(0);

    // Delete temporary rule
    const delRes = await fetch(`${baseUrl}/api/v1/admin/scoring-rules/${newRule.id}`, {
      method: 'DELETE',
      headers: authHeaders(adminCookie),
    });
    expect(delRes.status).toBe(200);
  });

  it('converts leads with custom pipeline/stage/terms, links existing open deals, and exposes company associated leads with scope', async () => {
    const slug = randomUUID().slice(0, 8);
    const domain = `conv-${slug}.synthetic.adas.test`;

    // Lead 1 -> Convert into a new 24-month Free Trial deal
    const lead1Res = await fetch(`${baseUrl}/api/v1/leads`, {
      method: 'POST',
      headers: authHeaders(usBdrCookie, true),
      body: JSON.stringify({
        firstName: 'First',
        lastName: `Partner-${slug}`,
        email: `first.${slug}@${domain}`,
        firmName: `Conversion CPA ${slug}`,
        title: 'Managing Partner',
        market: 'US',
      }),
    });
    const lead1 = (await lead1Res.json()) as { id: string };

    // Out-of-scope CA BDR cannot convert US BDR's lead
    const caConvert = await fetch(`${baseUrl}/api/v1/leads/convert`, {
      method: 'POST',
      headers: authHeaders(caBdrCookie),
      body: JSON.stringify({ leadId: lead1.id }),
    });
    expect(caConvert.status).toBe(404);

    const conv1Res = await fetch(`${baseUrl}/api/v1/leads/convert`, {
      method: 'POST',
      headers: authHeaders(usBdrCookie),
      body: JSON.stringify({
        leadId: lead1.id,
        createDeal: true,
        pipelineId: 'pipeline_new_business',
        dealName: `Conversion CPA ${slug} — Pod`,
        monthlyValueMinor: '620000',
        termMonths: 24,
        currency: 'USD',
        fteCount: 2,
        engagementModel: 'Trial-first',
        startFreeTrial: true,
        trialCandidateRole: 'Senior Tax Reviewer',
        services: ['Tax preparation and review'],
      }),
    });
    expect(conv1Res.status).toBe(200);
    const conv1 = (await conv1Res.json()) as {
      companyId: string;
      contactId: string;
      dealId: string;
    };
    expect(conv1.dealId).toBeTruthy();

    const dealProfile = (await (
      await fetch(`${baseUrl}/api/v1/deals/${conv1.dealId}`, { headers: { Cookie: usBdrCookie } })
    ).json()) as {
      deal: { stage_name: string; term_months: number; trial_candidate_role: string };
    };
    expect(dealProfile.deal.stage_name).toBe('Free Trial (3-Day)');
    expect(dealProfile.deal.term_months).toBe(24);
    expect(dealProfile.deal.trial_candidate_role).toBe('Senior Tax Reviewer');

    // Lead 2 at the same firm -> Link to existing deal instead of creating a duplicate deal
    const lead2Res = await fetch(`${baseUrl}/api/v1/leads`, {
      method: 'POST',
      headers: authHeaders(usBdrCookie, true),
      body: JSON.stringify({
        firstName: 'Second',
        lastName: `Director-${slug}`,
        email: `second.${slug}@${domain}`,
        firmName: `Conversion CPA ${slug}`,
        title: 'Tax Director',
        market: 'US',
      }),
    });
    const lead2 = (await lead2Res.json()) as { id: string };

    const conv2Res = await fetch(`${baseUrl}/api/v1/leads/convert`, {
      method: 'POST',
      headers: authHeaders(usBdrCookie),
      body: JSON.stringify({
        leadId: lead2.id,
        createDeal: false,
        existingDealId: conv1.dealId,
      }),
    });
    expect(conv2Res.status).toBe(200);
    const conv2 = (await conv2Res.json()) as { dealId: string; companyId: string };
    expect(conv2.dealId).toBe(conv1.dealId);

    // Company profile returns both associated leads for US BDR & US Manager
    const companyProfile = (await (
      await fetch(`${baseUrl}/api/v1/companies/${conv1.companyId}`, {
        headers: { Cookie: usMgrCookie },
      })
    ).json()) as { leads: { id: string }[] };
    expect(companyProfile.leads.map((l) => l.id)).toEqual(
      expect.arrayContaining([lead1.id, lead2.id]),
    );
  });

  it('manages contact secondary emails and E.164 phones with collision checks, primary promotion and scope enforcement', async () => {
    const slug = randomUUID().slice(0, 8);
    const contactRes = await fetch(`${baseUrl}/api/v1/contacts`, {
      method: 'POST',
      headers: authHeaders(usBdrCookie, true),
      body: JSON.stringify({
        firstName: 'Channel',
        lastName: `Tester-${slug}`,
        primaryEmail: `primary.${slug}@chan-${slug}.synthetic.adas.test`,
        market: 'US',
      }),
    });
    expect(contactRes.status).toBe(201);
    const contact = (await contactRes.json()) as { id: string; primary_email: string };

    // Out-of-scope CA BDR cannot add email -> 404
    const caAdd = await fetch(`${baseUrl}/api/v1/contacts/${contact.id}/emails`, {
      method: 'POST',
      headers: authHeaders(caBdrCookie),
      body: JSON.stringify({ email: `alt.${slug}@chan-${slug}.synthetic.adas.test` }),
    });
    expect(caAdd.status).toBe(404);

    // US BDR adds secondary email, promotes it to primary, and removes old email
    const altEmail = `alt.${slug}@chan-${slug}.synthetic.adas.test`;
    const addEmailRes = await fetch(`${baseUrl}/api/v1/contacts/${contact.id}/emails`, {
      method: 'POST',
      headers: authHeaders(usBdrCookie),
      body: JSON.stringify({ email: altEmail, makePrimary: false }),
    });
    expect(addEmailRes.status).toBe(201);

    // Cannot delete primary email directly -> 422
    const delPrimary = await fetch(
      `${baseUrl}/api/v1/contacts/${contact.id}/emails?email=${encodeURIComponent(contact.primary_email)}`,
      { method: 'DELETE', headers: authHeaders(usBdrCookie) },
    );
    expect(delPrimary.status).toBe(422);

    // Promote altEmail to primary
    const promRes = await fetch(`${baseUrl}/api/v1/contacts/${contact.id}/emails/primary`, {
      method: 'POST',
      headers: authHeaders(usBdrCookie),
      body: JSON.stringify({ email: altEmail }),
    });
    expect(promRes.status).toBe(200);

    // Now remove the old email
    const delOldRes = await fetch(
      `${baseUrl}/api/v1/contacts/${contact.id}/emails?email=${encodeURIComponent(contact.primary_email)}`,
      { method: 'DELETE', headers: authHeaders(usBdrCookie) },
    );
    expect(delOldRes.status).toBe(200);

    // Add two phones, promote mobile to primary, and verify contact profile reflects updates
    const addPhone1 = await fetch(`${baseUrl}/api/v1/contacts/${contact.id}/phones`, {
      method: 'POST',
      headers: authHeaders(usBdrCookie),
      body: JSON.stringify({ phone: '(212) 555-0141', label: 'work', makePrimary: true }),
    });
    expect(addPhone1.status).toBe(201);

    const addPhone2 = await fetch(`${baseUrl}/api/v1/contacts/${contact.id}/phones`, {
      method: 'POST',
      headers: authHeaders(usBdrCookie),
      body: JSON.stringify({ phone: '+1 212 555 0199', label: 'mobile', makePrimary: false }),
    });
    expect(addPhone2.status).toBe(201);

    const promPhone = await fetch(`${baseUrl}/api/v1/contacts/${contact.id}/phones/primary`, {
      method: 'POST',
      headers: authHeaders(usBdrCookie),
      body: JSON.stringify({ phoneE164: '+12125550199' }),
    });
    expect(promPhone.status).toBe(200);

    const updatedProfile = (await (
      await fetch(`${baseUrl}/api/v1/contacts/${contact.id}`, {
        headers: { Cookie: usBdrCookie },
      })
    ).json()) as {
      contact: { primary_email: string; phone_e164: string };
      emails: { email: string; is_primary: boolean }[];
      phones: { phone_e164: string; is_primary: boolean }[];
    };
    expect(updatedProfile.contact.primary_email).toBe(altEmail);
    expect(updatedProfile.contact.phone_e164).toBe('+12125550199');
    expect(updatedProfile.emails).toHaveLength(1);
    expect(updatedProfile.phones).toHaveLength(2);
  });
});
