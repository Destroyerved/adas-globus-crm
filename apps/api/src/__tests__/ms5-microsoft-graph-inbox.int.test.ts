import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAppServer } from '../main.js';
import { validateEnv } from '../platform/config/index.js';
import { SecretBox } from '../platform/crypto/index.js';
import { DatabaseService } from '../platform/db/index.js';

/**
 * Milestone 5 Integration Suite (PRD 4.11, 8.2, 8.3, 8.7, 9, 12.1 A10 & A11):
 * - Delegated Microsoft 365 OAuth2 + PKCE connect, AES-256-GCM SecretBox token storage & rotation
 * - Public Graph webhook handshake (`?validationToken=`) & constant-time `clientState` check on `go.`
 * - 90-day initial + delta sync obeying strict CRM contact & non-free-mail company-domain sync rule
 * - HTML sanitisation + remote image blocking, attachment metadata + on-demand Graph streaming
 * - Inbound reply stopping active sequence enrollments + follow-up task (A11) & DSN 5.x.x hard bounces
 * - `own` / `team` / `all` scope enforcement, 1:1 send/reply with template rendering & Idempotency-Key (A10),
 *   deal linking, task-from-email, `429 Retry-After` backoff, and sequence pause on mailbox disconnect
 */

const WEB_ORIGIN = 'http://localhost:5174';
const TENANT_ID = '11111111-2222-3333-4444-555555555555';
const CLIENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

interface MockGraphState {
  lastClientState: string;
  throttleNextDelta: boolean;
  inboxMessages: Record<string, unknown>[];
  sentMessages: Record<string, unknown>[];
  deletedSubscriptions: string[];
  renewedSubscriptions: string[];
  attachmentDownloads: number;
}

async function readBodyText(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) {
    chunks.push(typeof c === 'string' ? Buffer.from(c) : (c as Buffer));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function signIn(url: string, userId: string): Promise<string> {
  const res = await fetch(`${url}/api/v1/auth/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: WEB_ORIGIN },
    body: JSON.stringify({ userId }),
  });
  expect(res.status).toBe(200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

describe('Milestone 5: Microsoft 365 Graph Inbox, sync rules, webhooks & 1:1 threads', () => {
  let db: DatabaseService;
  let baseUrl = '';
  let graphServerUrl = '';
  let tempDir = '';
  let secretBox: SecretBox;
  let closeApp: (() => Promise<void>) | null = null;
  let closeGraph: (() => Promise<void>) | null = null;

  let adminCookie = '';
  let usMgrCookie = '';
  let usBdr1Cookie = '';
  let usBdr2Cookie = '';

  const graphState: MockGraphState = {
    lastClientState: '',
    throttleNextDelta: false,
    inboxMessages: [],
    sentMessages: [],
    deletedSubscriptions: [],
    renewedSubscriptions: [],
    attachmentDownloads: 0,
  };

  beforeAll(async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'adas-ms5-graph-'));
    const clientSecretFile = path.join(tempDir, 'entra_client_secret.txt');
    writeFileSync(clientSecretFile, 'test_entra_client_secret_value_for_ms5_contract', 'utf8');

    // Start local HTTP server speaking Microsoft OAuth2 v2.0 + Graph v1.0 wire protocol
    const mockGraph = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const pathname = url.pathname;
      const method = req.method ?? 'GET';

      if (method === 'POST' && pathname === `/${TENANT_ID}/oauth2/v2.0/token`) {
        const body = new URLSearchParams(await readBodyText(req));
        const grantType = body.get('grant_type');
        if (grantType === 'authorization_code') {
          expect(body.get('code_verifier')).toBeTruthy();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              access_token: 'graph_access_tok_v1',
              refresh_token: 'graph_refresh_tok_v1',
              expires_in: 3600,
              scope: 'openid profile email offline_access User.Read Mail.Read Mail.Send',
            }),
          );
          return;
        }
        if (grantType === 'refresh_token') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              access_token: 'graph_access_tok_refreshed',
              refresh_token: 'graph_refresh_tok_rotated',
              expires_in: 3600,
              scope: 'openid profile email offline_access User.Read Mail.Read Mail.Send',
            }),
          );
          return;
        }
      }

      if (method === 'GET' && pathname === '/v1.0/me') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'entra_obj_bdr_1',
            mail: 'priya@adasglobuspro.example.com',
            displayName: 'Priya Nair',
          }),
        );
        return;
      }

      if (method === 'POST' && pathname === '/v1.0/subscriptions') {
        const payload = JSON.parse(await readBodyText(req)) as Record<string, unknown>;
        graphState.lastClientState = String(payload['clientState'] ?? '');
        const isSent = String(payload['resource'] ?? '').includes('SentItems');
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: isSent ? 'sub_sent_bdr_1' : 'sub_inbox_bdr_1',
            expirationDateTime: new Date(Date.now() + 12 * 3600_000).toISOString(),
          }),
        );
        return;
      }

      if (method === 'PATCH' && pathname.startsWith('/v1.0/subscriptions/')) {
        const subId = pathname.slice('/v1.0/subscriptions/'.length);
        graphState.renewedSubscriptions.push(subId);
        const payload = JSON.parse(await readBodyText(req)) as Record<string, unknown>;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: subId,
            expirationDateTime: payload['expirationDateTime'],
          }),
        );
        return;
      }

      if (method === 'DELETE' && pathname.startsWith('/v1.0/subscriptions/')) {
        const subId = pathname.slice('/v1.0/subscriptions/'.length);
        graphState.deletedSubscriptions.push(subId);
        res.writeHead(204);
        res.end();
        return;
      }

      if (method === 'GET' && pathname === '/v1.0/me/mailFolders/Inbox/messages/delta') {
        if (graphState.throttleNextDelta) {
          graphState.throttleNextDelta = false;
          res.writeHead(429, {
            'Content-Type': 'application/json',
            'Retry-After': '90',
          });
          res.end(JSON.stringify({ error: { code: 'ApplicationThrottled' } }));
          return;
        }
        const batch = [...graphState.inboxMessages];
        graphState.inboxMessages = [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            value: batch,
            '@odata.deltaLink': `${graphServerUrl}/v1.0/me/mailFolders/Inbox/messages/delta?$deltatoken=tok_inbox_2`,
          }),
        );
        return;
      }

      if (method === 'GET' && pathname === '/v1.0/me/mailFolders/SentItems/messages/delta') {
        const batch = [...graphState.sentMessages];
        graphState.sentMessages = [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            value: batch,
            '@odata.deltaLink': `${graphServerUrl}/v1.0/me/mailFolders/SentItems/messages/delta?$deltatoken=tok_sent_2`,
          }),
        );
        return;
      }

      if (method === 'GET' && pathname === '/v1.0/me/messages/gmsg_sophie_reply/attachments') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            value: [
              {
                id: 'gatt_tax_checklist_pdf',
                name: '2026-Tax-Trial-Scope.pdf',
                contentType: 'application/pdf',
                size: 28,
                isInline: false,
              },
            ],
          }),
        );
        return;
      }

      if (
        method === 'GET' &&
        pathname === '/v1.0/me/messages/gmsg_sophie_reply/attachments/gatt_tax_checklist_pdf/$value'
      ) {
        graphState.attachmentDownloads += 1;
        const pdfBytes = Buffer.from('%PDF-1.7 synthetic checklist', 'utf8');
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Length': String(pdfBytes.byteLength),
        });
        res.end(pdfBytes);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'NotFound', path: pathname } }));
    });

    await new Promise<void>((resolve) => {
      mockGraph.listen(0, '127.0.0.1', () => resolve());
    });
    const gAddr = mockGraph.address() as AddressInfo;
    graphServerUrl = `http://127.0.0.1:${gAddr.port}`;
    closeGraph = () =>
      new Promise<void>((resolve, reject) =>
        mockGraph.close((err) => (err ? reject(err) : resolve())),
      );

    db = DatabaseService.forTests();
    await db.ensureInitialized();
    secretBox = SecretBox.ephemeral();

    const env = validateEnv({
      NODE_ENV: 'test',
      PORT: '3000',
      DATABASE_URL: 'postgresql://adas:adas_dev_password@localhost:5432/adas_crm_test',
      MAIL_LIVE: 'false',
      ENTRA_TENANT_ID: TENANT_ID,
      ENTRA_CLIENT_ID: CLIENT_ID,
      ENTRA_CLIENT_SECRET_FILE: clientSecretFile,
      ENTRA_MAIL_REDIRECT_URI: 'http://localhost:5174/api/v1/inbox/oauth/callback',
      MICROSOFT_AUTHORITY_BASE_URL: graphServerUrl,
      MICROSOFT_GRAPH_BASE_URL: `${graphServerUrl}/v1.0`,
    });

    const app = createAppServer(env, db, { secretBox });
    await new Promise<void>((resolve) => {
      app.server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    closeApp = () =>
      new Promise<void>((resolve, reject) =>
        app.server.close((err) => (err ? reject(err) : resolve())),
      );

    adminCookie = await signIn(baseUrl, 'usr_admin_1');
    usMgrCookie = await signIn(baseUrl, 'usr_mgr_1');
    usBdr1Cookie = await signIn(baseUrl, 'usr_bdr_1');
    usBdr2Cookie = await signIn(baseUrl, 'usr_bdr_2');
  });

  afterAll(async () => {
    if (closeApp) await closeApp();
    if (closeGraph) await closeGraph();
    if (db) await db.close();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('completes PKCE OAuth2 mailbox connect, seals tokens with AES-256-GCM SecretBox, and validates public Graph webhooks on go.', async () => {
    const startRes = await fetch(`${baseUrl}/api/v1/inbox/oauth/start`, {
      headers: { Cookie: usBdr1Cookie },
      redirect: 'manual',
    });
    expect(startRes.status).toBe(302);
    const redirectLocation = startRes.headers.get('location') ?? '';
    expect(redirectLocation).toContain(`/${TENANT_ID}/oauth2/v2.0/authorize`);
    expect(redirectLocation).toContain('code_challenge_method=S256');
    expect(redirectLocation).toContain('Mail.Read');

    const oauthCookie = (startRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    expect(oauthCookie).toContain('adas_mail_oauth=');
    const stateParam = new URL(redirectLocation).searchParams.get('state') ?? '';
    expect(stateParam.length).toBeGreaterThan(10);

    const callbackRes = await fetch(
      `${baseUrl}/api/v1/inbox/oauth/callback?code=auth_code_xyz&state=${encodeURIComponent(stateParam)}`,
      {
        headers: { Cookie: `${usBdr1Cookie}; ${oauthCookie}` },
        redirect: 'manual',
      },
    );
    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.get('location')).toContain('?screen=inbox&mailConnected=1');

    // Verify tokens are encrypted at rest (never stored in plaintext) and clientState is hashed
    const mbxDb = await db.query<{
      encrypted_access_token: string;
      encrypted_refresh_token: string;
      token_key_version: number;
      client_state_sha256: string;
      inbox_subscription_id: string;
    }>(`SELECT * FROM mailbox_connections WHERE user_id = 'usr_bdr_1'`);
    const row = mbxDb.rows[0];
    if (!row) throw new Error('Expected mailbox_connections row');
    expect(row.encrypted_access_token).toMatch(/^v1\.1\./);
    expect(row.encrypted_access_token).not.toContain('graph_access_tok_v1');
    expect(row.encrypted_refresh_token).toMatch(/^v1\.1\./);
    expect(row.encrypted_refresh_token).not.toContain('graph_refresh_tok_v1');
    expect(row.client_state_sha256).not.toBe(graphState.lastClientState);
    expect(row.inbox_subscription_id).toBe('sub_inbox_bdr_1');

    // Audit log is PII-free
    const auditRes = await db.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_logs WHERE action = 'mailbox.connected' AND actor_user_id = 'usr_bdr_1'`,
    );
    expect(auditRes.rows).toHaveLength(1);
    expect(JSON.stringify(auditRes.rows[0]?.metadata)).not.toContain('priya@');

    // Public webhook handshake (`?validationToken=`) on `go.` host
    const valRes = await fetch(
      `${baseUrl}/api/v1/webhooks/microsoft?validationToken=graph_handshake_token_99`,
      {
        method: 'POST',
        headers: { Host: 'go.adasglobuspro.com' },
      },
    );
    expect(valRes.status).toBe(200);
    expect(valRes.headers.get('content-type')).toContain('text/plain');
    expect(await valRes.text()).toBe('graph_handshake_token_99');

    // Webhook notification with wrong clientState is ignored; valid clientState sets sync_pending and deduplicates
    const badHook = await fetch(`${baseUrl}/api/v1/webhooks/microsoft`, {
      method: 'POST',
      headers: { Host: 'go.adasglobuspro.com', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        value: [
          {
            subscriptionId: 'sub_inbox_bdr_1',
            clientState: 'forged_state',
            changeType: 'created',
            resourceData: { id: 'msg_1' },
          },
        ],
      }),
    });
    expect(badHook.status).toBe(202);
    expect(((await badHook.json()) as { accepted: number; ignored: number }).accepted).toBe(0);

    const goodBody = JSON.stringify({
      value: [
        {
          subscriptionId: 'sub_inbox_bdr_1',
          clientState: graphState.lastClientState,
          changeType: 'created',
          resourceData: { id: 'gmsg_sophie_reply' },
        },
      ],
    });
    const goodHook = await fetch(`${baseUrl}/api/v1/webhooks/microsoft`, {
      method: 'POST',
      headers: { Host: 'go.adasglobuspro.com', 'Content-Type': 'application/json' },
      body: goodBody,
    });
    expect(goodHook.status).toBe(202);
    expect(((await goodHook.json()) as { accepted: number }).accepted).toBe(1);

    // Duplicate replay of exact same Graph notification is ignored via inbound_events
    const dupHook = await fetch(`${baseUrl}/api/v1/webhooks/microsoft`, {
      method: 'POST',
      headers: { Host: 'go.adasglobuspro.com', 'Content-Type': 'application/json' },
      body: goodBody,
    });
    expect(((await dupHook.json()) as { accepted: number; ignored: number }).ignored).toBe(1);
  });

  it('enforces the CRM sync rule, sanitises HTML, streams attachments on demand, stops sequences on reply (A11), and processes DSN 5.x.x hard bounces', async () => {
    const contactEmailRes = await db.query<{ primary_email: string }>(
      `SELECT primary_email FROM contacts WHERE id = 'cnt_sophie'`,
    );
    const sophieEmail = contactEmailRes.rows[0]?.primary_email ?? '';
    expect(sophieEmail).toBeTruthy();

    // Enrol cnt_sophie in an active sequence sent by usr_bdr_1 so we can prove reply stops it (A11)
    await db.query(
      `INSERT INTO sequence_enrollments (id, sequence_id, contact_id, email, sender_user_id, current_step_order, status)
       VALUES ('enr_sophie_ms5', 'seq_us_cpa_trial', 'cnt_sophie', $1, 'usr_bdr_1', 1, 'active')
       ON CONFLICT (id) DO NOTHING`,
      [sophieEmail],
    );

    graphState.inboxMessages = [
      // 1. Known CRM contact reply with unsafe HTML + remote pixel + attachment -> MUST SYNC & STOP SEQUENCE
      {
        id: 'gmsg_sophie_reply',
        conversationId: 'conv_sophie_trial',
        internetMessageId: '<reply-sophie-1@sterlingcpa.example.com>',
        subject: 'Re: 3-day UltraTax trial scope',
        bodyPreview: 'Let us review the trial scope PDF on Thursday.',
        body: {
          contentType: 'HTML',
          content:
            '<div><p onclick="evil()">Let us review the trial scope PDF on Thursday.</p><script>alert(1)</script><img src="https://tracker.invalid/pixel.png" alt="tracker"></div>',
        },
        from: { emailAddress: { address: sophieEmail } },
        toRecipients: [{ emailAddress: { address: 'priya@adasglobuspro.example.com' } }],
        ccRecipients: [],
        hasAttachments: true,
        receivedDateTime: new Date().toISOString(),
        internetMessageHeaders: [{ name: 'In-Reply-To', value: '<seq-step-1@adasglobuspro.com>' }],
      },
      // 2. Unknown address at a known non-free-mail CRM company domain (`acmetax.example.com`) -> MUST SYNC (PRD 4.11)
      {
        id: 'gmsg_acme_domain_cfo',
        conversationId: 'conv_acme_cfo',
        internetMessageId: '<cfo-1@acmetax.example.com>',
        subject: 'Additional bookkeeping pod inquiry',
        bodyPreview: 'Can we add a QBO bookkeeper in December?',
        body: { contentType: 'Text', content: 'Can we add a QBO bookkeeper in December?' },
        from: { emailAddress: { address: 'new.director@acmetax.example.com' } },
        toRecipients: [{ emailAddress: { address: 'priya@adasglobuspro.example.com' } }],
        ccRecipients: [],
        hasAttachments: false,
        receivedDateTime: new Date().toISOString(),
      },
      // 3. Internal employee-to-employee message -> MUST BE IGNORED
      {
        id: 'gmsg_internal_only',
        conversationId: 'conv_internal',
        subject: 'Team lunch Friday',
        bodyPreview: 'Lunch at 1pm',
        body: { contentType: 'Text', content: 'Lunch at 1pm' },
        from: { emailAddress: { address: 'arjun@adasglobuspro.example.com' } },
        toRecipients: [{ emailAddress: { address: 'priya@adasglobuspro.example.com' } }],
        ccRecipients: [],
        hasAttachments: false,
        receivedDateTime: new Date().toISOString(),
      },
      // 4. Unknown personal free-mail message -> MUST BE IGNORED
      {
        id: 'gmsg_personal_gmail',
        conversationId: 'conv_gmail',
        subject: 'Weekend plans',
        bodyPreview: 'See you Saturday',
        body: { contentType: 'Text', content: 'See you Saturday' },
        from: { emailAddress: { address: 'personal.friend@gmail.com' } },
        toRecipients: [{ emailAddress: { address: 'priya@adasglobuspro.example.com' } }],
        ccRecipients: [],
        hasAttachments: false,
        receivedDateTime: new Date().toISOString(),
      },
      // 5. DSN 5.1.1 Hard bounce -> MUST INVALIDATE EMAIL & ADD SUPPRESSION
      {
        id: 'gmsg_dsn_bounce',
        conversationId: 'conv_bounce',
        subject: 'Undeliverable: Q1 Tax Staffing',
        bodyPreview: 'Delivery has failed',
        body: {
          contentType: 'Text',
          content:
            'Delivery has failed to these recipients or groups:\nretired.partner@sterlingcpa.example.com\nFinal-Recipient: rfc822;retired.partner@sterlingcpa.example.com\nStatus: 5.1.1',
        },
        from: { emailAddress: { address: 'postmaster@outlook.example.com' } },
        toRecipients: [{ emailAddress: { address: 'priya@adasglobuspro.example.com' } }],
        ccRecipients: [],
        hasAttachments: false,
        receivedDateTime: new Date().toISOString(),
      },
    ];

    const syncRes = await fetch(`${baseUrl}/api/v1/inbox/mailbox/sync`, {
      method: 'POST',
      headers: {
        Cookie: usBdr1Cookie,
        Origin: WEB_ORIGIN,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    expect(syncRes.status).toBe(200);
    const syncJson = (await syncRes.json()) as {
      syncedMessages: number;
      ignoredMessages: number;
      bouncesProcessed: number;
    };
    expect(syncJson.syncedMessages).toBe(2);
    expect(syncJson.ignoredMessages).toBe(2);
    expect(syncJson.bouncesProcessed).toBe(1);

    // Internal and personal Gmail messages are NEVER stored
    const storedIds = await db.query<{ provider_message_id: string }>(
      `SELECT provider_message_id FROM email_messages WHERE provider_message_id LIKE 'gmsg_%'`,
    );
    expect(storedIds.rows.map((r) => r.provider_message_id).sort()).toEqual([
      'gmsg_acme_domain_cfo',
      'gmsg_sophie_reply',
    ]);

    // Sequence enrollment for cnt_sophie is stopped ('replied') and follow-up task exists (A11)
    const enrCheck = await db.query<{ status: string }>(
      `SELECT status FROM sequence_enrollments WHERE id = 'enr_sophie_ms5'`,
    );
    expect(enrCheck.rows[0]?.status).toBe('replied');

    const replyTask = await db.query<{ id: string }>(
      `SELECT id FROM tasks WHERE contact_id = 'cnt_sophie' AND title LIKE 'Reply received%'`,
    );
    expect(replyTask.rows.length).toBeGreaterThanOrEqual(1);

    // Hard bounce added to suppressions
    const bounceSup = await db.query<{ reason: string; lifted_at: string | null }>(
      `SELECT reason, lifted_at FROM suppressions WHERE email = 'retired.partner@sterlingcpa.example.com'`,
    );
    expect(bounceSup.rows[0]).toEqual({ reason: 'hard_bounce', lifted_at: null });

    // Fetch thread detail as usr_bdr_1: verify HTML sanitisation + attachment metadata (zero bytes fetched during sync!)
    expect(graphState.attachmentDownloads).toBe(0);
    const listRes = await fetch(`${baseUrl}/api/v1/inbox/threads?contactId=cnt_sophie`, {
      headers: { Cookie: usBdr1Cookie },
    });
    const listBody = (await listRes.json()) as { items: { id: string }[] };
    expect(listBody.items.length).toBe(1);
    const sophieThreadId = listBody.items[0]?.id ?? '';
    expect(sophieThreadId).toBeTruthy();

    const detailRes = await fetch(`${baseUrl}/api/v1/inbox/threads/${sophieThreadId}`, {
      headers: { Cookie: usBdr1Cookie },
    });
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as {
      messages: {
        id: string;
        bodyHtmlSanitized: string | null;
        hasRemoteImages: boolean;
        attachments: { id: string; filename: string }[];
      }[];
    };
    const msg = detail.messages[0];
    if (!msg) throw new Error('Expected synced message');
    expect(msg.bodyHtmlSanitized).not.toContain('<script');
    expect(msg.bodyHtmlSanitized).not.toContain('onclick');
    expect(msg.bodyHtmlSanitized).toContain('data-remote-url="https://tracker.invalid/pixel.png"');
    expect(msg.hasRemoteImages).toBe(true);
    expect(msg.attachments).toHaveLength(1);
    const firstAtt = msg.attachments[0];
    if (!firstAtt) throw new Error('Expected synced attachment metadata');
    expect(firstAtt.filename).toBe('2026-Tax-Trial-Scope.pdf');

    // Out-of-scope BDR (`usr_bdr_2`, own scope) gets 404 trying to stream usr_bdr_1's attachment
    const forbiddenAtt = await fetch(
      `${baseUrl}/api/v1/inbox/messages/${msg.id}/attachments/${firstAtt.id}`,
      { headers: { Cookie: usBdr2Cookie } },
    );
    expect(forbiddenAtt.status).toBe(404);

    // Owner (`usr_bdr_1`) streams attachment bytes on demand from Graph
    const okAtt = await fetch(
      `${baseUrl}/api/v1/inbox/messages/${msg.id}/attachments/${firstAtt.id}`,
      { headers: { Cookie: usBdr1Cookie } },
    );
    expect(okAtt.status).toBe(200);
    expect(okAtt.headers.get('content-type')).toContain('application/pdf');
    expect(await okAtt.text()).toBe('%PDF-1.7 synthetic checklist');
    expect(graphState.attachmentDownloads).toBe(1);
  });

  it('enforces own/team/all scopes, sends 1:1 email with templates & Idempotency-Key (A10), links deals, creates tasks, honours 429 Retry-After, and pauses sequences on disconnect', async () => {
    // Scope check: usr_bdr_2 (own) sees 0 threads; usr_mgr_1 (team_us) sees 1 (team_ca excluded!); usr_admin_1 (all) sees all 3
    const [bdr2Threads, mgrThreads, adminThreads] = await Promise.all([
      fetch(`${baseUrl}/api/v1/inbox/threads`, { headers: { Cookie: usBdr2Cookie } }),
      fetch(`${baseUrl}/api/v1/inbox/threads`, { headers: { Cookie: usMgrCookie } }),
      fetch(`${baseUrl}/api/v1/inbox/threads`, { headers: { Cookie: adminCookie } }),
    ]);
    expect(((await bdr2Threads.json()) as { items: unknown[] }).items).toHaveLength(0);
    expect(((await mgrThreads.json()) as { items: unknown[] }).items).toHaveLength(1);
    expect(((await adminThreads.json()) as { items: unknown[] }).items).toHaveLength(3);

    // Send 1:1 email to cnt_jane with template variables + Idempotency-Key (A10)
    const sendPayload = {
      toEmail: 'jane.patel@acmetax.example.com',
      subject: 'Trial kickoff for {{company_name}}',
      bodyText: 'Hi {{first_name}}, confirming your Monday kickoff with {{sender_name}}.',
      contactId: 'cnt_jane',
      companyId: 'cmp_acme',
    };
    const send1 = await fetch(`${baseUrl}/api/v1/inbox/send`, {
      method: 'POST',
      headers: {
        Cookie: usMgrCookie,
        Origin: WEB_ORIGIN,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'ms5-send-jane-1',
      },
      body: JSON.stringify(sendPayload),
    });
    expect(send1.status).toBe(201);
    const send1Json = (await send1.json()) as {
      thread: { id: string; subject: string };
      messages: { id: string; bodyText: string }[];
    };
    expect(send1Json.thread.subject).toContain('Acme');
    const latestMsg = send1Json.messages[send1Json.messages.length - 1];
    if (!latestMsg) throw new Error('Expected outbound message');
    expect(latestMsg.bodyText).toContain('Hi Jane');
    expect(latestMsg.bodyText).toContain('Arjun Mehta');

    // Idempotent retry does not create a second message
    const send2 = await fetch(`${baseUrl}/api/v1/inbox/send`, {
      method: 'POST',
      headers: {
        Cookie: usMgrCookie,
        Origin: WEB_ORIGIN,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'ms5-send-jane-1',
      },
      body: JSON.stringify(sendPayload),
    });
    const send2Json = (await send2.json()) as { messages: unknown[] };
    expect(send2Json.messages).toHaveLength(send1Json.messages.length);

    // Appears in unified Contact timeline (A10)
    const tlRes = await fetch(`${baseUrl}/api/v1/timeline?entityType=contact&entityId=cnt_jane`, {
      headers: { Cookie: usMgrCookie },
    });
    const tlJson = (await tlRes.json()) as {
      items: { source: string; title: string; detail: string }[];
    };
    expect(
      tlJson.items.some((i) => i.source === 'email' && i.detail.includes('confirming your Monday')),
    ).toBe(true);

    // Link thread to deal & create task from email
    const patchRes = await fetch(`${baseUrl}/api/v1/inbox/threads/${send1Json.thread.id}`, {
      method: 'PATCH',
      headers: {
        Cookie: usMgrCookie,
        Origin: WEB_ORIGIN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ dealId: 'deal_acme_tax' }),
    });
    expect(patchRes.status).toBe(200);
    expect(((await patchRes.json()) as { dealId: string }).dealId).toBe('deal_acme_tax');

    const taskRes = await fetch(`${baseUrl}/api/v1/inbox/messages/${latestMsg.id}/task`, {
      method: 'POST',
      headers: {
        Cookie: usMgrCookie,
        Origin: WEB_ORIGIN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: 'Prepare kickoff credentials', priority: 'high' }),
    });
    expect(taskRes.status).toBe(201);
    expect(((await taskRes.json()) as { deal_id: string }).deal_id).toBe('deal_acme_tax');

    // Graph 429 Retry-After sets per-mailbox backoff
    graphState.throttleNextDelta = true;
    const throttleRes = await fetch(`${baseUrl}/api/v1/inbox/mailbox/sync`, {
      method: 'POST',
      headers: {
        Cookie: usBdr1Cookie,
        Origin: WEB_ORIGIN,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    expect(throttleRes.status).toBe(200);
    const throttleJson = (await throttleRes.json()) as { throttledUntil: string | null };
    expect(throttleJson.throttledUntil).not.toBeNull();

    // Disconnect mailbox: deletes Graph subscriptions and pauses active sequences for usr_bdr_1
    await db.query(
      `INSERT INTO sequence_enrollments (id, sequence_id, contact_id, email, sender_user_id, current_step_order, status)
       VALUES ('enr_jane_disconnect_test', 'seq_us_cpa_trial', 'cnt_jane', 'jane.patel@acmetax.example.com', 'usr_bdr_1', 1, 'active')
       ON CONFLICT (id) DO NOTHING`,
    );

    const discRes = await fetch(`${baseUrl}/api/v1/inbox/mailbox/disconnect`, {
      method: 'POST',
      headers: {
        Cookie: usBdr1Cookie,
        Origin: WEB_ORIGIN,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    expect(discRes.status).toBe(200);
    const discJson = (await discRes.json()) as { disconnected: boolean; pausedSequences: number };
    expect(discJson.disconnected).toBe(true);
    expect(discJson.pausedSequences).toBe(1);
    expect(graphState.deletedSubscriptions).toEqual(
      expect.arrayContaining(['sub_inbox_bdr_1', 'sub_sent_bdr_1']),
    );
  });
});
