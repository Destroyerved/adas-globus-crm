import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAppServer } from '../main.js';
import { buildWorker } from '../jobs.js';
import { ApolloClient } from '../platform/apollo/index.js';
import { validateEnv } from '../platform/config/index.js';
import { SecretBox } from '../platform/crypto/index.js';
import { DatabaseService } from '../platform/db/index.js';
import { LocalFileStorage } from '../platform/files/index.js';
import { createLogger } from '../platform/logger/index.js';
import {
  signAdasWebhookPayload,
  verifyTimestampedHmacSignature,
} from '../platform/webhooks/index.js';
import { ComplianceService } from '../modules/compliance/index.js';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

describe('Milestone 7: Apollo search/import/enrichment, encrypted outbound webhooks HTTP worker & signed Microsoft Bookings (PRD 4.14, 4.17, 5, 6.5, 9)', () => {
  let db: DatabaseService;
  let apiServer: Server;
  let apiBaseUrl = '';
  let apolloServer: Server;
  let apolloBaseUrl = '';
  let receiverServer: Server;
  let receiverUrl = '';

  let apolloMatchCalls = 0;
  let receiverShouldFailNext = false;
  const receivedDeliveries: Array<{
    event: string;
    signature: string;
    timestamp: string;
    body: string;
  }> = [];

  const secretBox = SecretBox.ephemeral();
  const apolloApiKey = 'apollo_live_test_key_2026_valid';
  const bookingsSecret = 'bksec_test_microsoft_bookings_hmac_2026';

  beforeAll(async () => {
    db = DatabaseService.forTests();
    await db.ensureInitialized();

    // 1. Local HTTP server speaking Apollo REST v1 (/v1/mixed_people/search, /v1/people/match)
    apolloServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.headers['x-api-key'] !== apolloApiKey) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_api_key' }));
        return;
      }
      const raw = await readBody(req);
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};

      if (req.method === 'POST' && req.url === '/v1/mixed_people/search') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            pagination: { page: 1, per_page: 25, total_entries: 3 },
            people: [
              {
                id: 'apollo_us_partner_1',
                first_name: 'Hannah',
                last_name: 'Caldwell',
                title: 'Managing Tax Partner',
                email: 'email_not_unlocked@domain.com',
                email_status: 'verified',
                country: 'United States',
                state: 'TX',
                organization: {
                  id: 'apollo_org_caldwell',
                  name: 'Caldwell & Associates CPA',
                  primary_domain: 'caldwellcpa.example.com',
                  estimated_num_employees: 38,
                },
              },
              {
                id: 'apollo_ca_partner_1',
                first_name: 'Liam',
                last_name: 'Bouchard',
                title: 'Assurance Partner',
                email: 'email_not_unlocked@domain.com',
                email_status: 'verified',
                country: 'Canada',
                state: 'ON',
                organization: {
                  id: 'apollo_org_bouchard',
                  name: 'Bouchard Chartered Accountants',
                  primary_domain: 'bouchardcpa.example.ca',
                  estimated_num_employees: 24,
                },
              },
              {
                id: 'apollo_suppressed_1',
                first_name: 'Blocked',
                last_name: 'Prospect',
                title: 'Partner',
                email: 'blocked.partner@suppressedfirm.example.com',
                email_status: 'verified',
                country: 'United States',
                state: 'IL',
                organization: {
                  id: 'apollo_org_sup',
                  name: 'Suppressed Firm CPA',
                  primary_domain: 'suppressedfirm.example.com',
                  estimated_num_employees: 15,
                },
              },
            ],
          }),
        );
        return;
      }

      if (req.method === 'POST' && req.url === '/v1/people/match') {
        apolloMatchCalls += 1;
        const pid = String(body['id'] ?? '');
        const email = String(body['email'] ?? '');
        if (pid === 'apollo_us_partner_1') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              person: {
                id: 'apollo_us_partner_1',
                first_name: 'Hannah',
                last_name: 'Caldwell',
                email: 'hannah@caldwellcpa.example.com',
                email_status: 'verified',
                title: 'Managing Tax Partner',
                organization: {
                  id: 'apollo_org_caldwell',
                  name: 'Caldwell & Associates CPA',
                  primary_domain: 'caldwellcpa.example.com',
                  estimated_num_employees: 38,
                },
              },
            }),
          );
          return;
        }
        if (pid === 'apollo_ca_partner_1') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              person: {
                id: 'apollo_ca_partner_1',
                first_name: 'Liam',
                last_name: 'Bouchard',
                email: 'liam@bouchardcpa.example.ca',
                email_status: 'verified',
                title: 'Assurance Partner',
                organization: {
                  id: 'apollo_org_bouchard',
                  name: 'Bouchard Chartered Accountants',
                  primary_domain: 'bouchardcpa.example.ca',
                  estimated_num_employees: 24,
                },
              },
            }),
          );
          return;
        }
        if (email === 'dchen@clearwaterllp.example.com') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              person: {
                id: 'apollo_david_enriched',
                first_name: 'David',
                last_name: 'Chen',
                email: 'dchen@clearwaterllp.example.com',
                email_status: 'verified',
                title: 'Executive Tax Partner',
                organization: {
                  id: 'apollo_org_clearwater',
                  name: 'Clearwater Accounting LLP',
                  primary_domain: 'clearwaterllp.example.com',
                  estimated_num_employees: 18,
                },
              },
            }),
          );
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ person: null }));
        return;
      }

      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => apolloServer.listen(0, '127.0.0.1', resolve));
    const apolloPort = (apolloServer.address() as AddressInfo).port;
    apolloBaseUrl = `http://127.0.0.1:${apolloPort}`;

    // 2. Local outbound webhook receiver (n8n stand-in)
    receiverServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const body = await readBody(req);
      if (receiverShouldFailNext) {
        receiverShouldFailNext = false;
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'downstream_busy' }));
        return;
      }
      receivedDeliveries.push({
        event: String(req.headers['x-adas-event'] ?? ''),
        signature: String(req.headers['x-adas-signature'] ?? ''),
        timestamp: String(req.headers['x-adas-timestamp'] ?? ''),
        body,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ received: true }));
    });
    await new Promise<void>((resolve) => receiverServer.listen(0, '127.0.0.1', resolve));
    const receiverPort = (receiverServer.address() as AddressInfo).port;
    receiverUrl = `http://127.0.0.1:${receiverPort}/webhook/n8n`;

    // 3. Real CRM API HTTP server
    const env = validateEnv({
      NODE_ENV: 'test',
      PUBLIC_WEB_URL: 'http://localhost:5174',
      APOLLO_API_BASE_URL: apolloBaseUrl,
      WEBHOOK_ALLOW_PRIVATE_TARGETS: 'true',
    });
    const app = createAppServer(env, db, {
      secretBox,
      apolloClient: new ApolloClient({
        apiBaseUrl: apolloBaseUrl,
        apiKey: apolloApiKey,
      }),
      bookingsWebhookSecret: bookingsSecret,
    });
    apiServer = app.server;
    await new Promise<void>((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
    const apiPort = (apiServer.address() as AddressInfo).port;
    apiBaseUrl = `http://127.0.0.1:${apiPort}`;
  });

  afterAll(async () => {
    if (apiServer) await new Promise<void>((resolve) => apiServer.close(() => resolve()));
    if (apolloServer) await new Promise<void>((resolve) => apolloServer.close(() => resolve()));
    if (receiverServer) await new Promise<void>((resolve) => receiverServer.close(() => resolve()));
    await db?.close();
  });

  async function loginCookie(userId: string): Promise<string> {
    const res = await fetch(`${apiBaseUrl}/api/v1/auth/dev-login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:5174',
        Host: 'crm.adasglobuspro.com',
      },
      body: JSON.stringify({ userId }),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    return setCookie.split(';')[0] ?? '';
  }

  it('searches Apollo over HTTP, requires upfront credit confirmation, skips suppressed addresses, deduplicates external_ids, and grants zero consent', async () => {
    const adminCookie = await loginCookie('usr_admin_1');
    const caBdrCookie = await loginCookie('usr_bdr_1');

    // Suppress blocked.partner@suppressedfirm.example.com before searching
    const supRes = await fetch(`${apiBaseUrl}/api/v1/compliance/suppressions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:5174',
        Cookie: adminCookie,
      },
      body: JSON.stringify({
        email: 'blocked.partner@suppressedfirm.example.com',
        reason: 'manual_dnc',
        source: 'Pre-import DNC block',
      }),
    });
    expect(supRes.status).toBe(201);

    // Search Apollo via real HTTP connector
    const searchRes = await fetch(`${apiBaseUrl}/api/v1/apollo/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:5174',
        Cookie: adminCookie,
      },
      body: JSON.stringify({
        qKeywords: 'Tax Partner',
        market: 'US',
      }),
    });
    expect(searchRes.status).toBe(200);
    const searchJson = (await searchRes.json()) as {
      items: Array<{
        apolloPersonId: string;
        suppressed: boolean;
        alreadyInCrm: boolean;
        estimatedCreditCost: number;
      }>;
    };
    expect(searchJson.items).toHaveLength(3);
    const blockedItem = searchJson.items.find((i) => i.apolloPersonId === 'apollo_suppressed_1');
    expect(blockedItem?.suppressed).toBe(true);
    expect(blockedItem?.estimatedCreditCost).toBe(0);

    // Attempting import WITHOUT confirming credits is rejected before calling /v1/people/match
    const callsBefore = apolloMatchCalls;
    const unconfirmedRes = await fetch(`${apiBaseUrl}/api/v1/apollo/import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:5174',
        Cookie: adminCookie,
      },
      body: JSON.stringify({
        confirmedCreditCost: 0,
        candidates: [
          {
            apolloPersonId: 'apollo_us_partner_1',
            apolloOrgId: 'apollo_org_caldwell',
            firstName: 'Hannah',
            lastName: 'Caldwell',
            title: 'Managing Tax Partner',
            firmName: 'Caldwell & Associates CPA',
            domain: 'caldwellcpa.example.com',
            market: 'US',
          },
        ],
      }),
    });
    expect(unconfirmedRes.status).toBe(422);
    const unconfirmedProblem = (await unconfirmedRes.json()) as { code: string };
    expect(unconfirmedProblem.code).toBe('APOLLO_CREDIT_CONFIRMATION_REQUIRED');
    expect(apolloMatchCalls).toBe(callsBefore);

    // Confirmed import of US + CA + Suppressed prospects:
    // - US + CA unlock via /v1/people/match (2 credits)
    // - Suppressed prospect is skipped (0 credits, never created)
    const importRes = await fetch(`${apiBaseUrl}/api/v1/apollo/import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:5174',
        Cookie: adminCookie,
      },
      body: JSON.stringify({
        confirmedCreditCost: 2,
        candidates: [
          {
            apolloPersonId: 'apollo_us_partner_1',
            apolloOrgId: 'apollo_org_caldwell',
            firstName: 'Hannah',
            lastName: 'Caldwell',
            title: 'Managing Tax Partner',
            firmName: 'Caldwell & Associates CPA',
            domain: 'caldwellcpa.example.com',
            market: 'US',
          },
          {
            apolloPersonId: 'apollo_ca_partner_1',
            apolloOrgId: 'apollo_org_bouchard',
            firstName: 'Liam',
            lastName: 'Bouchard',
            title: 'Assurance Partner',
            firmName: 'Bouchard Chartered Accountants',
            domain: 'bouchardcpa.example.ca',
            market: 'CA',
          },
          {
            apolloPersonId: 'apollo_suppressed_1',
            apolloOrgId: 'apollo_org_sup',
            firstName: 'Blocked',
            lastName: 'Prospect',
            email: 'blocked.partner@suppressedfirm.example.com',
            title: 'Partner',
            firmName: 'Suppressed Firm CPA',
            domain: 'suppressedfirm.example.com',
            market: 'US',
          },
        ],
      }),
    });
    expect(importRes.status).toBe(201);
    const importJson = (await importRes.json()) as {
      createdCount: number;
      skippedSuppressedCount: number;
      creditsConsumed: number;
    };
    expect(importJson.createdCount).toBe(2);
    expect(importJson.skippedSuppressedCount).toBe(1);
    expect(importJson.creditsConsumed).toBe(2);

    // Verify external_ids rows exist for both contacts and companies
    const extRows = await db.query<{ entity_type: string; external_id: string }>(
      `SELECT entity_type, external_id FROM external_ids WHERE provider = 'apollo' ORDER BY external_id`,
    );
    expect(extRows.rows.map((r) => r.external_id)).toEqual(
      expect.arrayContaining([
        'apollo_ca_partner_1',
        'apollo_org_bouchard',
        'apollo_org_caldwell',
        'apollo_us_partner_1',
      ]),
    );

    // Verify Canadian Apollo contact has ZERO consent and cannot be mailed under CASL (PRD 5)
    const compliance = new ComplianceService(db);
    const caSendCheck = await compliance.evaluateRecipientSendability({
      email: 'liam@bouchardcpa.example.ca',
      channel: 'sequence',
      senderUserId: 'usr_mgr_1',
      bypassSendWindow: true,
    });
    expect(caSendCheck.sendable).toBe(false);
    expect(caSendCheck.reasonCode).toBe('NO_LAWFUL_BASIS');

    // Re-importing the same Apollo ID deduplicates with 0 credits consumed
    const dedupRes = await fetch(`${apiBaseUrl}/api/v1/apollo/import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:5174',
        Cookie: adminCookie,
      },
      body: JSON.stringify({
        confirmedCreditCost: 0,
        candidates: [
          {
            apolloPersonId: 'apollo_us_partner_1',
            firstName: 'Hannah',
            lastName: 'Caldwell',
            title: 'Managing Tax Partner',
            firmName: 'Caldwell & Associates CPA',
            domain: 'caldwellcpa.example.com',
            market: 'US',
          },
        ],
      }),
    });
    expect(dedupRes.status).toBe(201);
    const dedupJson = (await dedupRes.json()) as {
      createdCount: number;
      deduplicatedCount: number;
      creditsConsumed: number;
    };
    expect(dedupJson.createdCount).toBe(0);
    expect(dedupJson.deduplicatedCount).toBe(1);
    expect(dedupJson.creditsConsumed).toBe(0);

    // Single-contact enrichment enforces SQL scope (CA BDR cannot enrich US contact cnt_david -> 404)
    const forbiddenEnrich = await fetch(`${apiBaseUrl}/api/v1/contacts/cnt_david/enrich-apollo`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:5174',
        Cookie: caBdrCookie,
      },
      body: JSON.stringify({ confirmedCreditCost: 1 }),
    });
    expect(forbiddenEnrich.status).toBe(404);

    // Clear title on cnt_david and enrich as Admin -> updates blank title & logs record_history via='apollo'
    await db.query(`UPDATE contacts SET title = '' WHERE id = 'cnt_david'`);
    const okEnrich = await fetch(`${apiBaseUrl}/api/v1/contacts/cnt_david/enrich-apollo`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:5174',
        Cookie: adminCookie,
      },
      body: JSON.stringify({ confirmedCreditCost: 1 }),
    });
    expect(okEnrich.status).toBe(200);
    const enrichJson = (await okEnrich.json()) as { enriched: boolean; updatedFields: string[] };
    expect(enrichJson.enriched).toBe(true);
    expect(enrichJson.updatedFields).toContain('title');
  });

  it('encrypts outbound webhook secrets with SecretBox, retries 5xx with backoff, delivers signed X-ADAS-Signature payloads, and processes signed Microsoft Bookings webhooks stopping sequences', async () => {
    const adminCookie = await loginCookie('usr_admin_1');
    const mgrCookie = await loginCookie('usr_mgr_1');

    // Disable seeded localhost:5678 endpoint so worker tests hit our live local receiver cleanly
    await db.query(`UPDATE webhook_endpoints SET active = FALSE WHERE id = 'wh_n8n_deal_won'`);

    // 1. Create an encrypted outbound webhook endpoint via API
    const createWhRes = await fetch(`${apiBaseUrl}/api/v1/admin/webhooks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:5174',
        Cookie: adminCookie,
      },
      body: JSON.stringify({
        name: 'Local n8n Deal & Bookings Listener',
        targetUrl: receiverUrl,
        eventTypes: ['deal.won', 'activity.logged'],
      }),
    });
    expect(createWhRes.status).toBe(201);
    const createdWh = (await createWhRes.json()) as {
      endpoint: { id: string; secret_hint: string };
      signingSecret: string;
    };
    expect(createdWh.signingSecret).toMatch(/^whsec_/);

    // Verify secret is sealed in secret_ciphertext and NOT stored in plaintext secret_hmac
    const rawEp = await db.query<{ secret_hmac: string; secret_ciphertext: string | null }>(
      `SELECT secret_hmac, secret_ciphertext FROM webhook_endpoints WHERE id = $1`,
      [createdWh.endpoint.id],
    );
    expect(rawEp.rows[0]?.secret_hmac).toBe('');
    expect(rawEp.rows[0]?.secret_ciphertext).toMatch(/^v1\.1\./);

    // 2. Enroll cnt_elena in seq_us_cpa_trial so we can prove Microsoft Bookings stops her sequence
    const enrollRes = await fetch(`${apiBaseUrl}/api/v1/sequences/seq_us_cpa_trial/enroll`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:5174',
        Cookie: mgrCookie,
      },
      body: JSON.stringify({ contactIds: ['cnt_elena'] }),
    });
    expect(enrollRes.status).toBe(201);

    // 3. Reject replayed (>5 min) Microsoft Bookings webhook on `go.` host
    const bookingsPayload = JSON.stringify({
      appointmentId: 'bk_appt_elena_001',
      eventType: 'created',
      customerEmail: 'elena@ridgewaycpa.example.com',
      customerName: 'Elena Rostova',
      serviceName: '3-Day CPA Pod Scoping Call',
      startTimeIso: '2026-11-25T15:00:00.000Z',
    });
    const staleSig = signAdasWebhookPayload(
      bookingsPayload,
      bookingsSecret,
      Math.floor(Date.now() / 1000) - 600,
    );
    const staleRes = await fetch(`${apiBaseUrl}/api/v1/webhooks/bookings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Host: 'go.adasglobuspro.com',
        'X-Bookings-Signature': staleSig.signatureHeader,
      },
      body: bookingsPayload,
    });
    expect(staleRes.status).toBe(401);

    // 4. Accept valid signed Microsoft Bookings webhook on `go.` and deduplicate retries
    const freshSig = signAdasWebhookPayload(bookingsPayload, bookingsSecret);
    const okBookingsRes = await fetch(`${apiBaseUrl}/api/v1/webhooks/bookings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Host: 'go.adasglobuspro.com',
        'X-Bookings-Signature': freshSig.signatureHeader,
      },
      body: bookingsPayload,
    });
    expect(okBookingsRes.status).toBe(202);
    const okBookingsJson = (await okBookingsRes.json()) as {
      duplicate: boolean;
      contactId: string;
      taskId: string;
    };
    expect(okBookingsJson.duplicate).toBe(false);
    expect(okBookingsJson.contactId).toBe('cnt_elena');
    expect(okBookingsJson.taskId).toMatch(/^tsk_bk_/);

    const dupBookingsRes = await fetch(`${apiBaseUrl}/api/v1/webhooks/bookings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Host: 'go.adasglobuspro.com',
        'X-Bookings-Signature': freshSig.signatureHeader,
      },
      body: bookingsPayload,
    });
    expect(dupBookingsRes.status).toBe(202);
    expect(((await dupBookingsRes.json()) as { duplicate: boolean }).duplicate).toBe(true);

    // 5. Run outbox.dispatch -> stops cnt_elena's sequence AND queues outbound webhook delivery
    const worker = buildWorker(db, createLogger('silent'), {
      files: new LocalFileStorage('./data/files'),
      secretBox,
    });
    await worker.outbox.dispatch();

    const enrAfter = await db.query<{ status: string }>(
      `SELECT status FROM sequence_enrollments WHERE contact_id = 'cnt_elena' AND sequence_id = 'seq_us_cpa_trial'`,
    );
    expect(enrAfter.rows[0]?.status).toBe('stopped_meeting');

    // First delivery attempt hits HTTP 503 -> status becomes 'retrying' with backoff
    receiverShouldFailNext = true;
    const firstAttempt = await worker.intelligence.deliverDueWebhooks();
    expect(firstAttempt.retrying).toBeGreaterThanOrEqual(1);

    // Fast-forward available_at and deliver -> HTTP 200 with valid X-ADAS-Signature!
    await db.query(
      `UPDATE webhook_deliveries SET available_at = NOW() - INTERVAL '1 second' WHERE endpoint_id = $1`,
      [createdWh.endpoint.id],
    );
    const secondAttempt = await worker.intelligence.deliverDueWebhooks();
    expect(secondAttempt.delivered).toBeGreaterThanOrEqual(1);
    expect(receivedDeliveries.length).toBeGreaterThanOrEqual(1);

    const lastReceived = receivedDeliveries[receivedDeliveries.length - 1];
    expect(lastReceived).toBeDefined();
    expect(lastReceived?.event).toBe('activity.logged');
    const sigVerify = verifyTimestampedHmacSignature({
      rawBody: lastReceived?.body ?? '',
      signatureHeader: lastReceived?.signature,
      secret: createdWh.signingSecret,
    });
    expect(sigVerify).toEqual({ ok: true });

    // Also verify live admin "Send test" endpoint
    const testPingRes = await fetch(
      `${apiBaseUrl}/api/v1/admin/webhooks/${createdWh.endpoint.id}/test`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'http://localhost:5174',
          Cookie: adminCookie,
        },
        body: '{}',
      },
    );
    expect(testPingRes.status).toBe(200);
    const testPingJson = (await testPingRes.json()) as { status: string; last_status_code: number };
    expect(testPingJson.status).toBe('delivered');
    expect(testPingJson.last_status_code).toBe(200);
  });
});
