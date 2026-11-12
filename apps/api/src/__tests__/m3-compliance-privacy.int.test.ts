import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AddressInfo } from 'node:net';
import { createAppServer } from '../main.js';
import { AuthAndUsersService } from '../modules/auth/index.js';
import { ImportProcessor, ImportService } from '../modules/imports/index.js';
import { validateEnv } from '../platform/config/index.js';
import { DatabaseService, sha256Hex } from '../platform/db/index.js';
import { MemoryFileStorage } from '../platform/files/index.js';
import { createLogger } from '../platform/logger/index.js';

/**
 * Suppressions, suppressed domains, consent records, derived marketing basis, won-deal
 * implied EBR hook, and privacy access export / erasure (PRD 4.17, 4.18, 5.1–5.6, 9, 12.1 A14).
 * Uses synthetic addresses and names only.
 */

const WEB_ORIGIN = 'http://localhost:5174';

let db: DatabaseService;
let files: MemoryFileStorage;
let baseUrl = '';
let serverClose: () => Promise<void>;

async function signInCookie(userId: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/v1/auth/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: WEB_ORIGIN },
    body: JSON.stringify({ userId }),
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get('set-cookie');
  expect(setCookie).toBeTruthy();
  return (setCookie as string).split(';')[0] ?? '';
}

async function apiCall(
  cookie: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {
    Cookie: cookie,
    Origin: WEB_ORIGIN,
  };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  return fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe('M3 compliance, suppressions, consent and privacy operations', () => {
  let adminCookie = '';
  let managerCookie = '';
  let marketingCookie = '';
  let bdrUsCookie = '';
  let bdrCaCookie = '';
  let readOnlyCookie = '';

  beforeAll(async () => {
    db = DatabaseService.forTests();
    await db.ensureInitialized();
    files = new MemoryFileStorage();
    const app = createAppServer(
      validateEnv({
        NODE_ENV: 'test',
        LOG_LEVEL: 'error',
        PUBLIC_WEB_URL: WEB_ORIGIN,
      }),
      db,
      { files },
    );
    await new Promise<void>((resolve) => {
      app.server.listen(0, '127.0.0.1', () => {
        const addr = app.server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
    serverClose = () =>
      new Promise<void>((resolve, reject) => {
        app.server.close((err) => (err ? reject(err) : resolve()));
      });

    adminCookie = await signInCookie('usr_admin_1');
    managerCookie = await signInCookie('usr_mgr_1');
    marketingCookie = await signInCookie('usr_mkt_1');
    bdrUsCookie = await signInCookie('usr_bdr_2');
    bdrCaCookie = await signInCookie('usr_bdr_1');
    readOnlyCookie = await signInCookie('usr_ro_1');
  }, 90_000);

  afterAll(async () => {
    await serverClose();
    await db.close();
  });

  it('returns 404 on removed simulated n8n, warmup and deployment prototype routes', async () => {
    for (const [method, path] of [
      ['POST', '/api/v1/n8n/pipeline/trigger'],
      ['POST', '/api/v1/n8n/webhooks/dispatch'],
      ['POST', '/api/v1/n8n/api-tokens'],
      ['GET', '/api/v1/outreach/warmup-status'],
      ['POST', '/api/v1/outreach/tailor-preview'],
      ['POST', '/api/v1/deployment/blueprint'],
    ] as const) {
      const res = await apiCall(adminCookie, method, path, method === 'POST' ? {} : undefined);
      expect(res.status).toBe(404);
    }
  });

  it('gates suppressions on compliance.manage and lifting on privacy.manage, without PII in audit metadata', async () => {
    // BDR and Read-Only lack compliance.manage
    expect((await apiCall(bdrUsCookie, 'GET', '/api/v1/compliance/suppressions')).status).toBe(403);
    expect((await apiCall(readOnlyCookie, 'GET', '/api/v1/compliance/suppressions')).status).toBe(
      403,
    );

    // Marketing Manager has compliance.manage: can add and search by email or SHA-256
    const targetEmail = 'claire.benson@cedarbrook-cpa.example.com';
    const createdContact = await apiCall(adminCookie, 'POST', '/api/v1/contacts', {
      firstName: 'Claire',
      lastName: 'Benson',
      primaryEmail: targetEmail,
      market: 'US',
    });
    expect(createdContact.status).toBe(201);
    const contact = (await createdContact.json()) as { id: string };

    const addRes = await apiCall(marketingCookie, 'POST', '/api/v1/compliance/suppressions', {
      email: targetEmail,
      reason: 'manual_dnc',
      notes: 'Requested opt-out by phone',
    });
    expect(addRes.status).toBe(201);
    const sup = (await addRes.json()) as { id: string; emailSha256: string };
    expect(sup.emailSha256).toBe(sha256Hex(targetEmail));

    // Search by SHA-256 hash finds the suppression
    const byHash = await apiCall(
      marketingCookie,
      'GET',
      `/api/v1/compliance/suppressions?q=${sup.emailSha256}`,
    );
    expect(byHash.status).toBe(200);
    const hashPage = (await byHash.json()) as { items: { id: string }[]; total: number };
    expect(hashPage.items.map((i) => i.id)).toContain(sup.id);

    // Sendability check blocks outreach while active
    const blockedGate = await apiCall(
      marketingCookie,
      'POST',
      '/api/v1/compliance/check-sendable',
      {
        email: targetEmail,
        channel: 'sequence',
        bypassSendWindow: true,
      },
    );
    expect(blockedGate.status).toBe(200);
    expect(
      ((await blockedGate.json()) as { sendable: boolean; reasonCode: string }).reasonCode,
    ).toBe('SUPPRESSED_EMAIL');

    // Marketing Manager and Sales Manager cannot lift (requires privacy.manage)
    expect(
      (
        await apiCall(marketingCookie, 'POST', `/api/v1/compliance/suppressions/${sup.id}/lift`, {
          reason: 'Client asked to re-subscribe in writing',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await apiCall(managerCookie, 'POST', `/api/v1/compliance/suppressions/${sup.id}/lift`, {
          reason: 'Client asked to re-subscribe in writing',
        })
      ).status,
    ).toBe(403);

    // Admin requires a reason of at least 5 characters
    expect(
      (
        await apiCall(adminCookie, 'POST', `/api/v1/compliance/suppressions/${sup.id}/lift`, {
          reason: 'ok',
        })
      ).status,
    ).toBe(422);

    // Admin lifts with valid reason: contact do_not_contact is cleared, sendability restored, audit contains no email
    const liftRes = await apiCall(
      adminCookie,
      'POST',
      `/api/v1/compliance/suppressions/${sup.id}/lift`,
      { reason: 'Written confirmation from partner requesting updates' },
    );
    expect(liftRes.status).toBe(200);

    const unblockedGate = await apiCall(adminCookie, 'POST', '/api/v1/compliance/check-sendable', {
      email: targetEmail,
      channel: 'sequence',
      bypassSendWindow: true,
    });
    expect(((await unblockedGate.json()) as { sendable: boolean }).sendable).toBe(true);

    const profileRes = await apiCall(adminCookie, 'GET', `/api/v1/contacts/${contact.id}`);
    const profile = (await profileRes.json()) as {
      contact: { do_not_contact: boolean };
      suppression: unknown;
    };
    expect(profile.contact.do_not_contact).toBe(false);
    expect(profile.suppression).toBeNull();

    const auditRows = await db.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_logs
       WHERE action = 'compliance.suppression_lifted' AND entity_id = $1`,
      [sup.id],
    );
    expect(auditRows.rows).toHaveLength(1);
    expect(JSON.stringify(auditRows.rows[0]?.metadata)).not.toContain(targetEmail);
  });

  it('blocks corporate domains, refuses free-mail domains, and gates domain removal on privacy.manage', async () => {
    // Free-mail domains cannot be blocked whole
    const gmailRes = await apiCall(
      marketingCookie,
      'POST',
      '/api/v1/compliance/suppressed-domains',
      {
        domain: 'gmail.com',
        reason: 'Accidental entry',
      },
    );
    expect(gmailRes.status).toBe(422);

    // Corporate domain block succeeds and stops sendability
    const addDom = await apiCall(marketingCookie, 'POST', '/api/v1/compliance/suppressed-domains', {
      domain: 'https://www.Northridge-Tax.example.com/contact',
      reason: 'Managing partner requested firm-wide opt-out',
    });
    expect(addDom.status).toBe(201);
    const domainRow = (await addDom.json()) as { id: string; domain: string };
    expect(domainRow.domain).toBe('northridge-tax.example.com');

    const checkBlocked = await apiCall(
      marketingCookie,
      'POST',
      '/api/v1/compliance/check-sendable',
      {
        email: 'partner@northridge-tax.example.com',
        channel: 'sequence',
        bypassSendWindow: true,
      },
    );
    expect(((await checkBlocked.json()) as { reasonCode: string }).reasonCode).toBe(
      'SUPPRESSED_DOMAIN',
    );

    // Non-admin cannot remove domain block
    expect(
      (
        await apiCall(
          marketingCookie,
          'POST',
          `/api/v1/compliance/suppressed-domains/${domainRow.id}/remove`,
          { reason: 'Signed engagement letter' },
        )
      ).status,
    ).toBe(403);

    // Admin removes domain block with reason
    const remRes = await apiCall(
      adminCookie,
      'POST',
      `/api/v1/compliance/suppressed-domains/${domainRow.id}/remove`,
      { reason: 'Signed engagement letter with firm' },
    );
    expect(remRes.status).toBe(200);
  });

  it('enforces own/team/all scope on contact consent and records 24-month implied EBR consent when a deal is Won', async () => {
    // Canadian contact owned by usr_bdr_1 (team_ca)
    const createRes = await apiCall(adminCookie, 'POST', '/api/v1/contacts', {
      firstName: 'Marc',
      lastName: 'Tremblay',
      primaryEmail: 'marc.tremblay@laurentian-cpa.example.ca',
      market: 'CA',
      ownerUserId: 'usr_bdr_1',
    });
    expect(createRes.status).toBe(201);
    const caContact = (await createRes.json()) as { id: string };

    // Initially None in Canada
    const beforeProfile = (await (
      await apiCall(bdrCaCookie, 'GET', `/api/v1/contacts/${caContact.id}`)
    ).json()) as { marketingBasis: { kind: string; label: string } };
    expect(beforeProfile.marketingBasis.kind).toBe('none');

    // US BDR (own scope, different owner) cannot record consent on Marc (404 outside scope)
    const wrongOwner = await apiCall(
      bdrUsCookie,
      'POST',
      `/api/v1/contacts/${caContact.id}/consents`,
      {
        basis: 'express',
        source: 'Conference form',
      },
    );
    expect(wrongOwner.status).toBe(404);

    // Owning Canadian BDR records Express consent -> marketingBasis becomes Express, sendability passes
    const recordRes = await apiCall(
      bdrCaCookie,
      'POST',
      `/api/v1/contacts/${caContact.id}/consents`,
      {
        basis: 'express',
        purpose: 'marketing',
        source: 'Toronto CPA Symposium opt-in card',
        proofText: 'Signed card agreeing to receive staffing updates from ADAS Globus Pro',
      },
    );
    expect(recordRes.status).toBe(201);

    const afterExpress = (await (
      await apiCall(bdrCaCookie, 'GET', `/api/v1/contacts/${caContact.id}`)
    ).json()) as { marketingBasis: { kind: string; label: string } };
    expect(afterExpress.marketingBasis.label).toBe('Express');

    const caGate = await apiCall(adminCookie, 'POST', '/api/v1/compliance/check-sendable', {
      email: 'marc.tremblay@laurentian-cpa.example.ca',
      channel: 'campaign',
      bypassSendWindow: true,
    });
    expect(((await caGate.json()) as { sendable: boolean }).sendable).toBe(true);

    // Withdraw consent -> marketingBasis drops to None and CASL gate blocks again
    const withdrawRes = await apiCall(
      bdrCaCookie,
      'POST',
      `/api/v1/contacts/${caContact.id}/consents/withdraw`,
      { reason: 'Asked to pause newsletter emails', suppressAddress: false },
    );
    expect(withdrawRes.status).toBe(200);

    const caGateAfterWithdraw = await apiCall(
      adminCookie,
      'POST',
      '/api/v1/compliance/check-sendable',
      {
        email: 'marc.tremblay@laurentian-cpa.example.ca',
        channel: 'campaign',
        bypassSendWindow: true,
      },
    );
    expect(((await caGateAfterWithdraw.json()) as { sendable: boolean }).sendable).toBe(false);

    // Moving a deal to Won automatically grants 24-month implied_ebr consent to unsuppressed client contacts
    const compRes = await apiCall(adminCookie, 'POST', '/api/v1/companies', {
      name: 'Maple Ridge Tax LLP',
      websiteOrDomain: 'mapleridgetax.example.ca',
      market: 'CA',
    });
    const caCompany = ((await compRes.json()) as { company: { id: string } }).company;

    const ebrContactRes = await apiCall(adminCookie, 'POST', '/api/v1/contacts', {
      companyId: caCompany.id,
      firstName: 'Sophie',
      lastName: 'Gagnon',
      primaryEmail: 'sophie.gagnon@mapleridgetax.example.ca',
      market: 'CA',
    });
    const ebrContact = (await ebrContactRes.json()) as { id: string };

    const dealRes = await apiCall(adminCookie, 'POST', '/api/v1/deals', {
      companyId: caCompany.id,
      primaryContactId: ebrContact.id,
      name: 'Maple Ridge — 2 Tax Seniors',
      monthlyValueMinor: '640000',
      currency: 'CAD',
      fteCount: 2,
    });
    const deal = (await dealRes.json()) as { id: string; version: number };

    const wonRes = await apiCall(adminCookie, 'PATCH', `/api/v1/deals/${deal.id}/stage`, {
      stageName: 'Won',
      version: deal.version,
      contractStartDate: '2026-11-15',
    });
    expect(wonRes.status).toBe(200);

    const ebrProfile = (await (
      await apiCall(adminCookie, 'GET', `/api/v1/contacts/${ebrContact.id}`)
    ).json()) as { marketingBasis: { kind: string; label: string; expiresAt: string | null } };
    expect(ebrProfile.marketingBasis.kind).toBe('implied');
    expect(ebrProfile.marketingBasis.expiresAt).toBeTruthy();

    const ebrSendable = await apiCall(adminCookie, 'POST', '/api/v1/compliance/check-sendable', {
      email: 'sophie.gagnon@mapleridgetax.example.ca',
      channel: 'campaign',
      bypassSendWindow: true,
    });
    expect(((await ebrSendable.json()) as { sendable: boolean }).sendable).toBe(true);
  });

  it('exports contact data in JSON/CSV and performs permanent privacy erasure (A14) that blocks re-creation and CSV re-import', async () => {
    const eraseEmail = 'erasure.subject@harborview-cpa.example.com';

    // Create company, lead, contact, note, activity, deal
    const compRes = await apiCall(adminCookie, 'POST', '/api/v1/companies', {
      name: 'Harborview CPA Group',
      websiteOrDomain: 'harborview-cpa.example.com',
      market: 'US',
    });
    const company = ((await compRes.json()) as { company: { id: string } }).company;

    const contactRes = await apiCall(adminCookie, 'POST', '/api/v1/contacts', {
      companyId: company.id,
      firstName: 'Evelyn',
      lastName: 'Mercer',
      primaryEmail: eraseEmail,
      phone: '+12125550194',
      title: '=SUM(1,2) Managing Partner',
      market: 'US',
    });
    expect(contactRes.status).toBe(201);
    const contact = (await contactRes.json()) as { id: string; version: number };

    await apiCall(adminCookie, 'POST', '/api/v1/notes', {
      entityType: 'contact',
      entityId: contact.id,
      body: 'Private staffing call note with personal phone details.',
    });
    await apiCall(adminCookie, 'POST', '/api/v1/activities', {
      activityType: 'call',
      entityType: 'contact',
      entityId: contact.id,
      detail: 'Discussed Q1 tax staffing budget with Evelyn.',
    });

    const dealRes = await apiCall(adminCookie, 'POST', '/api/v1/deals', {
      companyId: company.id,
      primaryContactId: contact.id,
      name: 'Harborview — Senior Tax Associate',
      monthlyValueMinor: '320000',
      currency: 'USD',
      fteCount: 1,
    });
    expect(dealRes.status).toBe(201);
    const deal = (await dealRes.json()) as { id: string };

    // Non-admin cannot export or erase privacy data
    expect(
      (await apiCall(marketingCookie, 'GET', `/api/v1/contacts/${contact.id}/privacy-export`))
        .status,
    ).toBe(403);
    expect(
      (
        await apiCall(marketingCookie, 'POST', `/api/v1/contacts/${contact.id}/privacy-erase`, {
          reason: 'Verified DSAR email',
        })
      ).status,
    ).toBe(403);

    // Admin exports JSON and CSV (formula-neutralised + BOM + audited without PII)
    const jsonExp = await apiCall(
      adminCookie,
      'GET',
      `/api/v1/contacts/${contact.id}/privacy-export`,
    );
    expect(jsonExp.status).toBe(200);
    const jsonPayload = (await jsonExp.json()) as {
      contact: { primary_email: string };
      notes: unknown[];
    };
    expect(jsonPayload.contact.primary_email).toBe(eraseEmail);
    expect(jsonPayload.notes.length).toBeGreaterThanOrEqual(1);

    const csvExp = await apiCall(
      adminCookie,
      'GET',
      `/api/v1/contacts/${contact.id}/privacy-export?format=csv`,
    );
    expect(csvExp.status).toBe(200);
    const csvBuf = Buffer.from(await csvExp.arrayBuffer());
    const csvText = csvBuf.toString('utf8');
    expect(csvText.charCodeAt(0)).toBe(0xfeff);
    expect(csvText).toContain("'=SUM(1,2) Managing Partner");

    const beforeActivityCount = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM activities WHERE contact_id = $1`,
      [contact.id],
    );
    expect(Number(beforeActivityCount.rows[0]?.n ?? '0')).toBeGreaterThan(0);

    // Admin executes privacy erasure
    const eraseRes = await apiCall(
      adminCookie,
      'POST',
      `/api/v1/contacts/${contact.id}/privacy-erase`,
      { reason: 'Verified privacy erasure request #DSAR-2026-11' },
    );
    expect(eraseRes.status).toBe(200);

    // Contact is soft-deleted and personal fields are scrubbed in SQL
    expect((await apiCall(adminCookie, 'GET', `/api/v1/contacts/${contact.id}`)).status).toBe(404);
    const rawContact = await db.query<{
      first_name: string;
      last_name: string;
      primary_email: string;
      phone_e164: string | null;
      deleted_at: string | null;
    }>(
      `SELECT first_name, last_name, primary_email, phone_e164, deleted_at
       FROM contacts WHERE id = $1`,
      [contact.id],
    );
    expect(rawContact.rows[0]?.first_name).toBe('Redacted');
    expect(rawContact.rows[0]?.primary_email).not.toContain('erasure.subject');
    expect(rawContact.rows[0]?.phone_e164).toBeNull();
    expect(rawContact.rows[0]?.deleted_at).toBeTruthy();

    // Notes and record history are deleted; activity row count is preserved with scrubbed detail; deal value intact
    const remainingNotes = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM notes WHERE entity_type = 'contact' AND entity_id = $1`,
      [contact.id],
    );
    expect(Number(remainingNotes.rows[0]?.n)).toBe(0);

    const afterActivities = await db.query<{ detail: string }>(
      `SELECT detail FROM activities WHERE contact_id = $1`,
      [contact.id],
    );
    expect(afterActivities.rows.length).toBe(Number(beforeActivityCount.rows[0]?.n));
    expect(JSON.stringify(afterActivities.rows)).not.toContain('Evelyn');

    const preservedDeal = await db.query<{
      monthly_value_minor: string;
      primary_contact_id: string | null;
    }>(`SELECT monthly_value_minor::text, primary_contact_id FROM deals WHERE id = $1`, [deal.id]);
    expect(preservedDeal.rows[0]?.monthly_value_minor).toBe('320000');
    expect(preservedDeal.rows[0]?.primary_contact_id).toBeNull();

    // Suppression row has email = NULL, holds SHA-256 hash, cannot be lifted via API OR SQL
    const hash = sha256Hex(eraseEmail);
    const supRows = await db.query<{ id: string; email: string | null; reason: string }>(
      `SELECT id, email, reason FROM suppressions WHERE email_sha256 = $1`,
      [hash],
    );
    expect(supRows.rows).toHaveLength(1);
    expect(supRows.rows[0]?.email).toBeNull();
    expect(supRows.rows[0]?.reason).toBe('privacy_erasure');
    const erasureSupId = String(supRows.rows[0]?.id);

    const liftAttempt = await apiCall(
      adminCookie,
      'POST',
      `/api/v1/compliance/suppressions/${erasureSupId}/lift`,
      { reason: 'Attempting to lift privacy erasure' },
    );
    expect(liftAttempt.status).toBe(409);

    await expect(
      db.query(
        `UPDATE suppressions SET lifted_at = NOW(), lifted_reason = 'override' WHERE id = $1`,
        [erasureSupId],
      ),
    ).rejects.toThrow();

    // Sendability check blocks the erased address via its SHA-256 hash
    const checkAfterErase = await apiCall(
      adminCookie,
      'POST',
      '/api/v1/compliance/check-sendable',
      {
        email: eraseEmail,
        channel: 'sequence',
        market: 'US',
      },
    );
    expect(((await checkAfterErase.json()) as { sendable: boolean }).sendable).toBe(false);

    // Re-creating a contact or lead with the erased email is refused with 409 PRIVACY_ERASED_ADDRESS
    expect(
      (
        await apiCall(adminCookie, 'POST', '/api/v1/contacts', {
          firstName: 'Evelyn',
          lastName: 'Mercer',
          primaryEmail: eraseEmail,
          market: 'US',
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await apiCall(adminCookie, 'POST', '/api/v1/leads', {
          firstName: 'Evelyn',
          lastName: 'Mercer',
          email: eraseEmail,
          market: 'US',
        })
      ).status,
    ).toBe(409);

    // CSV import skips the privacy-erased address instead of recreating the person (A14)
    const authService = new AuthAndUsersService(db);
    const importService = new ImportService(db, files);
    const processor = new ImportProcessor(
      db,
      files,
      (id) => authService.resolveSessionUser(id),
      createLogger('fatal'),
    );
    const drain = async () => {
      for (let i = 0; i < 50; i++) {
        const step = await processor.processNext();
        if (step.batches === 0) return;
      }
      throw new Error('import processor did not finish');
    };
    const adminUser = await authService.resolveSessionUser('usr_admin_1');
    const csv = Buffer.from(
      [
        'Email,First name,Last name,Company',
        `${eraseEmail},Evelyn,Mercer,Harborview CPA Group`,
        'fresh.partner@harborview-cpa.example.com,Noah,Grant,Harborview CPA Group',
      ].join('\n'),
      'utf8',
    );
    const uploaded = await importService.upload(adminUser, 'reimport.csv', csv, '127.0.0.1');
    const mapped = await importService.setMapping(adminUser, uploaded.batch.id, {
      entity: 'contact',
      version: uploaded.batch.version,
      mapping: {
        Email: 'email',
        'First name': 'firstName',
        'Last name': 'lastName',
        Company: 'companyName',
      },
      options: {
        duplicatePolicy: 'overwrite',
        source: 'Import',
        ownerUserId: 'usr_admin_1',
        market: 'US',
        tags: [],
      },
    });
    await importService.requestDryRun(adminUser, uploaded.batch.id, { version: mapped.version });
    await drain();
    const afterDry = await importService.get(adminUser, uploaded.batch.id);
    expect(afterDry.dryRunCounts?.created).toBe(1);
    expect(afterDry.dryRunCounts?.skipped).toBe(1);

    await importService.requestRun(
      adminUser,
      uploaded.batch.id,
      { version: afterDry.version },
      '127.0.0.1',
    );
    await drain();
    const afterRun = await importService.get(adminUser, uploaded.batch.id);
    expect(afterRun.status).toBe('completed');
    expect(afterRun.counts.created).toBe(1);
    expect(afterRun.counts.skipped).toBe(1);

    const checkReimported = await db.query<{ id: string }>(
      `SELECT id FROM contacts WHERE primary_email = $1 AND deleted_at IS NULL`,
      [eraseEmail],
    );
    expect(checkReimported.rows).toHaveLength(0);
  });
});
