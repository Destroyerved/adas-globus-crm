import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { request as httpRequest } from 'node:http';
import { type AddressInfo } from 'node:net';
import { purgeExpired } from '../jobs.js';
import { createAppServer } from '../main.js';
import { WebsiteIntakeService } from '../modules/intake/index.js';
import { validateEnv } from '../platform/config/index.js';
import { DatabaseService, sha256Hex } from '../platform/db/index.js';

/**
 * Website inquiry intake, durable market routing rules, public host CORS & per-IP rate limiting,
 * and hashed one-click unsubscribe (PRD 4.5, 4.10, 4.17, 4.18, 5.3, 5.5, 6.5, 8.6, 9, 12.1 A12 & A13).
 * Uses synthetic addresses and names only.
 */

const WEB_ORIGIN = 'http://localhost:5174';

let db: DatabaseService;
let baseUrl = '';
let serverPort = 0;
let serverClose: (() => Promise<void>) | null = null;
let appRef: ReturnType<typeof createAppServer>;

function requestWithHost(options: {
  hostHeader: string;
  method?: string;
  path: string;
  headers?: Record<string, string>;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port: serverPort,
        method: options.method ?? 'GET',
        path: options.path,
        headers: { Host: options.hostHeader, ...(options.headers ?? {}) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

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

describe('M4 website inquiry intake, routing rules & public host guardrails', () => {
  let adminCookie = '';
  let managerCookie = '';
  let bdrCookie = '';

  beforeAll(async () => {
    db = DatabaseService.forTests();
    await db.ensureInitialized();
    const env = validateEnv({
      NODE_ENV: 'test',
      PORT: '3000',
      DATABASE_URL: 'postgresql://adas:adas_dev_password@localhost:5432/adas_crm_test',
      INQUIRY_RATE_LIMIT_PER_10M: '5',
      MAIL_LIVE: 'false',
    });
    appRef = createAppServer(env, db);
    await new Promise<void>((resolve) => {
      appRef.server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = appRef.server.address() as AddressInfo;
    serverPort = addr.port;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    serverClose = () =>
      new Promise<void>((resolve, reject) =>
        appRef.server.close((err) => (err ? reject(err) : resolve())),
      );

    adminCookie = await signInCookie('usr_admin_1');
    managerCookie = await signInCookie('usr_mgr_1');
    bdrCookie = await signInCookie('usr_bdr_2');
  });

  afterAll(async () => {
    if (serverClose) await serverClose();
    if (db) await db.close();
  });

  it('exposes /healthz, /public/inquiries and /u/* on go.adasglobuspro.com while blocking CRM routes (PRD 6.5, 10.6)', async () => {
    const healthGo = await requestWithHost({
      hostHeader: 'go.adasglobuspro.com',
      path: '/healthz',
    });
    expect(healthGo.status).toBe(200);

    const leadsGo = await requestWithHost({
      hostHeader: 'go.adasglobuspro.com',
      path: '/api/v1/leads',
      headers: { Cookie: adminCookie },
    });
    expect(leadsGo.status).toBe(404);

    // Allowed marketing website CORS preflight
    const preflightAllowed = await fetch(`${baseUrl}/api/v1/public/inquiries`, {
      method: 'OPTIONS',
      headers: {
        Host: 'go.adasglobuspro.com',
        Origin: 'https://www.adasglobuspro.com',
        'Access-Control-Request-Method': 'POST',
      },
    });
    expect(preflightAllowed.status).toBe(204);
    expect(preflightAllowed.headers.get('access-control-allow-origin')).toBe(
      'https://www.adasglobuspro.com',
    );

    // Arbitrary origin is never reflected
    const preflightEvil = await fetch(`${baseUrl}/api/v1/public/inquiries`, {
      method: 'OPTIONS',
      headers: {
        Host: 'go.adasglobuspro.com',
        Origin: 'https://evil-scraper.example.org',
        'Access-Control-Request-Method': 'POST',
      },
    });
    expect(preflightEvil.status).toBe(204);
    expect(preflightEvil.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('A13: stores raw inquiries with hashed IP, links consent_records.inquiry_id, notifies the owner and returns generic 202 {"status":"received"} (PRD 4.10)', async () => {
    const visitorIp = '198.51.100.24';
    const httpRes = await fetch(`${baseUrl}/api/v1/public/inquiries`, {
      method: 'POST',
      headers: {
        Host: 'go.adasglobuspro.com',
        Origin: 'https://adasglobuspro.com',
        'Content-Type': 'application/json',
        'Cf-Connecting-Ip': visitorIp,
        'User-Agent': 'Mozilla/5.0 SyntheticTest/1.0',
      },
      body: JSON.stringify({
        name: 'Hannah Mercer',
        email: 'hannah.mercer@mercertaxcpa.example.com',
        firm: 'Mercer Tax & Advisory CPA',
        phone: '(312) 555-0172',
        need: 'Tax preparation and review',
        country: 'United States',
        software: 'UltraTax CS, QuickBooks',
        message: 'Looking for 2 seasonal tax seniors',
        pageUrl: 'https://www.adasglobuspro.com/#trial',
      }),
    });
    expect(httpRes.status).toBe(202);
    // Public HTTP response must NOT leak internal CRM IDs or honeypot detection
    const body = (await httpRes.json()) as Record<string, unknown>;
    expect(body).toEqual({ status: 'received' });

    const emailSha = sha256Hex('hannah.mercer@mercertaxcpa.example.com');
    const inqRows = await db.query<{
      id: string;
      form_type: string;
      market: string;
      ip_sha256: string | null;
      user_agent: string | null;
      deduplicated: boolean;
      lead_id: string | null;
      contact_id: string | null;
      company_id: string | null;
      consent_record_id: string | null;
      sla_task_id: string | null;
      assigned_user_id: string | null;
      raw_payload: Record<string, unknown>;
    }>(`SELECT * FROM inquiries WHERE email_sha256 = $1 ORDER BY created_at DESC`, [emailSha]);

    expect(inqRows.rows.length).toBe(1);
    const inq = inqRows.rows[0];
    expect(inq?.form_type).toBe('trial');
    expect(inq?.market).toBe('US');
    expect(inq?.deduplicated).toBe(false);
    expect(inq?.ip_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(inq?.ip_sha256).not.toBe(visitorIp);
    expect(JSON.stringify(inq?.raw_payload)).not.toContain(visitorIp);
    expect(inq?.lead_id).toMatch(/^lead_/);
    expect(inq?.contact_id).toMatch(/^cnt_/);
    expect(inq?.company_id).toMatch(/^cmp_/);
    expect(inq?.consent_record_id).toMatch(/^cns_/);
    expect(inq?.sla_task_id).toMatch(/^tsk_sla_/);

    // Consent record links back to inquiries.id
    const consentRow = await db.query<{ inquiry_id: string | null; basis: string }>(
      `SELECT inquiry_id, basis FROM consent_records WHERE id = $1`,
      [inq?.consent_record_id],
    );
    expect(consentRow.rows[0]).toEqual({
      inquiry_id: inq?.id ?? null,
      basis: 'implied_inquiry',
    });

    // Assigned owner received an unread in-app notification pointing at the lead
    const notifRow = await db.query<{ title: string; entity_type: string; entity_id: string }>(
      `SELECT title, entity_type, entity_id
       FROM notifications
       WHERE user_id = $1 AND entity_id = $2`,
      [inq?.assigned_user_id, inq?.lead_id],
    );
    expect(notifRow.rows.length).toBe(1);
    expect(notifRow.rows[0]?.entity_type).toBe('lead');

    // Honeypot bot gets identical 202 {"status":"received"} and writes no lead or inquiry
    const botRes = await fetch(`${baseUrl}/api/v1/public/inquiries`, {
      method: 'POST',
      headers: {
        Host: 'go.adasglobuspro.com',
        'Content-Type': 'application/json',
        'Cf-Connecting-Ip': '198.51.100.25',
      },
      body: JSON.stringify({
        name: 'Spam Bot',
        email: 'bot.probe@spammer.example.org',
        location: 'Texas',
        website: 'https://buy-spam-links.example.org',
      }),
    });
    expect(botRes.status).toBe(202);
    expect(await botRes.json()).toEqual({ status: 'received' });

    const botLead = await db.query(
      `SELECT id FROM leads WHERE email = 'bot.probe@spammer.example.org'`,
    );
    expect(botLead.rows.length).toBe(0);
  });

  it('deduplicates same-day (email, form, day) even after lead disqualification, and links free-mail + firm without setting a free-mail domain (PRD 4.3, 4.10, A4)', async () => {
    // 1. Free-mail visitor WITH a firm name creates/links a company whose domain remains NULL
    const first = await appRef.services.intake.handlePublicInquiry({
      name: 'Nolan Harper',
      email: 'nolan.harper.cpa@gmail.com',
      firm: 'Harper Tax Boutique LLP',
      country: 'Canada',
      need: 'Bookkeeping and payroll',
    } as never);
    expect(first.deduplicated).toBe(false);
    expect(first.companyId).toMatch(/^cmp_/);

    const cmpRow = await db.query<{ name: string; domain: string | null; website: string | null }>(
      `SELECT name, domain, website FROM companies WHERE id = $1`,
      [first.companyId],
    );
    expect(cmpRow.rows[0]).toEqual({
      name: 'Harper Tax Boutique LLP',
      domain: null,
      website: null,
    });

    // Disqualify the lead so status_category becomes 'closed', then resubmit same form same day:
    // dedup_key on (email, form, day) still prevents creating a duplicate lead today!
    await db.query(
      `UPDATE leads SET status = 'Disqualified', status_category = 'closed', disqualification_reason = 'Test' WHERE id = $1`,
      [first.leadId],
    );

    const repeatSameDay = await appRef.services.intake.handlePublicInquiry({
      name: 'Nolan Harper',
      email: 'NOLAN.HARPER.CPA@gmail.com',
      firm: 'Harper Tax Boutique LLP',
      country: 'Canada',
      need: 'Bookkeeping and payroll',
    } as never);
    expect(repeatSameDay.deduplicated).toBe(true);
    expect(repeatSameDay.leadId).toBe(first.leadId);

    const leadCount = await db.query<{ cnt: number }>(
      `SELECT COUNT(*)::int AS cnt FROM leads WHERE email = 'nolan.harper.cpa@gmail.com'`,
    );
    expect(leadCount.rows[0]?.cnt).toBe(1);
  });

  it('enforces the per-IP rate limit (5 requests per 10 minutes -> 429 with Retry-After) while isolating other IPs (PRD 4.10, 9)', async () => {
    const burstIp = '203.0.113.77';
    for (let i = 1; i <= 5; i += 1) {
      const ok = await fetch(`${baseUrl}/api/v1/public/inquiries`, {
        method: 'POST',
        headers: {
          Host: 'go.adasglobuspro.com',
          'Content-Type': 'application/json',
          'Cf-Connecting-Ip': burstIp,
        },
        body: JSON.stringify({
          name: `Burst Visitor ${i}`,
          email: `burst.${i}@burstfirm-${i}.example.com`,
          firm: `Burst Firm ${i} CPA`,
          country: 'US',
          need: 'Tax preparation',
        }),
      });
      expect(ok.status).toBe(202);
    }

    const sixth = await fetch(`${baseUrl}/api/v1/public/inquiries`, {
      method: 'POST',
      headers: {
        Host: 'go.adasglobuspro.com',
        'Content-Type': 'application/json',
        'Cf-Connecting-Ip': burstIp,
      },
      body: JSON.stringify({
        name: 'Burst Visitor 6',
        email: 'burst.6@burstfirm-6.example.com',
        firm: 'Burst Firm 6 CPA',
        country: 'US',
        need: 'Tax preparation',
      }),
    });
    expect(sixth.status).toBe(429);
    expect(sixth.headers.get('retry-after')).toBe('600');
    const problem = (await sixth.json()) as { code: string };
    expect(problem.code).toBe('RATE_LIMITED');

    // A separate visitor IP is unaffected
    const otherIp = await fetch(`${baseUrl}/api/v1/public/inquiries`, {
      method: 'POST',
      headers: {
        Host: 'go.adasglobuspro.com',
        'Content-Type': 'application/json',
        'Cf-Connecting-Ip': '203.0.113.78',
      },
      body: JSON.stringify({
        name: 'Clean Visitor',
        email: 'clean.visitor@cleanfirm.example.com',
        firm: 'Clean Firm CPA',
        country: 'US',
        need: 'Audit support',
      }),
    });
    expect(otherIp.status).toBe(202);
  });

  it('persists round-robin state across service instances, enforces settings.manage + version + audit on routing rules, and excludes read-only analysts (PRD 4.17, 15 Q13)', async () => {
    // Non-admins cannot read or edit routing rules
    expect((await apiCall(managerCookie, 'GET', '/api/v1/admin/routing-rules')).status).toBe(403);
    expect((await apiCall(bdrCookie, 'GET', '/api/v1/admin/inquiries')).status).toBe(403);

    const listRes = await apiCall(adminCookie, 'GET', '/api/v1/admin/routing-rules');
    expect(listRes.status).toBe(200);
    const listed = (await listRes.json()) as {
      items: Array<{ market: string; mode: string; version: number; eligibleMemberCount: number }>;
    };
    const usRule = listed.items.find((r) => r.market === 'US');
    const caRule = listed.items.find((r) => r.market === 'CA');
    expect(usRule?.mode).toBe('round_robin');
    // team_us has 6 active users, 1 of whom is usr_ro_1 (Read-Only / Analyst) -> 5 eligible writers!
    expect(usRule?.eligibleMemberCount).toBe(5);

    // Two separate WebsiteIntakeService instances (simulating API restart) advance the DB cursor
    const instanceA = new WebsiteIntakeService(db);
    const instanceB = new WebsiteIntakeService(db);
    const assignedIds: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const svc = i % 2 === 0 ? instanceA : instanceB;
      const r = await svc.handlePublicInquiry({
        name: `Rotation Partner ${i}`,
        email: `rot.${i}@rotationfirm-${i}.example.com`,
        firm: `Rotation Firm ${i}`,
        country: 'US',
        formType: 'trial',
      });
      assignedIds.push(String(r.assignedUserId));
    }
    // Never assigns to read-only analyst usr_ro_1, and rotates across multiple distinct reps
    expect(assignedIds).not.toContain('usr_ro_1');
    expect(new Set(assignedIds).size).toBe(5);

    // Reject assigning a Read-Only / Analyst as named_owner
    const badOwner = await apiCall(adminCookie, 'PUT', '/api/v1/admin/routing-rules/CA', {
      version: caRule?.version ?? 1,
      mode: 'named_owner',
      ownerUserId: 'usr_ro_1',
    });
    expect(badOwner.status).toBe(422);

    // Switch CA to named_owner = usr_ae_1
    const updatedRes = await apiCall(adminCookie, 'PUT', '/api/v1/admin/routing-rules/CA', {
      version: caRule?.version ?? 1,
      mode: 'named_owner',
      ownerUserId: 'usr_ae_1',
    });
    expect(updatedRes.status).toBe(200);
    const updated = (await updatedRes.json()) as {
      mode: string;
      ownerUserId: string;
      version: number;
    };
    expect(updated).toMatchObject({
      mode: 'named_owner',
      ownerUserId: 'usr_ae_1',
      version: (caRule?.version ?? 1) + 1,
    });

    // Stale version fails with 409
    const staleRes = await apiCall(adminCookie, 'PUT', '/api/v1/admin/routing-rules/CA', {
      version: caRule?.version ?? 1,
      mode: 'round_robin',
      teamId: 'team_ca',
    });
    expect(staleRes.status).toBe(409);

    // Subsequent CA inquiries all route to usr_ae_1
    const caInq = await instanceA.handlePublicInquiry({
      name: 'Chloe Tremblay',
      email: 'chloe@tremblay-cpa.example.ca',
      firm: 'Tremblay CPA Inc',
      country: 'Canada',
      formType: 'trial',
    });
    expect(caInq.assignedUserId).toBe('usr_ae_1');

    // Audit log written
    const audit = await db.query<{ action: string }>(
      `SELECT action FROM audit_logs WHERE action = 'routing_rule.updated' AND entity_id = 'CA'`,
    );
    expect(audit.rows.length).toBeGreaterThanOrEqual(1);

    // Restore CA to round_robin on team_ca
    const restoreRes = await apiCall(adminCookie, 'PUT', '/api/v1/admin/routing-rules/CA', {
      version: updated.version,
      mode: 'round_robin',
      teamId: 'team_ca',
    });
    expect(restoreRes.status).toBe(200);
  });

  it('A12: stores unsubscribe tokens hashed only, keeps GET /u/:token scanner-safe, and suppresses + stops sequences on POST /u/:token (PRD 5.5, 8.6)', async () => {
    const admin = await appRef.services.auth.resolveSessionUser('usr_admin_1');
    const created = await appRef.services.crm.createContact(admin, {
      firstName: 'Grant',
      lastName: 'Holloway',
      primaryEmail: 'grant.holloway@hollowaytax.example.com',
      title: 'Managing Partner',
      market: 'US',
    } as never);
    const contactId = String(created['id']);

    // Enrol in an active sequence
    await db.query(
      `INSERT INTO sequence_enrollments (id, sequence_id, contact_id, email, sender_user_id, status)
       VALUES ('enr_m4_test', 'seq_us_cpa_trial', $1, 'grant.holloway@hollowaytax.example.com', 'usr_mgr_1', 'active')`,
      [contactId],
    );

    const rawToken = await appRef.services.compliance.createUnsubscribeToken({
      email: 'grant.holloway@hollowaytax.example.com',
      contactId,
      channel: 'sequence',
    });
    expect(rawToken).toMatch(/^unsub_[a-f0-9]{48}$/);

    // Database NEVER stores the raw token string, only its SHA-256 digest
    const dbTokenRow = await db.query<{ token: string; token_sha256: string | null }>(
      `SELECT token, token_sha256 FROM unsubscribe_tokens WHERE contact_id = $1`,
      [contactId],
    );
    expect(dbTokenRow.rows[0]?.token).not.toBe(rawToken);
    expect(dbTokenRow.rows[0]?.token_sha256).toBe(sha256Hex(rawToken));

    // Scanner-safe GET /u/:token on go.adasglobuspro.com shows confirmation without unsubscribing
    const getRes = await fetch(`${baseUrl}/u/${encodeURIComponent(rawToken)}`, {
      headers: { Host: 'go.adasglobuspro.com' },
    });
    expect(getRes.status).toBe(200);
    const getHtml = await getRes.text();
    expect(getHtml).toContain('Unsubscribe from');
    expect(getHtml).toContain('g*************@hollowaytax.example.com');

    const stillSendable = await appRef.services.compliance.evaluateRecipientSendability({
      email: 'grant.holloway@hollowaytax.example.com',
      channel: 'sequence',
      bypassSendWindow: true,
    });
    expect(stillSendable.sendable).toBe(true);

    // One-click POST /u/:token immediately adds suppression and stops active sequence enrollment
    const postRes = await fetch(`${baseUrl}/u/${encodeURIComponent(rawToken)}`, {
      method: 'POST',
      headers: {
        Host: 'go.adasglobuspro.com',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'List-Unsubscribe=One-Click',
    });
    expect(postRes.status).toBe(200);
    expect(await postRes.text()).toContain("You're <strong>unsubscribed</strong>");

    const afterUnsub = await appRef.services.compliance.evaluateRecipientSendability({
      email: 'grant.holloway@hollowaytax.example.com',
      channel: 'sequence',
      bypassSendWindow: true,
    });
    expect(afterUnsub.sendable).toBe(false);
    expect(afterUnsub.reasonCode).toBe('SUPPRESSED_EMAIL');

    const enrRow = await db.query<{ status: string }>(
      `SELECT status FROM sequence_enrollments WHERE id = 'enr_m4_test'`,
    );
    expect(enrRow.rows[0]?.status).toBe('unsubscribed');
  });

  it('scrubs inquiries on privacy erasure, drops re-inquiries from erased hashes, and purges expired rate events & 24-month inquiries (PRD 4.18)', async () => {
    const inq = await appRef.services.intake.handlePublicInquiry({
      name: 'Sylvie Gagnon',
      email: 'sylvie.gagnon@gagnontax.example.ca',
      firm: 'Gagnon Tax CPA',
      country: 'Canada',
      message: 'Please call my direct line',
    } as never);
    expect(inq.contactId).toMatch(/^cnt_/);

    // Export includes the inquiry before erasure
    const exportedRes = await apiCall(
      adminCookie,
      'GET',
      `/api/v1/contacts/${String(inq.contactId)}/privacy-export`,
    );
    expect(exportedRes.status).toBe(200);
    const exported = (await exportedRes.json()) as { inquiries: Array<{ id: string }> };
    expect(exported.inquiries.some((r) => r.id === inq.inquiryId)).toBe(true);

    // Erase the contact
    const eraseRes = await apiCall(
      adminCookie,
      'POST',
      `/api/v1/contacts/${String(inq.contactId)}/privacy-erase`,
      { reason: 'Verified privacy erasure request from Sylvie Gagnon' },
    );
    expect(eraseRes.status).toBe(200);

    // Inquiry row stays for count accuracy, but raw_payload, page_url and user_agent are scrubbed
    const scrubbedInq = await db.query<{
      raw_payload: Record<string, unknown>;
      page_url: string | null;
      user_agent: string | null;
    }>(`SELECT raw_payload, page_url, user_agent FROM inquiries WHERE id = $1`, [inq.inquiryId]);
    expect(scrubbedInq.rows[0]).toEqual({
      raw_payload: {},
      page_url: null,
      user_agent: null,
    });

    // Submitting the public form again with the erased address does NOT re-create PII records
    const reSubmit = await appRef.services.intake.handlePublicInquiry({
      name: 'Sylvie Gagnon',
      email: 'sylvie.gagnon@gagnontax.example.ca',
      firm: 'Gagnon Tax CPA',
      country: 'Canada',
    } as never);
    expect(reSubmit.leadId).toBeNull();
    expect(reSubmit.contactId).toBeNull();

    // Housekeeping purges rate events > 1 hour and inquiries > 24 months while keeping fresh ones
    await db.query(
      `INSERT INTO public_rate_events (id, endpoint, ip_sha256, created_at)
       VALUES ('pre_old_test', 'public_inquiries', $1, NOW() - INTERVAL '2 hours')`,
      [sha256Hex('old-ip')],
    );
    await db.query(
      `INSERT INTO inquiries (id, dedup_key, form_type, market, email_sha256, created_at)
       VALUES ('inq_old_25m', 'dedup_old', 'trial', 'US', $1, NOW() - INTERVAL '25 months')`,
      [sha256Hex('ancient@example.com')],
    );

    const purged = await purgeExpired(db);
    expect(purged.rateEvents).toBeGreaterThanOrEqual(1);
    expect(purged.inquiries).toBeGreaterThanOrEqual(1);

    const remainingRecent = await db.query(`SELECT id FROM inquiries WHERE id = $1`, [
      inq.inquiryId,
    ]);
    expect(remainingRecent.rows.length).toBe(1);
  });
});
